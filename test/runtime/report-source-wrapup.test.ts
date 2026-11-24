import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { assembleResult } from "../../src/runtime/result-assembler.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { publishRunResult, type WatchedEnd } from "../../src/runtime/run-result.ts";
import { resultTextOf } from "../../src/runtime/unpublished-result.ts";
import { selectUntypedReport } from "../../src/runtime/untyped-report.ts";
import type { SessionEntry } from "../../src/session/session.ts";
import { CALLER_PING_TOOL_NAME, SUBAGENT_DONE_TOOL_NAME } from "../../src/tools/tool-names.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { afterEach, assert, createSessionFile, createTestDir, describe, it, rmSync } from "../support/index.ts";
import { assistant, facts, syntheticReport, toolCall, toolResult, user } from "../support/result-fixtures.ts";

/** The documented heading of a recovered unsaved report (README, spec D13). */
const UNSAVED_REPORT_HEADING = "Full report (not saved to a file):";

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
		phase: { kind: "running" },
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
	it("keeps the only tool output of a run that ends with a zero-argument subagent_done", () => {
		// cf6dbf4 findLastSubagentOutputWithSource skips the subagent_done result and reports the bash result.
		const entries = [
			user("Run the check."),
			toolCall("bash", { command: "check" }, "c1"),
			toolResult("bash", "c1", "check passed: 12 of 12"),
			toolCall(SUBAGENT_DONE_TOOL_NAME, {}, "d1"),
			toolResult(SUBAGENT_DONE_TOOL_NAME, "d1", "ok"),
		];
		const { record, report } = assembleResult(facts(entries, { acceptedCall: { toolCallId: "d1", args: {} } }));
		assert.equal(record.typed, false);
		assert.equal(record.outcome, "done");
		assert.equal(report, "check passed: 12 of 12");
	});

	it("keeps the text of the subagent_done message as the report", () => {
		const entries = [
			user("Run the check."),
			toolCall("bash", { command: "check" }, "c1"),
			toolResult("bash", "c1", "raw output"),
			toolCall(SUBAGENT_DONE_TOOL_NAME, {}, "d1", "Final report."),
			toolResult(SUBAGENT_DONE_TOOL_NAME, "d1", "ok"),
		];
		assert.equal(assembleResult(facts(entries)).report, "Final report.");
	});

	it("selects stdout on any end when the child kept no transcript (T73 in-memory)", () => {
		const failed = { kind: "failed" as const, error: "exited with code 2", code: 2 };
		assert.deepEqual(selectUntypedReport(undefined, failed, { stdout: "answer\n", stderr: "err" }), {
			text: "answer",
			end: failed,
		});
		assert.deepEqual(selectUntypedReport(undefined, failed, { stderr: "err" }), { diagnostic: "err", end: failed });
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

	it("puts headless stderr into the runtime-owned summary of a failed exit", () => {
		const { record, report, summarySource } = assembleResult(
			facts([user("Go.")], {
				end: { kind: "failed", error: "exited with code 2", code: 2 },
				processOutput: { stderr: "fatal: no such file" },
			}),
		);
		assert.equal(record.outcome, "failed");
		assert.ok(report.endsWith("fatal: no such file"));
		assert.ok(record.summary.endsWith("fatal: no such file"), "cf6dbf4: stderr is in the summary");
		assert.equal(summarySource, "runtime");
	});
});

describe("D12 report storage failure", () => {
	it("delivers the whole untyped answer, and the stored rendering is that delivered copy", async () => {
		const long = syntheticReport(6000);
		const root = createTestDir();
		dirs.push(root);
		const blocked = join(root, "not-a-folder");
		writeFileSync(blocked, "a file where the results folder should be");
		const { running, store, reservation } = setup([user("Go."), assistant(long)], {}, blocked);
		const published = publishRunResult(running, watchedEnd());
		assert.equal(published?.record.report.saved, false);
		const delivered = published?.text ?? "";
		assert.ok(delivered.includes(`\n${long}\n`), "the delivered copy holds the whole answer");
		assert.ok(!delivered.includes(UNSAVED_REPORT_HEADING));
		const record = store.read(reservation.runId);
		assert.ok(record);
		assert.equal(store.storedRendering(record), delivered, "a replayed copy is the delivered one");
	});
});

