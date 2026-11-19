/**
 * D16: the subagent_wait calls that wait for each run, by run id. Several waits may wait for one
 * run; while any of them waits, the run's end is held in the delivery queue for them instead of
 * being sent as a message. The registry outlives the run's entry in the running map, so an
 * aborted wait can tell whether another wait still holds an end that already arrived.
 */
const holds = new Map<string, Set<symbol>>();

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
}
