import type { DeliveryState, RunningSubagent } from "../types.ts";

/**
 * D16: the subagent_wait calls that wait for each run, by run id. Several waits may wait for one
 * run; while any of them waits, the run's end is held in the delivery queue for them instead of
 * being sent as a message. The registry outlives the run's entry in the running map, so an
 * aborted wait can tell whether another wait still holds an end that already arrived.
 */
const holds = new Map<string, Set<symbol>>();

/**
 * D5 and D15: the one wait that claimed a run exclusively (a launch that waits, or the single-run
 * wait). The claim holds the run's end like any hold; it is keyed by the run object, so a later run
 * that reuses the id starts unclaimed. The run record carries no delivery state; this owns it.
 */
let claims = new WeakMap<RunningSubagent, symbol>();

/** A wait claims this run; undefined when another wait already claimed it. */
export function claimRunEnd(running: RunningSubagent): symbol | undefined {
	if (claims.has(running)) return undefined;
	const token = holdRunEnd(running.id);
	claims.set(running, token);
	return token;
}

/** The claiming wait ends; a token that no longer owns the claim does nothing. */
export function releaseRunEndClaim(running: RunningSubagent, token: symbol): void {
	if (claims.get(running) !== token) return;
	claims.delete(running);
	dropRunEndHold(running.id, token);
}

/** The parent closed: the claim ends without the wait's reply. */
export function dropRunEndClaim(running: RunningSubagent): void {
	const token = claims.get(running);
	if (token) releaseRunEndClaim(running, token);
}

/** "awaited" while a wait claims the run, else "detached": what the replies and the widget show. */
export function runDeliveryState(running: RunningSubagent): DeliveryState {
	return claims.has(running) ? "awaited" : "detached";
}

/** A wait starts to hold the run with this id; the returned token drops the hold once. */
export function holdRunEnd(id: string): symbol {
	const token = Symbol(id);
	const set = holds.get(id) ?? new Set<symbol>();
	set.add(token);
	holds.set(id, set);
	return token;
}

/** The wait's hold ends; returns whether another wait still holds this run. */
export function dropRunEndHold(id: string, token: symbol): boolean {
	const set = holds.get(id);
	if (!set) return false;
	set.delete(token);
	if (set.size > 0) return true;
	holds.delete(id);
	return false;
}

export function isRunEndHeld(id: string): boolean {
	return (holds.get(id)?.size ?? 0) > 0;
}

/** Forget every hold (test isolation and runtime reset). */
export function resetRunEndHolds(): void {
	holds.clear();
	claims = new WeakMap();
}
