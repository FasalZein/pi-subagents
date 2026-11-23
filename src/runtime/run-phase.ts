import type { RunningSubagent, RunPhase } from "../types.ts";

/**
 * Every phase change of a run after launch. The watcher events: softLimit (the report-only soft deadline
 * interrupts a running generation), wrapUp (the wrap-up continuation started), timeLimit (a hard limit kills
 * the child, in a watcher or during the wrap-up restart). stop is a stop request or a parent close; end is
 * the published end.
 */
export type RunPhaseEvent = "softLimit" | "wrapUp" | "timeLimit" | "stop" | "end";

interface RunPhaseTransition {
	readonly from: readonly RunPhase[];
	readonly to: RunPhase;
}

/**
 * The phases each event may leave from, as the callers reached them before statecharts ticket C:
 * - softLimit: only a running generation (the callers checked phase "running").
 * - wrapUp: a soft-limit generation ended for its wrap-up; stopping only after a stop that aborted no
 *   watcher (a run without an abortController), which the wrap-up then overwrites as it did before.
 * - timeLimit, stop, end: any phase but ended (ended is final, ticket B).
 */
const runPhaseTransitions = {
	softLimit: { from: ["running"], to: "soft-limit" },
	wrapUp: { from: ["soft-limit", "stopping"], to: "wrapping-up" },
	timeLimit: { from: ["running", "soft-limit", "wrapping-up", "stopping"], to: "stopping" },
	stop: { from: ["running", "soft-limit", "wrapping-up", "stopping"], to: "stopping" },
	end: { from: ["running", "soft-limit", "wrapping-up", "stopping"], to: "ended" },
} as const satisfies Record<RunPhaseEvent, RunPhaseTransition>;

/**
 * D5: the one owner of every phase change after launch. An event from a phase outside its `from` set changes
 * nothing and returns false, so the caller sends no signal and closes no surface. `beforeApply` runs only
 * when the event applies, before the phase changes; when it throws, the phase stays as it is.
 */
export function applyRunPhaseEvent(
	running: Pick<RunningSubagent, "phase">,
	event: RunPhaseEvent,
	beforeApply?: () => void,
): boolean {
	const transition: RunPhaseTransition = runPhaseTransitions[event];
	if (!transition.from.includes(running.phase)) return false;
	beforeApply?.();
	running.phase = transition.to;
	return true;
}
