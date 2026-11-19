import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { watchSubagent } from "../../src/runtime/interactive-watch.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { startTimeoutWrapUpWithinDeadline } from "../../src/runtime/timeout-restart.ts";
import { writeSubagentExitSidecar } from "../../src/session/exit-sidecar.ts";
import { assertResumeAllowed } from "../../src/runtime/resume-guards.ts";
import { SUBAGENT_DONE_TOOL_NAME } from "../../src/tools/tool-names.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	afterEach,
	assert,
	createSessionFile,
	createTestDir,
	describe,
	it,
	resetSubagentStateForTest,
	rmSync,
	sleep,
} from "../support/index.ts";
import { toolCall, toolResult } from "../support/result-fixtures.ts";

const dirs: string[] = [];

function setup(entries: object[], overrides: Partial<RunningSubagent> = {}) {
	const root = createTestDir();
	dirs.push(root);
	const sessionFile = createSessionFile(root, entries);
	const store = new ResultStore(join(root, "results"), () => {});
	const reservation = store.reserve();
	const running: RunningSubagent = {
		id: reservation.runId,
		name: "worker",
		task: "Work",
		agent: "scout",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		resultTarget: { store, reservation, parentCwd: root, warnings: [] },
		...overrides,
	} as RunningSubagent;
	return { running, store, reservation, sessionFile };
}

const DONE_CALL = [
	toolCall(SUBAGENT_DONE_TOOL_NAME, { outcome: "done", summary: "All work finished." }, "done-1", "Here is the work."),
	toolResult(SUBAGENT_DONE_TOOL_NAME, "done-1", "ok"),
];

const noopBackground = { cleanupNoSessionSessionFile() {}, terminateBackgroundChildProcess() {} };

async function withTmux<T>(run: () => Promise<T>): Promise<T> {
	const saved = process.env.PI_SUBAGENT_MUX;
	process.env.PI_SUBAGENT_MUX = "tmux";
	try {
		return await run();
	} finally {
		if (saved === undefined) delete process.env.PI_SUBAGENT_MUX;
		else process.env.PI_SUBAGENT_MUX = saved;
	}
}

