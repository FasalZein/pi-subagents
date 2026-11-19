import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { watchSubagent } from "../../src/runtime/interactive-watch.ts";
import { routeSubagentOutcome } from "../../src/runtime/result-router.ts";
import { stopRunningSubagent, wireSubagentSteerBack } from "../../src/runtime/running-registry.ts";
import { closeParentDelivery } from "../../src/runtime/delivery-queue.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildCompletedSubagentResult, resetRuntimeStateForTest } from "../../src/runtime/state.ts";
import { writeSubagentExitSidecar } from "../../src/session/exit-sidecar.ts";
import type { RunningSubagent, RunPhase } from "../../src/types.ts";
import {
	afterEach,
	assert,
	beforeEach,
	createSessionFile,
	createTestDir,
	describe,
	it,
	rmSync,
	sleep,
} from "../support/index.ts";

/**
 * D5 and D7: the run's one phase field through the real watchers, with a fake child. The chart
 * rule "a completion before the hard deadline never becomes timed out" is asserted on the
 * watcher's result and on the completion status the parent files.
 */

const dirs: string[] = [];
let savedMux: string | undefined;

function makeSession(): string {
	const dir = createTestDir();
	dirs.push(dir);
	return createSessionFile(dir, [{ type: "session", id: "sess", version: 3 }]);
}

function appendAssistantEntry(sessionFile: string, id: string, text: string): void {
	appendFileSync(
		sessionFile,
		`${JSON.stringify({ type: "message", id, message: { role: "assistant", content: [{ type: "text", text }] } })}\n`,
	);
}

function makeRunning(sessionFile: string, overrides: Partial<RunningSubagent>): RunningSubagent {
	return {
		id: "phase-child",
		name: "phase-child",
		task: "Finish the sweep",
		mode: "background",
		phase: "running",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		...overrides,
	};
}