describe("D21 completed wrap-up", () => {
	const wrapUp = {
		phase: {
			kind: "wrapping-up" as const,
			wrapUp: { wrapUp: { kind: "timeout" as const, seconds: 100, threshold: 80 }, deadlineAt: 0 },
		},
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

	it("shows the same outcome for a finished wrap-up without a published record", () => {
		const text = resultTextOf({
			name: "worker",
			agent: "scout",
			task: "Work",
			summary: "Final report: two of three steps done.",
			summarySource: "subagent",
			exitCode: 0,
			elapsed: 5,
			timeoutWrapUp: { kind: "timeout", seconds: 100, threshold: 80 },
		});
		assert.match(text, /^worker · scout · done · /);
		assert.ok(text.includes("wrap-up: 100s for the whole run"));
	});

	for (const [label, end, expected] of [
		["a nonzero exit", { exitCode: 3 }, { code: 3, error: "exited with code 3" }],
		[
			"a child error",
			{ exitCode: 0, errorMessage: "provider quota exhausted" },
			{ code: 0, error: "provider quota exhausted" },
		],
	] as const) {
		it(`fails a wrap-up after ${label} and keeps its time limit and ender`, () => {
			const { running } = setup([user("Report now.")], wrapUp);
			const published = publishRunResult(running, watchedEnd(end));
			assert.equal(published?.record.outcome, "failed");
			assert.equal(published?.record.exit.code, expected.code);
			assert.equal(published?.record.exit.error, expected.error);
			assert.equal(published?.record.endedBy, "time_limit");
			assert.deepEqual(published?.record.timeLimit, { kind: "timeout", seconds: 100, wrapUp: true });
			assert.ok(published?.text.includes("wrap-up: 100s for the whole run"));
		});
	}

	it("fails a wrap-up whose final turn is an empty terminal stop and keeps its time limit", () => {
		const { running } = setup([user("Report now."), emptyStop("length")], wrapUp);
		const published = publishRunResult(running, watchedEnd());
		assert.equal(published?.record.outcome, "failed");
		assert.equal(published?.record.endedBy, "time_limit");
		assert.deepEqual(published?.record.timeLimit, { kind: "timeout", seconds: 100, wrapUp: true });
	});

	it("does not inherit the verdict of a ping recorded before the restart", () => {
		// A taken-over pane records caller_ping without an exit record; the soft limit restarts it.
		const message = "Need the API key location.";
		const { running } = setup(
			[
				user("Work."),
				toolCall(CALLER_PING_TOOL_NAME, { message }, "p1"),
				toolResult(CALLER_PING_TOOL_NAME, "p1", "ok"),
			],
			wrapUp,
		);
		const published = publishRunResult(running, watchedEnd({ exitCode: 1 }));
		assert.equal(published?.record.typed, false);
		assert.equal(published?.record.outcome, "failed");
		assert.deepEqual(published?.record.timeLimit, { kind: "timeout", seconds: 100, wrapUp: true });
	});

	it("keeps a finished wrap-up untyped even after an earlier completion call", () => {
		const { running } = setup(
			[
				user("Work."),
				toolCall(SUBAGENT_DONE_TOOL_NAME, { outcome: "done", summary: "Old." }, "d1", "Old report."),
				toolResult(SUBAGENT_DONE_TOOL_NAME, "d1", "ok"),
				user("Report now."),
				assistant("Wrap-up report."),
			],
			wrapUp,
		);
		const published = publishRunResult(running, watchedEnd());
		assert.equal(published?.record.typed, false);
		assert.equal(published?.record.outcome, "done");
		assert.equal(published?.record.summary, "Wrap-up report.");
	});

	it("keeps the time limit of an unpublished wrap-up that failed", () => {
		const text = resultTextOf({
			name: "worker",
			agent: "scout",
			task: "Work",
			summary: "",
			summarySource: "runtime",
			exitCode: 3,
			elapsed: 5,
			timeoutWrapUp: { kind: "timeout", seconds: 100, threshold: 80 },
		});
		assert.match(text, /^worker · scout · failed · .* · ended by time limit/);
		assert.ok(text.includes("wrap-up: 100s for the whole run"));
	});

	it("fails an unpublished clean exit whose summary is an empty terminal stop (cf6dbf4 state.ts)", () => {
		const text = resultTextOf({
			name: "worker",
			agent: "scout",
			task: "Work",
			summary: "Subagent stopped before producing a result (stopReason: length)",
			summarySource: "runtime",
			exitCode: 0,
			elapsed: 5,
		});
		assert.match(text, /^worker · scout · failed · /);
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
		const watch = watchBackgroundSubagent(
			running,
			{ cleanupNoSessionSessionFile() {}, terminateBackgroundChildProcess() {} },
			ac.signal,
		);
		try {
			ac.abort();
			assert.equal(escalations.length, 1, "one escalation timer per stop");
			assert.equal(escalations[0].hasRef(), true, "an unreferenced timer may never fire");
		} finally {
			globalThis.setTimeout = original;
			for (const timer of escalations) clearTimeout(timer);
			// Settle the watcher also on a failed assertion: a pending watcher keeps node --test alive.
			child.emit("exit", null, "SIGTERM");
			await watch;
		}
	});
});
