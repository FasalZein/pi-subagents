import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { consumeSubagentExitSignal } from "../../src/mux.ts";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { type InteractiveWatchRuntime, watchSubagent } from "../../src/runtime/interactive-watch.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { writeSubagentExitSidecar } from "../../src/session/exit-sidecar.ts";
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
import { assistant, toolCall, toolResult } from "../support/result-fixtures.ts";

/**
 * D7 chart rule, replayed at the soft interruption: the watcher has already asked the child to stop
 * for its report-only wrap-up when the child's completion call is accepted, before the hard deadline.
 * That completion is the run's end: no wrap-up restart, no timed-out record.
 */

const dirs: string[] = [];
const SUMMARY = "All work finished before the deadline.";
const DONE_ARGS = { outcome: "done", summary: SUMMARY };

function setup(overrides: Partial<RunningSubagent>) {
	const root = createTestDir();
	dirs.push(root);
	const sessionFile = createSessionFile(root, [{ type: "session", id: "sess", version: 3 }, assistant("Working.")]);
	const store = new ResultStore(join(root, "results"), () => {});
	const reservation = store.reserve();
	const running: RunningSubagent = {
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
		// Soft limit at 1 s, hard deadline at 2 s.
		timeoutBudget: { timeoutSeconds: 2 },
		timeoutWarnThreshold: 50,
		resultTarget: { store, reservation, parentCwd: root, warnings: [] },
		...overrides,
	};
	return { running, store, runId: reservation.runId, sessionFile };
}

/** What the completion tool does when it accepts the call: the transcript entries, then the exit record. */
function acceptCompletion(sessionFile: string): void {
	for (const entry of [
		toolCall(SUBAGENT_DONE_TOOL_NAME, DONE_ARGS, "done-1", "Here is the work."),
		toolResult(SUBAGENT_DONE_TOOL_NAME, "done-1", "ok"),
	]) {
		appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
	}
	writeSubagentExitSidecar(sessionFile, {
		type: "done",
		outputTokens: 7,
		acceptedCall: { toolCallId: "done-1", args: DONE_ARGS },
	});
}

function settleWithin<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`watcher did not settle within ${ms}ms: ${label}`)), ms);
			timer.unref?.();
		}),
	]);
}

describe("a completion accepted during the soft interruption (D7)", () => {
	afterEach(() => {
		resetSubagentStateForTest();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("background: the completion written before the child handles SIGTERM ends the run", async () => {
		const child = new EventEmitter() as ChildProcess;
		const { running, store, runId, sessionFile } = setup({ childProcess: child });
		let restarts = 0;
		const result = await settleWithin(
			watchBackgroundSubagent(
				running,
				{
					cleanupNoSessionSessionFile() {},
					async restartForTimeoutWrapUp() {
						restarts += 1;
						throw new Error("the wrap-up must not start");
					},
					terminateBackgroundChildProcess(_running, signal) {
						if (signal !== "SIGTERM") return;
						// The call was accepted just before the interruption reached the child.
						acceptCompletion(sessionFile);
						child.emit("exit", 0);
					},
				},
				new AbortController().signal,
			),
			4000,
			"background soft interruption",
		);

		assert.equal(restarts, 0, "no wrap-up restart");
		assert.equal(result.timedOut, undefined);
		assert.equal(result.timeoutWrapUp, undefined);
		const record = store.read(runId);
		assert.equal(record?.outcome, "done");
		assert.equal(record?.typed, true);
		assert.equal(record?.summary, SUMMARY);
	});

	it("background: a completion consumed while descendants exit still wins at the hard deadline", async () => {
		const child = new EventEmitter() as ChildProcess;
		Object.defineProperty(child, "pid", { value: 42 });
		const { running, store, runId, sessionFile } = setup({ childProcess: child });
		const groupGoneAt = Date.now() + 2500; // after the 2 s hard deadline
		let restarts = 0;
		const result = await settleWithin(
			watchBackgroundSubagent(
				running,
				{
					cleanupNoSessionSessionFile() {},
					async restartForTimeoutWrapUp() {
						restarts += 1;
						throw new Error("the wrap-up must not start");
					},
					terminateBackgroundChildProcess(_running, signal) {
						if (signal !== "SIGTERM" || restarts > 0) return;
						if (running.timeoutExpiry) return;
						acceptCompletion(sessionFile);
						// The leader exits; a descendant keeps the group alive past the hard deadline.
						child.emit("exit", 0);
					},
				},
				new AbortController().signal,
				{
					timeoutKillEscalationMs: 10_000,
					processProbe: {
						platform: "linux",
						kill() {
							if (Date.now() < groupGoneAt) return true;
							throw Object.assign(new Error("gone"), { code: "ESRCH" });
						},
					},
				},
			),
			5000,
			"background group exit after the hard deadline",
		);

		assert.equal(restarts, 0, "no wrap-up restart");
		assert.equal(result.timedOut, undefined, "the completion came before the hard deadline");
		const record = store.read(runId);
		assert.equal(record?.outcome, "done");
		assert.equal(record?.typed, true);
	});

	it("pane: the completion accepted before the asynchronous close ends the run", async () => {
		const saved = process.env.PI_SUBAGENT_MUX;
		process.env.PI_SUBAGENT_MUX = "tmux";
		try {
			const { running, store, runId, sessionFile } = setup({ mode: "interactive", surface: "pane-1" });
			let restarts = 0;
			let closeRequested = false;
			const runtime: InteractiveWatchRuntime = {
				cleanupNoSessionSessionFile() {},
				async closeRunningSurface() {
					closeRequested = true;
				},
				async restartForTimeoutWrapUp() {
					restarts += 1;
					throw new Error("the wrap-up must not start");
				},
				async pollForExit(_surface, _signal, options) {
					while (!closeRequested) {
						options?.onTick?.(0);
						await sleep(50);
					}
					// The close has not taken effect yet: the child's call is accepted and Pi exits.
					acceptCompletion(sessionFile);
					const end = consumeSubagentExitSignal(sessionFile);
					if (!end) throw new Error("the accepted exit record is missing");
					return end;
				},
			};
			const result = await settleWithin(
				watchSubagent(running, runtime, new AbortController().signal),
				4000,
				"pane soft interruption",
			);

			assert.equal(restarts, 0, "no wrap-up restart");
			assert.equal(result.timedOut, undefined);
			assert.equal(result.timeoutWrapUp, undefined);
			const record = store.read(runId);
			assert.equal(record?.outcome, "done");
			assert.equal(record?.typed, true);
			assert.equal(record?.summary, SUMMARY);
		} finally {
			if (saved === undefined) delete process.env.PI_SUBAGENT_MUX;
			else process.env.PI_SUBAGENT_MUX = saved;
		}
	});
});