/** Records every phase the run is set to, in order, without changing what the code reads. */
function tracePhases(running: RunningSubagent): { phases: RunPhase[] } {
	let current = running.phase;
	const phases: RunPhase[] = [current];
	Object.defineProperty(running, "phase", {
		configurable: true,
		enumerable: true,
		get: () => current,
		set(next: RunPhase) {
			if (next !== current) phases.push(next);
			current = next;
		},
	});
	return { phases };
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

/** A background runtime whose fake child exits on SIGTERM, as the real child does. */
function backgroundRuntime(
	child: ChildProcess,
	signals: NodeJS.Signals[],
	restart?: (running: RunningSubagent) => Promise<void>,
) {
	return {
		cleanupNoSessionSessionFile() {},
		async restartForTimeoutWrapUp(running: RunningSubagent) {
			if (!restart) throw new Error("unexpected timeout wrap-up restart");
			await restart(running);
		},
		terminateBackgroundChildProcess(_running: RunningSubagent, signal: NodeJS.Signals) {
			signals.push(signal);
			if (signal === "SIGTERM") child.emit("exit", 143);
		},
	};
}

describe("run phase", () => {
	beforeEach(() => {
		savedMux = process.env.PI_SUBAGENT_MUX;
		process.env.PI_SUBAGENT_MUX = "tmux";
	});

	afterEach(() => {
		if (savedMux == null) delete process.env.PI_SUBAGENT_MUX;
		else process.env.PI_SUBAGENT_MUX = savedMux;
		resetRuntimeStateForTest(() => {});
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("chart rule: a completion before the hard deadline never becomes timed out (background)", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		const signals: NodeJS.Signals[] = [];
		const running = makeRunning(sessionFile, {
			timeoutBudget: { timeoutSeconds: 1 },
			timeoutWarnThreshold: 50,
			childProcess: child,
		});
		// The child answered and wrote its completion before either deadline; its exit is in flight.
		appendAssistantEntry(sessionFile, "final", "Sweep finished.");
		writeSubagentExitSidecar(sessionFile, { type: "done" });
		const trace = tracePhases(running);

		const resultPromise = watchBackgroundSubagent(
			running,
			backgroundRuntime(child, signals),
			new AbortController().signal,
		);
		await sleep(1600); // past the soft (0.5s) and the hard (1s) deadline
		child.emit("exit", 0);
		const result = await settleWithin(resultPromise, 5000, "completed child");

		assert.deepEqual(signals, [], "a completed child is never killed");
		assert.equal(result.timedOut, undefined);
		assert.equal(result.timeoutWrapUp, undefined);
		assert.equal(buildCompletedSubagentResult(running, result).status, "completed");
		assert.deepEqual(trace.phases, ["running"], "no soft limit, wrap-up or stop after the completion");
	});

	it("chart rule: a completion before the hard deadline never becomes timed out (pane)", async () => {
		const sessionFile = makeSession();
		const running = makeRunning(sessionFile, {
			mode: "interactive",
			surface: "phase-surface",
			timeoutBudget: { timeoutSeconds: 1 },
			timeoutWarnThreshold: 50,
		});
		appendAssistantEntry(sessionFile, "final", "Sweep finished.");
		writeSubagentExitSidecar(sessionFile, { type: "done" });
		let closes = 0;
		let closesBeforeExit = -1;
		const trace = tracePhases(running);

		const result = await settleWithin(
			watchSubagent(
				running,
				{
					cleanupNoSessionSessionFile() {},
					async closeRunningSurface() {
						closes += 1;
					},
					async pollForExit(_surface: string, _signal: AbortSignal, options: { onTick?: () => void }) {
						// The pane stays open past both deadlines while the done record waits to be read.
						for (let i = 0; i < 16; i += 1) {
							options.onTick?.();
							await sleep(100);
						}
						closesBeforeExit = closes;
						return { reason: "done", exitCode: 0 };
					},
				} as never,
				new AbortController().signal,
			),
			5000,
			"completed pane child",
		);

		assert.equal(closesBeforeExit, 0, "a completed pane is never closed for a time limit");
		assert.equal(result.timedOut, undefined);
		assert.equal(result.timeoutWrapUp, undefined);
		assert.equal(buildCompletedSubagentResult(running, result).status, "completed");
		assert.deepEqual(trace.phases, ["running"]);
	});

	it("moves through soft limit and wrapping up to ended for a time-limit wrap-up", async () => {
		const sessionFile = makeSession();
		const firstChild = new EventEmitter() as ChildProcess;
		const wrapUpChild = new EventEmitter() as ChildProcess;
		const running = makeRunning(sessionFile, {
			timeoutBudget: { timeoutSeconds: 2 },
			timeoutWarnThreshold: 50,
			childProcess: firstChild,
		});
		const trace = tracePhases(running);

		const result = await settleWithin(
			watchBackgroundSubagent(
				running,
				backgroundRuntime(firstChild, [], async (current) => {
					current.childProcess = wrapUpChild;
					appendAssistantEntry(sessionFile, "wrap-up", "Wrap-up report.");
					writeSubagentExitSidecar(sessionFile, { type: "done" });
					setTimeout(() => wrapUpChild.emit("exit", 0), 50);
				}),
				new AbortController().signal,
			),
			4000,
			"wrap-up",
		);
		routeSubagentOutcome({ pi: { sendMessage() {} }, running, result, updateWidget() {} });

		assert.deepEqual(trace.phases, ["running", "soft-limit", "wrapping-up", "ended"]);
	});

	it("is stopping after a time-limit kill and after a stop request", async () => {
		const killed = makeSession();
		const killedChild = new EventEmitter() as ChildProcess;
		const timedOut = makeRunning(killed, { timeoutBudget: { timeoutSeconds: 1 }, childProcess: killedChild });
		const killTrace = tracePhases(timedOut);
		const killResult = await settleWithin(
			watchBackgroundSubagent(timedOut, backgroundRuntime(killedChild, []), new AbortController().signal),
			4000,
			"time-limit kill",
		);
		assert.equal(killResult.timedOut, "timeout");
		assert.deepEqual(killTrace.phases, ["running", "stopping"]);

		const stoppedSession = makeSession();
		const stoppedChild = new EventEmitter() as ChildProcess;
		const abort = new AbortController();
		const stopped = makeRunning(stoppedSession, { abortController: abort, childProcess: stoppedChild });
		const watch = watchBackgroundSubagent(stopped, backgroundRuntime(stoppedChild, []), abort.signal);
		await stopRunningSubagent(stopped, async () => {});
		assert.equal(stopped.phase, "stopping");
		stoppedChild.emit("exit", 143);
		const stopResult = await settleWithin(watch, 4000, "stop request");
		assert.equal(stopResult.error, "cancelled");
	});

	it("ends a run whose watcher failed, and sends a closed parent nothing", async () => {
		for (const closeParent of [false, true]) {
			const running = makeRunning(makeSession(), { id: closeParent ? "closed-parent" : "open-parent" });
			if (closeParent) closeParentDelivery(running);
			const sent: unknown[] = [];
			const pi = { sendMessage: (message: unknown) => sent.push(message) } as unknown as ExtensionAPI;
			wireSubagentSteerBack(pi, running, Promise.reject(new Error("watcher crashed")), () => {});
			await sleep(10);
			assert.equal(running.phase, "ended");
			assert.equal(sent.length, closeParent ? 0 : 1, closeParent ? "closed parent" : "open parent");
		}
	});

	it("sends a stopping run no soft interruption and no reaper signal", async () => {
		const sessionFile = makeSession();
		// A finished answer the terminal-summary reaper would act on for a running auto-exit child.
		appendAssistantEntry(sessionFile, "final", "Sweep finished.");
		const child = new EventEmitter() as ChildProcess;
		const signals: NodeJS.Signals[] = [];
		const running = makeRunning(sessionFile, {
			autoExit: true,
			// Soft limit at 1 s, hard deadline at 4 s.
			timeoutBudget: { timeoutSeconds: 4 },
			timeoutWarnThreshold: 25,
			childProcess: child,
		});
		// A parent close without an abort controller sets stopping and signals the child itself.
		running.phase = "stopping";
		const watch = watchBackgroundSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				terminateBackgroundChildProcess(_running, signal) {
					signals.push(signal);
				},
			},
			new AbortController().signal,
		);
		await sleep(2600); // past the soft limit, two polls and the reaper's grace
		assert.deepEqual(signals, [], "the watcher adds no signal to a stopping run");
		assert.equal(running.timeoutWrapUp, undefined);
		assert.equal(running.phase, "stopping");
		child.emit("exit", 143);
		await settleWithin(watch, 4000, "stopping run exit");
	});
});
