import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupNoSessionSessionFile } from "../../src/launch/prep.ts";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { watchSubagent } from "../../src/runtime/interactive-watch.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import type { RunId } from "../../src/runtime/result-record.ts";
import { NO_SESSION_RESUME_REASON } from "../../src/runtime/run-result.ts";
import { shutdownSubagentsForParentExit } from "../../src/runtime/shutdown.ts";
import { writeSubagentExitSidecar } from "../../src/session/exit-sidecar.ts";
import type { ParentClosePolicy, RunningSubagent, SubagentResult } from "../../src/types.ts";
import {
	afterEach,
	assert,
	beforeEach,
	createSessionFile,
	createTestDir,
	describe,
	it,
	rmSync,
} from "../support/index.ts";
import { assistantText, END_MARKER, LONG_ANSWER, messageText, START_MARKER } from "../support/result-delivery.ts";

const dirs: string[] = [];
let savedMux: string | undefined;

function makeNoSessionRun(
	mode: "background" | "interactive",
	parentClosePolicy: ParentClosePolicy,
	entries: object[],
): { running: RunningSubagent; store: ResultStore; runId: RunId } {
	const root = createTestDir();
	dirs.push(root);
	const sessionFile = createSessionFile(root, entries);
	const store = new ResultStore(join(root, "results"), () => {});
	const reservation = store.reserve();
	const running: RunningSubagent = {
		id: reservation.runId,
		name: "No-session report",
		task: "Answer at length",
		agent: "scout",
		mode,
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy,
		async: true,
		noSession: true,
		startTime: Date.now(),
		sessionFile,
		...(mode === "background"
			? { childProcess: new EventEmitter() as ChildProcess }
			: { surface: "pi-subagents-nonexistent-surface" }),
		resultTarget: { store, reservation, parentCwd: root, warnings: [] },
	};
	return { running, store, runId: reservation.runId };
}

async function finishNoSessionRun(running: RunningSubagent): Promise<SubagentResult> {
	writeSubagentExitSidecar(running.sessionFile, { type: "done" });
	if (running.mode === "background") {
		const promise = watchBackgroundSubagent(
			running,
			{ cleanupNoSessionSessionFile, terminateBackgroundChildProcess() {} },
			new AbortController().signal,
		);
		running.childProcess!.emit("exit", 0);
		return promise;
	}
	return watchSubagent(
		running,
		{
			cleanupNoSessionSessionFile,
			async closeRunningSurface() {},
			async pollForExit() {
				return { reason: "sentinel", exitCode: 0 };
			},
		} as never,
		new AbortController().signal,
	);
}

/** D13 (T08b): a no-session child keeps its report through its private temporary session file. */
describe("no-session child results", () => {
	beforeEach(() => {
		savedMux = process.env.PI_SUBAGENT_MUX;
		// The pane watcher's file-polling branch: tmux has no direct-program exit check.
		process.env.PI_SUBAGENT_MUX = "tmux";
	});

	afterEach(() => {
		if (savedMux === undefined) delete process.env.PI_SUBAGENT_MUX;
		else process.env.PI_SUBAGENT_MUX = savedMux;
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	for (const mode of ["background", "interactive"] as const) {
		for (const policy of ["terminate", "continue"] as const) {
			it(`${mode} / ${policy}: keeps both markers in the report and deletes the temporary session file after publication`, async () => {
				const { running, store, runId } = makeNoSessionRun(mode, policy, [assistantText(LONG_ANSWER)]);
				const result = await finishNoSessionRun(running);

				assert.ok(result.reportFile, "the result names its report file");
				const report = readFileSync(result.reportFile, "utf8");
				assert.ok(report.includes(START_MARKER) && report.includes(END_MARKER), "the report keeps both markers");
				assert.equal(existsSync(running.sessionFile), false, "the temporary session file is gone");
				assert.equal(result.sessionFile, undefined, "the result names no deleted session file");

				const record = store.read(runId);
				assert.ok(record, "the record is published");
				assert.equal(record.sessionFile, undefined);
				assert.deepEqual(record.resume, { resumable: false, reason: NO_SESSION_RESUME_REASON });
				assert.match(messageText(result, running), /not resumable: a no-session run keeps no session/);
			});
		}
	}

	it("an orderly detach deletes a running continue child's temporary session file and publishes no result", async () => {
		const { running, store, runId } = makeNoSessionRun("background", "continue", [assistantText(LONG_ANSWER)]);
		const runningSubagents = new Map([[running.id, running]]);
		const actions = await shutdownSubagentsForParentExit({
			runningSubagents,
			completedSubagentResults: new Map(),
			parentCloseEscalationMs: 10,
			updateWidget() {},
			async closeRunningSurface() {},
			cleanupNoSessionSessionFile,
		});
		assert.deepEqual(actions, [{ id: running.id, policy: "continue", action: "continue" }]);
		assert.equal(existsSync(running.sessionFile), false, "the temporary session file is gone at detach");

		// The child keeps running after the detach, writes the file again and ends later: its watcher publishes nothing.
		appendFileSync(running.sessionFile, `${JSON.stringify(assistantText(LONG_ANSWER))}\n`);
		const result = await finishNoSessionRun(running);
		assert.equal(result.resultText, undefined, "no result is published for a detached child");
		assert.equal(result.reportFile, undefined);
		assert.equal(store.read(runId), undefined);
		assert.equal(existsSync(running.sessionFile), false);
	});

	it("leaves a terminate child's temporary session file to its watcher at detach", async () => {
		const { running } = makeNoSessionRun("background", "terminate", [assistantText(LONG_ANSWER)]);
		running.abortController = new AbortController();
		await shutdownSubagentsForParentExit({
			runningSubagents: new Map([[running.id, running]]),
			completedSubagentResults: new Map(),
			parentCloseEscalationMs: 10,
			updateWidget() {},
			async closeRunningSurface() {},
			cleanupNoSessionSessionFile,
		});
		assert.equal(running.abortController.signal.aborted, true);
		assert.ok(running.resultTarget, "a terminate child keeps its result target");
	});

	it("a strict time-limit wrap-up sees a marker that the no-session child wrote before the interrupt", async () => {
		const MARKER = "PRE-INTERRUPT-MARKER-7f3a";
		const { running } = makeNoSessionRun("background", "terminate", [assistantText(`working: ${MARKER}`)]);
		running.timeoutBudget = { timeoutSeconds: 2 };
		running.timeoutWarnThreshold = 50;
		const firstChild = running.childProcess!;
		const wrapUpChild = new EventEmitter() as ChildProcess;
		let transcriptAtRestart = "";
		const result = await watchBackgroundSubagent(
			running,
			{
				cleanupNoSessionSessionFile,
				terminateBackgroundChildProcess(_current, signal) {
					if (signal === "SIGTERM") firstChild.emit("exit", 143);
				},
				async restartForTimeoutWrapUp(current) {
					transcriptAtRestart = existsSync(current.sessionFile) ? readFileSync(current.sessionFile, "utf8") : "";
					current.childProcess = wrapUpChild;
					appendFileSync(current.sessionFile, `${JSON.stringify(assistantText("wrap-up report"))}\n`);
					writeSubagentExitSidecar(current.sessionFile, { type: "done" });
					setTimeout(() => wrapUpChild.emit("exit", 0), 50);
				},
			},
			new AbortController().signal,
		);
		assert.ok(transcriptAtRestart.includes(MARKER), "the restart reads the interrupted transcript");
		assert.match(result.summary, /wrap-up report/);
		assert.equal(existsSync(running.sessionFile), false, "the temporary session file is gone after the run");
	});
});
