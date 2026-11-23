import type { RunningSubagent, RunPhase } from "../types.ts";

/**
 * Events of the stop and end writers. The watcher events (soft limit, wrap-up, time-limit kill)
 * still write the phase in their own files (statecharts ticket C).
 */
type RunPhaseEvent = "stop" | "end";

const targetPhase = {
	stop: "stopping",
	end: "ended",
} as const satisfies Record<RunPhaseEvent, RunPhase>;

/**
 * D5: the one owner of the stop and end transitions. Ended is final: an event on an ended run changes
 * nothing and returns false, so the caller sends no signal and closes no surface. `beforeApply` runs
 * only for a run that has not ended, before the phase changes; when it throws, the phase stays as it is.
 */
export function applyRunPhaseEvent(
	running: Pick<RunningSubagent, "phase">,
	event: RunPhaseEvent,
	beforeApply?: () => void,
): boolean {
	if (running.phase === "ended") return false;
	beforeApply?.();
	running.phase = targetPhase[event];
	return true;
}