describe("end outcome order and crash records (T09 fix round 1)", () => {
	afterEach(() => {
		resetSubagentStateForTest();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("keeps a headless stop cancelled when the deadline fires during the delayed exit", async () => {
		const { running, store, reservation, sessionFile } = setup(DONE_CALL, { timeoutBudget: { timeoutSeconds: 1 } });
		const child = new EventEmitter() as ChildProcess;
		running.childProcess = child;
		const ac = new AbortController();
		const watch = watchBackgroundSubagent(running, noopBackground, ac.signal);
		ac.abort();
		await sleep(1300); // the still-armed 1 s deadline fires while the stopped child has not exited
		writeSubagentExitSidecar(sessionFile, { type: "done" });
		child.emit("exit", 0, null);
		const result = await watch;
		assert.equal(result.error, "cancelled");
		assert.equal(result.timedOut, undefined);
		assert.equal(store.read(reservation.runId)?.outcome, "cancelled");
	});

	it("keeps a pane stop cancelled when the deadline fires during the asynchronous close", async () => {
		await withTmux(async () => {
			const { running, store, reservation } = setup(DONE_CALL, {
				mode: "interactive",
				surface: "pi-subagents-nonexistent-surface",
				timeoutBudget: { timeoutSeconds: 1 },
			});
			const ac = new AbortController();
			const result = await watchSubagent(
				running,
				{
					cleanupNoSessionSessionFile() {},
					async closeRunningSurface() {},
					async pollForExit(_surface: string, _signal: AbortSignal, options: { onTick?: () => void }) {
						ac.abort();
						await sleep(1300);
						options.onTick?.();
						throw new Error("Aborted while waiting for subagent to finish");
					},
				} as never,
				ac.signal,
			);
			assert.equal(result.error, "cancelled");
			assert.equal(result.timedOut, undefined);
			assert.equal(store.read(reservation.runId)?.outcome, "cancelled");
		});
	});

	it("keeps a deadline that fired during wrap-up startup timed out after a later parent abort", async () => {
		const { running } = setup([], { timeoutBudget: { timeoutSeconds: 1 }, startTime: Date.now() - 900 });
		const parent = new AbortController();
		const outcome = await startTimeoutWrapUpWithinDeadline(running, parent.signal, {
			async restart() {
				await sleep(200); // the hard deadline fires at about 100 ms
				parent.abort(); // then the parent stops the run
			},
			async stopStarted() {},
		});
		assert.equal(outcome.kind, "timedOut");
	});

	it("still cancels a wrap-up startup that the parent stopped before the deadline", async () => {
		const { running } = setup([], { timeoutBudget: { timeoutSeconds: 1 }, startTime: Date.now() - 800 });
		const parent = new AbortController();
		const outcome = await startTimeoutWrapUpWithinDeadline(running, parent.signal, {
			async restart() {
				parent.abort();
				await sleep(300); // the deadline passes during the stop
			},
			async stopStarted() {},
		});
		assert.equal(outcome.kind, "cancelled");
	});

	it("publishes a capped failed record for a watched crash right after a long tool result", async () => {
		const longOutput = `TOOL-START${"x".repeat(30_000)}TOOL-END`;
		const { running, store, reservation } = setup([
			toolCall("bash", { command: "cat big" }, "bash-1"),
			toolResult("bash", "bash-1", longOutput),
		]);
		const child = new EventEmitter() as ChildProcess;
		running.childProcess = child;
		const watch = watchBackgroundSubagent(running, noopBackground, new AbortController().signal);
		child.emit("exit", 1, null);
		const result = await watch;
		const record = store.read(reservation.runId);
		assert.equal(record?.outcome, "failed");
		assert.ok(result.resultText, "the crash carries the published rendering");
		assert.ok(!result.resultText.includes("TOOL-END"), "the rendering does not carry the uncapped tool output");
		assert.ok(!result.summary.includes("TOOL-END"), "the summary does not carry the uncapped tool output");
	});

	it("publishes a failed record for a nonzero manual pane close without an answer", async () => {
		await withTmux(async () => {
			const { running, store, reservation } = setup([], {
				mode: "interactive",
				surface: "pi-subagents-nonexistent-surface",
				autoExit: false,
			});
			const result = await watchSubagent(
				running,
				{
					cleanupNoSessionSessionFile() {},
					async closeRunningSurface() {},
					async pollForExit() {
						return { reason: "sentinel", exitCode: 1 };
					},
				} as never,
				new AbortController().signal,
			);
			assert.equal(store.read(reservation.runId)?.outcome, "failed");
			assert.ok(result.resultText);
		});
	});

	it("records the resume verdict the guard applies: finished wrap-up resumable, hard kill not", async () => {
		// Finished report-only continuation, on-timeout: block-resume.
		const wrap = setup(DONE_CALL, {
			timeoutBlocksResume: true,
			timeoutWrapUp: { kind: "timeout", seconds: 100, threshold: 80 },
			timeoutWrapUpMode: true,
		});
		const wrapChild = new EventEmitter() as ChildProcess;
		wrap.running.childProcess = wrapChild;
		const wrapWatch = watchBackgroundSubagent(wrap.running, noopBackground, new AbortController().signal);
		writeSubagentExitSidecar(wrap.sessionFile, { type: "done" });
		wrapChild.emit("exit", 0, null);
		await wrapWatch;
		const wrapRecord = wrap.store.read(wrap.reservation.runId)!;
		const wrapGuardAllows = guardAllows(wrap.sessionFile);
		assert.equal(wrapRecord.outcome, "timed_out");
		assert.equal(wrapRecord.resume.resumable, wrapGuardAllows, "record and guard agree for a finished wrap-up");
		assert.equal(wrapGuardAllows, true);

		// Hard kill, on-timeout: block-resume.
		const kill = setup([], { timeoutBlocksResume: true, timeoutBudget: { timeoutSeconds: 1 } });
		const killChild = new EventEmitter() as ChildProcess;
		kill.running.childProcess = killChild;
		const killWatch = watchBackgroundSubagent(
			kill.running,
			{
				cleanupNoSessionSessionFile() {},
				terminateBackgroundChildProcess: () => void killChild.emit("exit", null, "SIGTERM"),
			},
			new AbortController().signal,
		);
		await killWatch;
		const killRecord = kill.store.read(kill.reservation.runId)!;
		const killGuardAllows = guardAllows(kill.sessionFile);
		assert.equal(killRecord.outcome, "timed_out");
		assert.equal(killRecord.resume.resumable, killGuardAllows, "record and guard agree for a hard kill");
		assert.equal(killGuardAllows, false);
	});
});

function guardAllows(sessionFile: string): boolean {
	try {
		assertResumeAllowed(sessionFile);
		return true;
	} catch {
		return false;
	}
}
