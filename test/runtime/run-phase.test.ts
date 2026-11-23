import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { closeParentDelivery } from "../../src/runtime/delivery-queue.ts";
import { watchSubagent } from "../../src/runtime/interactive-watch.ts";
import { routeSubagentOutcome } from "../../src/runtime/result-router.ts";
import {
	applyRunPhaseEvent,
	type RunPhaseEvent,
	stopRequesterOf,
	timeoutExpiryOf,
	timeoutWrapUpDeadlineAtOf,
	timeoutWrapUpOf,
} from "../../src/runtime/run-phase.ts";
import { stopRunningSubagent, wireSubagentSteerBack } from "../../src/runtime/running-registry.ts";
import { shutdownSubagentsForParentExit } from "../../src/runtime/shutdown.ts";
import { buildCompletedSubagentResult, resetRuntimeStateForTest } from "../../src/runtime/state.ts";
import { writeSubagentExitSidecar } from "../../src/session/exit-sidecar.ts";
import type {
	RunningSubagent,
	RunPhase,
	RunPhaseState,
	TimeoutExpiry,
	WrapUpDeadline,
} from "../../src/types.ts";
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
		phase: { kind: "running" },
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		...overrides,
	};
}

/** Records every phase kind the run is set to, in order, without changing what the code reads. */
function tracePhases(running: RunningSubagent): { phases: RunPhase[] } {
	let current = running.phase;
	const phases: RunPhase[] = [current.kind];
	Object.defineProperty(running, "phase", {
		configurable: true,
		enumerable: true,
		get: () => current,
		set(next: RunPhaseState) {
			if (next.kind !== current.kind) phases.push(next.kind);
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

describe("run phase transitions", () => {
	// Expected values: the from-sets of ticket C (src/runtime/run-phase.ts) and the phase data of report.md M1 (ticket D).
	const wrap: WrapUpDeadline = { wrapUp: { kind: "idle-timeout", seconds: 10, threshold: 80 }, deadlineAt: 1_010_000 };
	const later: WrapUpDeadline = { wrapUp: { kind: "timeout", seconds: 20, threshold: 50 }, deadlineAt: 2_000_000 };
	const expiry: TimeoutExpiry = { kind: "timeout", seconds: 5 };
	const sample: Record<RunPhase, RunPhaseState> = {
		running: { kind: "running" },
		"soft-limit": { kind: "soft-limit", wrapUp: wrap },
		"wrapping-up": { kind: "wrapping-up", wrapUp: wrap },
		stopping: { kind: "stopping", wrapUp: wrap, stopRequestedBy: "operator" },
		ended: { kind: "ended" },
	};
	const allPhases = Object.keys(sample) as RunPhase[];
	const cases: Array<{ event: RunPhaseEvent; to: Partial<Record<RunPhase, RunPhaseState>> }> = [
		{ event: { type: "softLimit", wrapUp: later }, to: { running: { kind: "soft-limit", wrapUp: later } } },
		{ event: { type: "keepCompletion" }, to: { "soft-limit": { kind: "soft-limit", wrapUp: null } } },
		{
			event: { type: "wrapUp" },
			to: { "soft-limit": { kind: "wrapping-up", wrapUp: wrap }, stopping: { kind: "wrapping-up", wrapUp: wrap } },
		},
		{
			event: { type: "timeLimit", expiry },
			to: {
				running: { kind: "stopping", wrapUp: undefined, timeoutExpiry: expiry },
				"soft-limit": { kind: "stopping", wrapUp: wrap, timeoutExpiry: expiry },
				"wrapping-up": { kind: "stopping", wrapUp: wrap, timeoutExpiry: expiry },
				// The restart's saved deadline after a parent stop: the stop cause stays, the expiry joins it.
				stopping: { kind: "stopping", wrapUp: wrap, timeoutExpiry: expiry, stopRequestedBy: "operator" },
			},
		},
		{
			event: { type: "stop", by: "parent" },
			to: {
				running: { kind: "stopping", wrapUp: undefined, stopRequestedBy: "parent" },
				"soft-limit": { kind: "stopping", wrapUp: wrap, stopRequestedBy: "parent" },
				"wrapping-up": { kind: "stopping", wrapUp: wrap, stopRequestedBy: "parent" },
				// T70: the first stop request that names its requester names who ended the run.
				stopping: { kind: "stopping", wrapUp: wrap, stopRequestedBy: "operator" },
			},
		},
		{
			event: { type: "end" },
			to: {
				running: { kind: "ended" },
				"soft-limit": { kind: "ended" },
				"wrapping-up": { kind: "ended" },
				stopping: { kind: "ended" },
			},
		},
	];

	for (const { event, to } of cases) {
		it(`${event.type} moves each allowed phase to its state with the event's data`, () => {
			for (const [from, expected] of Object.entries(to)) {
				const running: Pick<RunningSubagent, "phase"> = { phase: sample[from as RunPhase] };
				let before: RunPhaseState | undefined;
				const applied = applyRunPhaseEvent(running, event, () => {
					before = running.phase;
				});
				assert.equal(applied, true, from);
				assert.deepEqual(before, sample[from as RunPhase], `${from}: beforeApply runs before the change`);
				assert.deepEqual(running.phase, expected, from);
			}
		});

		it(`${event.type} refuses every phase outside its allowed set, without running beforeApply`, () => {
			for (const phase of allPhases.filter((candidate) => !(candidate in to))) {
				const running: Pick<RunningSubagent, "phase"> = { phase: sample[phase] };
				let ran = false;
				const applied = applyRunPhaseEvent(running, event, () => {
					ran = true;
				});
				assert.equal(applied, false, phase);
				assert.equal(running.phase, sample[phase], phase);
				assert.equal(ran, false, `${phase}: beforeApply does not run`);
			}
		});
	}

	it("refuses a wrap-up from a phase that carries no soft deadline", () => {
		for (const phase of [
			{ kind: "soft-limit", wrapUp: null },
			{ kind: "stopping", stopRequestedBy: "parent" },
		] satisfies RunPhaseState[]) {
			const running: Pick<RunningSubagent, "phase"> = { phase };
			assert.equal(applyRunPhaseEvent(running, { type: "wrapUp" }), false, phase.kind);
			assert.equal(running.phase, phase);
		}
	});

	it("keeps the phase when beforeApply throws", () => {
		const running: Pick<RunningSubagent, "phase"> = { phase: { kind: "running" } };
		assert.throws(() =>
			applyRunPhaseEvent(running, { type: "timeLimit", expiry }, () => {
				throw new Error("no expiry");
			}),
		);
		assert.deepEqual(running.phase, { kind: "running" });
	});

	it("reads each payload only from its phase", () => {
		const read = (phase: RunPhaseState) => {
			const running = { phase };
			return {
				wrapUp: timeoutWrapUpOf(running),
				deadlineAt: timeoutWrapUpDeadlineAtOf(running),
				expiry: timeoutExpiryOf(running),
				stopBy: stopRequesterOf(running),
			};
		};
		const none = { wrapUp: undefined, deadlineAt: undefined, expiry: undefined, stopBy: undefined };
		assert.deepEqual(read({ kind: "running" }), none);
		assert.deepEqual(read({ kind: "soft-limit", wrapUp: null }), none, "a kept completion carries no wrap-up");
		assert.deepEqual(read(sample["soft-limit"]), { ...none, wrapUp: wrap.wrapUp, deadlineAt: wrap.deadlineAt });
		assert.deepEqual(read(sample["wrapping-up"]), { ...none, wrapUp: wrap.wrapUp, deadlineAt: wrap.deadlineAt });
		assert.deepEqual(read({ kind: "stopping", wrapUp: wrap, timeoutExpiry: expiry, stopRequestedBy: "parent" }), {
			wrapUp: wrap.wrapUp,
			deadlineAt: wrap.deadlineAt,
			expiry,
			stopBy: "parent",
		});
		assert.deepEqual(read({ kind: "ended" }), none, "the result record was built before the end");
	});
});

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
					async pollForExit(_surface, _signal, options) {
						// The pane stays open past both deadlines while the done record waits to be read.
						for (let i = 0; i < 16; i += 1) {
							options?.onTick?.(i * 100);
							await sleep(100);
						}
						closesBeforeExit = closes;
						return { reason: "done", exitCode: 0 };
					},
				},
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
		assert.equal(stopped.phase.kind, "stopping");
		stoppedChild.emit("exit", 143);
		const stopResult = await settleWithin(watch, 4000, "stop request");
		assert.equal(stopResult.error, "cancelled");
	});

	// Ticket C review: both orderings of a parent stop and the hard deadline during a pending wrap-up restart.
	// Expected values from timeout-restart.ts (D7: the first cause decides the end) and the review's trace.
	for (const order of ["deadline then stop", "stop seen first"] as const) {
		it(`ends a pending wrap-up restart by its first cause: ${order}`, async () => {
			const sessionFile = makeSession();
			const child = new EventEmitter() as ChildProcess;
			const abort = new AbortController();
			const running = makeRunning(sessionFile, {
				// Soft limit at 0.5 s, hard deadline at 1 s.
				timeoutBudget: { timeoutSeconds: 1 },
				timeoutWarnThreshold: 50,
				abortController: abort,
				childProcess: child,
			});
			let restartStarted = false;
			let failStartup: (error: Error) => void = () => {};
			// A restart that awaits startup and does not observe its abort signal (a pane program start).
			const startup = new Promise<void>((_resolve, reject) => {
				failStartup = reject;
			});
			const watch = watchBackgroundSubagent(
				running,
				backgroundRuntime(child, [], async () => {
					restartStarted = true;
					await startup;
				}),
				abort.signal,
			);
			while (!restartStarted) await sleep(20);
			if (order === "deadline then stop") await sleep(Math.max(0, running.startTime + 1200 - Date.now()));
			await stopRunningSubagent(running, async () => {}, undefined, "parent");
			failStartup(new Error("startup interrupted"));
			const result = await settleWithin(watch, 4000, order);

			const wrapUp = { wrapUp: { kind: "timeout", seconds: 1, threshold: 50 }, deadlineAt: running.startTime + 1000 };
			if (order === "deadline then stop") {
				assert.deepEqual(running.phase, {
					kind: "stopping",
					wrapUp,
					stopRequestedBy: "parent",
					timeoutExpiry: { kind: "timeout", seconds: 1 },
				});
				assert.equal(result.timedOut, "timeout", "the saved deadline wins over the later stop");
				assert.equal(result.error, undefined);
			} else {
				assert.deepEqual(running.phase, { kind: "stopping", wrapUp, stopRequestedBy: "parent" });
				assert.equal(result.timedOut, undefined);
				assert.equal(result.error, "cancelled", "the stop the restart saw first wins");
			}
			assert.deepEqual(result.timeoutWrapUp, wrapUp.wrapUp);
			routeSubagentOutcome({ pi: { sendMessage() {} }, running, result, updateWidget() {} });
			assert.deepEqual(running.phase, { kind: "ended" });
			assert.equal(
				buildCompletedSubagentResult(running, result).status,
				order === "deadline then stop" ? "failed" : "cancelled",
			);
		});
	}

	it("keeps a completion accepted during the soft limit: the wrap-up never runs and its marker is gone", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		const signals: NodeJS.Signals[] = [];
		const running = makeRunning(sessionFile, {
			timeoutBudget: { timeoutSeconds: 2 },
			timeoutWarnThreshold: 25,
			childProcess: child,
		});
		const trace = tracePhases(running);
		const watch = watchBackgroundSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				terminateBackgroundChildProcess(_running: RunningSubagent, signal: NodeJS.Signals) {
					signals.push(signal);
					if (signal !== "SIGTERM") return;
					// The child accepts its completion call on the way out of the soft interruption.
					appendAssistantEntry(sessionFile, "final", "Sweep finished.");
					writeSubagentExitSidecar(sessionFile, { type: "done", acceptedCall: { toolCallId: "call-done", args: {} } });
					child.emit("exit", 0);
				},
			},
			new AbortController().signal,
		);
		const result = await settleWithin(watch, 4000, "kept completion");
		assert.deepEqual(running.phase, { kind: "soft-limit", wrapUp: null });
		assert.equal(result.timeoutWrapUp, undefined);
		assert.equal(result.timedOut, undefined);
		assert.deepEqual(trace.phases, ["running", "soft-limit"]);
	});

	it("ends a run whose watcher failed, and sends a closed parent nothing", async () => {
		for (const closeParent of [false, true]) {
			const running = makeRunning(makeSession(), { id: closeParent ? "closed-parent" : "open-parent" });
			if (closeParent) closeParentDelivery(running);
			const sent: unknown[] = [];
			const pi = { sendMessage: (message: unknown) => sent.push(message) } as unknown as ExtensionAPI;
			wireSubagentSteerBack(pi, running, Promise.reject(new Error("watcher crashed")), () => {});
			await sleep(10);
			assert.equal(running.phase.kind, "ended");
			assert.equal(sent.length, closeParent ? 0 : 1, closeParent ? "closed parent" : "open parent");
		}
	});

	it("leaves an ended run as it is: a stop or a parent close sends no signal and closes no surface", async () => {
		// Ticket B: ended is final for every stop writer, not only for the callers that check first.
		const fakeChild = (signals: unknown[]) =>
			({ pid: 999_999_992, kill: (signal: unknown) => signals.push(signal) }) as unknown as ChildProcess;
		const groupSignals: Array<[number, string | number | undefined]> = [];
		const originalKill = process.kill;
		process.kill = ((pid: number, signal?: string | number) => {
			groupSignals.push([pid, signal]);
			return true;
		}) as typeof process.kill;
		try {
			const childSignals: unknown[] = [];
			const abort = new AbortController();
			const stopped = makeRunning(makeSession(), {
				phase: { kind: "ended" },
				abortController: abort,
				childProcess: fakeChild(childSignals),
			});
			let surfaceCloses = 0;
			await stopRunningSubagent(stopped, async () => {
				surfaceCloses++;
			});
			assert.equal(stopped.phase.kind, "ended");
			assert.equal(surfaceCloses, 0, "no surface close");
			assert.equal(abort.signal.aborted, false, "no watcher abort");
			assert.deepEqual(childSignals, []);

			for (const mode of ["background", "interactive"] as const) {
				const closedSignals: unknown[] = [];
				const closed = makeRunning(makeSession(), {
					id: `ended-${mode}`,
					mode,
					phase: { kind: "ended" },
					childProcess: fakeChild(closedSignals),
				});
				let closes = 0;
				await shutdownSubagentsForParentExit(
					{
						runningSubagents: new Map([[closed.id, closed]]),
						completedSubagentResults: new Map(),
						parentCloseEscalationMs: 10,
						updateWidget() {},
						async closeRunningSurface() {
							closes++;
						},
						cleanupNoSessionSessionFile() {},
					},
					{ escalationMs: 10 },
				);
				assert.equal(closed.phase.kind, "ended", mode);
				assert.equal(closes, 0, `${mode}: no surface close`);
				assert.equal(closed.shutdownTimer, undefined, `${mode}: no SIGKILL escalation`);
				assert.deepEqual(closedSignals, [], mode);
			}
			assert.deepEqual(groupSignals, [], "no SIGTERM to any process group");
		} finally {
			process.kill = originalKill;
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
		running.phase = { kind: "stopping" };
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
		assert.deepEqual(running.phase, { kind: "stopping" }, "no wrap-up joins a stopping run");
		child.emit("exit", 143);
		await settleWithin(watch, 4000, "stopping run exit");
	});
});
