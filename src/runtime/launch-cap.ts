/**
 * D9: a parent starts at most DEFAULT_LAUNCH_CAP runs between two session starts.
 *
 * Pi's /reload loads the extension again in the same process, so module state is lost. The count
 * lives on globalThis under a registered symbol: a reload keeps it, a new process starts at 0, and
 * a session start that replaces the session (new, resume, fork) installs a fresh count.
 */
export const DEFAULT_LAUNCH_CAP = 64;
export const LAUNCH_CAP_ENV = "PI_SUBAGENT_LAUNCH_CAP";

const LAUNCH_COUNT_KEY = Symbol.for("pi-subagents/launch-cap-count");

/** The starts of one session. Each session start that is not a reload installs a new object. */
type LaunchCount = { started: number; reserved: number };

type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

function globalState(): Record<PropertyKey, unknown> {
	return globalThis as Record<PropertyKey, unknown>;
}

function currentCount(): LaunchCount {
	const state = globalState();
	let count = state[LAUNCH_COUNT_KEY] as LaunchCount | undefined;
	if (!count) {
		count = { started: 0, reserved: 0 };
		state[LAUNCH_COUNT_KEY] = count;
	}
	return count;
}

/** A reload keeps the count; every other session start begins at 0. */
export function resetLaunchCountForSessionStart(reason: SessionStartReason): void {
	if (reason === "reload") {
		currentCount();
		return;
	}
	globalState()[LAUNCH_COUNT_KEY] = { started: 0, reserved: 0 } satisfies LaunchCount;
}

export function getLaunchCap(env: Record<string, string | undefined> = process.env): number {
	const raw = env[LAUNCH_CAP_ENV]?.trim();
	if (raw === undefined || !/^\d+$/.test(raw)) return DEFAULT_LAUNCH_CAP;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) ? parsed : DEFAULT_LAUNCH_CAP;
}

/** Runs started plus runs reserved and not yet started or given back. */
export function getLaunchCountUsed(): number {
	const count = currentCount();
	return count.started + count.reserved;
}

/**
 * Launch cap slots reserved by one holder before any launch side effect. The holder either
 * commits them (the child started, the slots stay used until the next session start) or releases
 * them (the child never started). Each slot ends exactly once; a second commit or release is a
 * no-op. A lease keeps the count of the session it was taken in, so a lease that ends after a
 * session start cannot change the new session's count.
 */
export class LaunchCapLease {
	readonly #count: LaunchCount;
	#held: number;

	constructor(count: LaunchCount, held: number) {
		this.#count = count;
		this.#held = held;
		count.reserved += held;
	}

	get held(): number {
		return this.#held;
	}

	/** Moves `slots` of this lease into a new lease for another holder. */
	split(slots: number): LaunchCapLease {
		if (!Number.isInteger(slots) || slots < 0 || slots > this.#held) {
			throw new Error(`Cannot split ${slots} launch cap slots from a lease that holds ${this.#held}.`);
		}
		this.#held -= slots;
		this.#count.reserved -= slots;
		return new LaunchCapLease(this.#count, slots);
	}

	/** The child started: its slots count until the next session start. */
	commit(): void {
		this.#count.reserved -= this.#held;
		this.#count.started += this.#held;
		this.#held = 0;
	}

	/** The child never started: its slots go back. */
	release(): void {
		this.#count.reserved -= this.#held;
		this.#held = 0;
	}
}

/**
 * Reserve `slots` launch cap slots. The check and the reservation run in one synchronous step,
 * so two batches admitted at the same time cannot both take the last slot. Null means the cap is hit.
 */
export function tryAcquireLaunchCapSlots(slots: number): LaunchCapLease | null {
	const count = currentCount();
	if (slots > 0 && count.started + count.reserved + slots > getLaunchCap()) return null;
	return new LaunchCapLease(count, Math.max(slots, 0));
}

export function getLaunchCapError(requested: number): string {
	const cap = getLaunchCap();
	return (
		`Launch cap reached: this session has started ${getLaunchCountUsed()} of ${cap} runs allowed between two session starts, ` +
		`and this launch needs ${requested} more. The count starts at 0 with a new, resumed or forked session; ` +
		`${LAUNCH_CAP_ENV} changes the cap of ${cap}.`
	);
}

export function resetLaunchCountForTest(): void {
	delete globalState()[LAUNCH_COUNT_KEY];
}
