import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { assembleResult } from "../../src/runtime/result-assembler.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { publishRunResult, UNSAVED_REPORT_HEADING, type WatchedEnd } from "../../src/runtime/run-result.ts";
import type { SessionEntry } from "../../src/session/session.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { afterEach, assert, createSessionFile, createTestDir, describe, it, rmSync } from "../support/index.ts";
import { assistant, facts, syntheticReport, toolCall, toolResult, user } from "../support/result-fixtures.ts";

/**
 * T77 (D12, D21): report source, storage failure and wrap-up outcome. Every expected value is the
 * cf6dbf4 behaviour: session.ts findLastSubagentOutputWithSource and getTerminalStopMessage, state.ts
 * getSubagentCompletionStatus, result-router.ts full delivery, background-watch.ts onAbort.
 */

/** An assistant turn that ended with a terminal stop reason and no text (cf6dbf4 getTerminalStopMessage). */
function emptyStop(stopReason: string): SessionEntry {
	return { type: "message", id: `stop-${stopReason}`, message: { role: "assistant", content: [], stopReason } };
}

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(entries: object[], overrides: Partial<RunningSubagent> = {}, resultsDir?: string) {
	const root = createTestDir();
	dirs.push(root);
	const sessionFile = createSessionFile(root, entries);
	const store = new ResultStore(resultsDir ?? join(root, "results"), () => {});
	const reservation = store.reserve();
	const running = {
		id: reservation.runId,
		name: "worker",
		task: "Work",
		agent: "scout",
		mode: "background",
		phase: "running",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		resultTarget: { store, reservation, parentCwd: root, warnings: [] },
		...overrides,
	} as RunningSubagent;
	return { running, store, reservation, root };
}

function watchedEnd(overrides: Partial<WatchedEnd> = {}): WatchedEnd {
	return {
		exitCode: 0,
		operatorClosed: false,
		closedByPerson: false,
		stopped: false,
		exitSignal: null,
		contextUsage: {},
		...overrides,
	};
}

describe("D12 untyped report source (cf6dbf4)", () => {
	it("uses a terminating tool's result when it is the only final output", () => {
		const entries = [
			user("Run the check."),
			assistant("Starting the check now."),
			toolCall("bash", { command: "check" }, "c1"),
			toolResult("bash", "c1", "check passed: 12 of 12"),
		];
		const { record, report } = assembleResult(facts(entries));
		assert.equal(record.outcome, "done");
		assert.equal(report, "check passed: 12 of 12");
		assert.equal(record.summary, "check passed: 12 of 12");
	});

	it("fails a clean exit whose final turn is an empty terminal stop", () => {
		const entries = [user("Do it."), assistant("Earlier progress note."), emptyStop("length")];
		const { record } = assembleResult(facts(entries));
		assert.equal(record.outcome, "failed");
		assert.equal(record.exit.code, 0);
		assert.equal(record.exit.error, "Subagent stopped before producing a result (stopReason: length)");
		assert.ok(!record.summary.includes("Earlier progress note."), "no stale earlier text");
	});

	it("reads only the current run: an empty current run does not reuse an earlier turn", () => {
		const entries = [assistant("Answer of the earlier run."), user("Continue.")];
		const { record } = assembleResult(facts(entries, { launchEntryCount: 1 }));
		assert.ok(!record.summary.includes("earlier run"));
	});

	it("uses headless stdout when the session has no final answer", () => {
		const { report } = assembleResult(facts([user("Go.")], { processOutput: { stdout: "stdout answer\n" } }));
		assert.equal(report, "stdout answer");
	});

	it("keeps headless stderr in the report of a failed exit", () => {
		const { record, report } = assembleResult(
			facts([user("Go.")], {
				end: { kind: "failed", error: "exited with code 2", code: 2 },
				processOutput: { stderr: "fatal: no such file" },
			}),
		);
		assert.equal(record.outcome, "failed");
		assert.ok(report.endsWith("fatal: no such file"));
	});
});

describe("D12 report storage failure", () => {
	it("delivers the full long report when the report cannot be saved", () => {
		const long = syntheticReport(6000);
		const root = createTestDir();
		dirs.push(root);
		const blocked = join(root, "not-a-folder");
		writeFileSync(blocked, "a file where the results folder should be");
		const { running, store, reservation } = setup([user("Go."), assistant(long)], {}, blocked);
		const published = publishRunResult(running, watchedEnd());
		assert.equal(published?.record.report.saved, false);
		assert.ok(published?.text.includes(`${UNSAVED_REPORT_HEADING}\n${long}`), "the full report is readable");
		const record = store.read(reservation.runId);
		assert.ok(record && store.storedRendering(record)?.includes(long), "the in-memory lookup keeps the full text");
	});
});

describe("D21 completed wrap-up", () => {
	const wrapUp = {
		timeoutWrapUp: { kind: "timeout" as const, seconds: 100, threshold: 80 },
		phase: "wrapping-up" as const,
	};

	it("shows the report outcome and names the time limit", () => {
		const { running } = setup([user("Report now."), assistant("Final report: two of three steps done.")], wrapUp);
		const published = publishRunResult(running, watchedEnd());
		assert.equal(published?.record.outcome, "done");
		assert.equal(published?.record.endedBy, "time_limit");
		assert.deepEqual(published?.record.timeLimit, { kind: "timeout", seconds: 100, wrapUp: true });
		const text = published?.text ?? "";
		assert.match(text, /^worker · scout · done · /);
		assert.ok(text.includes("wrap-up: 100s for the whole run"));
		assert.ok(!text.includes("timed out"));
	});

	it("fails a wrap-up that exits nonzero without a child error", () => {
		const { running } = setup([user("Report now.")], wrapUp);
		const published = publishRunResult(running, watchedEnd({ exitCode: 3 }));
		assert.equal(published?.record.outcome, "failed");
		assert.equal(published?.record.exit.code, 3);
	});
});

describe("D21 terminate reaper", () => {
	it("keeps the SIGKILL escalation timer of a stop referenced", async () => {
		const { running } = setup([], { resultTarget: undefined });
		const child = new EventEmitter() as ChildProcess; // no pid: no real process is signalled
		running.childProcess = child;
		const ac = new AbortController();
		const original = globalThis.setTimeout;
		const escalations: NodeJS.Timeout[] = [];
		globalThis.setTimeout = ((fn: () => void, ms?: number) => {
			const timer = original(fn, ms);
			if (ms === 5000) escalations.push(timer);
			return timer;
		}) as typeof setTimeout;
		try {
			const watch = watchBackgroundSubagent(
				running,
				{ cleanupNoSessionSessionFile() {}, terminateBackgroundChildProcess() {} },
				ac.signal,
			);
			ac.abort();
			assert.equal(escalations.length, 1, "one escalation timer per stop");
			assert.equal(escalations[0].hasRef(), true, "an unreferenced timer may never fire");
			child.emit("exit", null, "SIGTERM");
			await watch;
		} finally {
			globalThis.setTimeout = original;
			for (const timer of escalations) clearTimeout(timer);
		}
	});
});
