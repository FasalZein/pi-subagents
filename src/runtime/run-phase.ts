import type {
	RunningSubagent,
	RunPhase,
	RunPhaseState,
	StopRequester,
	TimeoutExpiry,
	TimeoutWrapUp,
	WrapUpDeadline,
} from "../types.ts";

/**
 * Every phase change of a run after launch, with the data it brings into the phase. The watcher events:
 * softLimit (the report-only soft deadline interrupts a running generation), keepCompletion (a completion
 * accepted before the hard deadline is the end, so the wrap-up never runs), wrapUp (the wrap-up continuation
 * started), timeLimit (a hard limit kills the child, in a watcher or during the wrap-up restart). stop is a
 * stop request or a parent close; end is the published end.
 */
export type RunPhaseEvent =
	| { readonly type: "softLimit"; readonly wrapUp: WrapUpDeadline }
	| { readonly type: "keepCompletion" }
	| { readonly type: "wrapUp" }
	| { readonly type: "timeLimit"; readonly expiry: TimeoutExpiry }
	| { readonly type: "stop"; readonly by?: StopRequester }
	| { readonly type: "end" };

type RunPhaseEventType = RunPhaseEvent["type"];

/**
 * The phases each event may leave from, as the callers reached them before statecharts ticket C:
 * - softLimit: only a running generation (the callers checked phase "running").
 * - keepCompletion: only a soft-limit generation whose child completed before the hard deadline.
 * - wrapUp: a soft-limit generation ended for its wrap-up; stopping only after a stop that aborted no
 *   watcher (a run without an abortController), which the wrap-up then overwrites as it did before.
 * - timeLimit: any phase but ended. From stopping it is reachable with an abortController too: a hard
 *   deadline during a pending wrap-up restart, then a parent stop; the restart saved the deadline as the
 *   first cause, so the run ends timed out (a stop the restart sees first returns cancelled instead).
 * - stop, end: any phase but ended (ended is final, ticket B).
 */
const runPhaseSources = {
	softLimit: ["running"],
	keepCompletion: ["soft-limit"],
	wrapUp: ["soft-limit", "stopping"],
	timeLimit: ["running", "soft-limit", "wrapping-up", "stopping"],
	stop: ["running", "soft-limit", "wrapping-up", "stopping"],
	end: ["running", "soft-limit", "wrapping-up", "stopping"],
} as const satisfies Record<RunPhaseEventType, readonly RunPhase[]>;

/** The wrap-up a phase carries; a kept completion and the phases without a soft deadline carry none. */
function wrapUpDeadlineOf(phase: RunPhaseState): WrapUpDeadline | undefined {
	switch (phase.kind) {
		case "soft-limit":
			return phase.wrapUp ?? undefined;
		case "wrapping-up":
		case "stopping":
			return phase.wrapUp;
		case "running":
		case "ended":
			return undefined;
		default: {
			const _exhaustive: never = phase;
			return _exhaustive;
		}
	}
}

/**
 * The phase an event leads to from `current`, which is in the event's source set. Returns undefined only
 * for a wrap-up with no recorded soft deadline: no caller reaches it, since a restart follows a soft limit.
 */
function nextPhase(current: RunPhaseState, event: RunPhaseEvent): RunPhaseState | undefined {
	const wrapUp = wrapUpDeadlineOf(current);
	const stopping = current.kind === "stopping" ? current : undefined;
	switch (event.type) {
		case "softLimit":
			return { kind: "soft-limit", wrapUp: event.wrapUp };
		case "keepCompletion":
			return { kind: "soft-limit", wrapUp: null };
		case "wrapUp":
			// The stop this overwrites aborted no watcher, so no result reads its requester.
			return wrapUp ? { kind: "wrapping-up", wrapUp } : undefined;
		case "timeLimit":
			return { ...stopping, kind: "stopping", wrapUp, timeoutExpiry: event.expiry };
		case "stop":
			// T70: the first stop request that names its requester names who ended the run.
			return { ...stopping, kind: "stopping", wrapUp, stopRequestedBy: stopping?.stopRequestedBy ?? event.by };
		case "end":
			return { kind: "ended" };
		default: {
			const _exhaustive: never = event;
			return _exhaustive;
		}
	}
}

/**
 * D5: the one owner of every phase change after launch. An event from a phase outside its source set
 * changes nothing and returns false. `beforeApply` runs only when the event applies, before the phase
 * changes; when it throws, the phase stays as it is.
 */
export function applyRunPhaseEvent(
	running: Pick<RunningSubagent, "phase">,
	event: RunPhaseEvent,
	beforeApply?: () => void,
): boolean {
	const sources: readonly RunPhase[] = runPhaseSources[event.type];
	if (!sources.includes(running.phase.kind)) return false;
	const next = nextPhase(running.phase, event);
	if (!next) return false;
	beforeApply?.();
	running.phase = next;
	return true;
}

/** The soft deadline that interrupted this run, while its phase carries one. */
export function timeoutWrapUpOf(running: Pick<RunningSubagent, "phase">): TimeoutWrapUp | undefined {
	return wrapUpDeadlineOf(running.phase)?.wrapUp;
}

/** The fixed hard deadline of the budget that triggered the wrap-up, while the phase carries one. */
export function timeoutWrapUpDeadlineAtOf(running: Pick<RunningSubagent, "phase">): number | undefined {
	return wrapUpDeadlineOf(running.phase)?.deadlineAt;
}

/** The budget a time-limit stop kills this child on. */
export function timeoutExpiryOf(running: Pick<RunningSubagent, "phase">): TimeoutExpiry | undefined {
	return running.phase.kind === "stopping" ? running.phase.timeoutExpiry : undefined;
}

/** T70: who asked this stopping run to stop. */
export function stopRequesterOf(running: Pick<RunningSubagent, "phase">): StopRequester | undefined {
	return running.phase.kind === "stopping" ? running.phase.stopRequestedBy : undefined;
}

/** The `timeoutWrapUp` field of a result built from this run. */
export function timeoutWrapUpField(running: Pick<RunningSubagent, "phase">): { timeoutWrapUp?: TimeoutWrapUp } {
	const wrapUp = timeoutWrapUpOf(running);
	return wrapUp ? { timeoutWrapUp: wrapUp } : {};
}
