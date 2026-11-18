export const MAX_SPAWN_WIDTH = 16;

let configuredWidth: number | null | undefined;

function parseConfiguredWidth(raw: string | undefined): number | null {
	if (raw === undefined || !/^\d+$/.test(raw.trim())) return null;
	const parsed = Number(raw.trim());
	return Number.isFinite(parsed) ? parsed : null;
}

export function getEffectiveSpawnWidthLimit(configured?: number | null): number {
	if (configured === undefined) {
		if (configuredWidth === undefined) initializeSpawnWidthForSession();
		configured = configuredWidth ?? null;
	}
	return Math.min(configured ?? Number.POSITIVE_INFINITY, MAX_SPAWN_WIDTH);
}

export function initializeSpawnWidthForSession(env: Record<string, string | undefined> = process.env): void {
	const raw = env.PI_SUBAGENT_AGENT?.trim() && env.PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE !== undefined
		? env.PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE
		: env.PI_SUBAGENT_SPAWN_WIDTH;
	configuredWidth = parseConfiguredWidth(raw);
}

export function getSpawnWidthLimit(): number {
	if (configuredWidth === undefined) initializeSpawnWidthForSession();
	return getEffectiveSpawnWidthLimit(configuredWidth ?? null);
}

type SlotOwner = { spawnWidthSlotAcquired?: boolean };

const liveLeases = new Set<SpawnSlotLease>();
const slotOwners = new Map<SlotOwner, SpawnSlotLease>();

/**
 * Spawn slots reserved by one holder. Only the lease gives its slots back,
 * and only once, so a failed launch cannot release slots another run holds
 * (D6). The live count is the sum of live leases, never a free counter.
 */
export class SpawnSlotLease {
	#held: number;

	constructor(count: number) {
		this.#held = count;
		if (count > 0) liveLeases.add(this);
	}

	get held(): number {
		return this.#held;
	}

	/** Moves `count` of this lease's slots into a new lease for another holder. */
	split(count: number): SpawnSlotLease {
		if (!Number.isInteger(count) || count < 0 || count > this.#held) {
			throw new Error(`Cannot split ${count} spawn slots from a lease that holds ${this.#held}.`);
		}
		this.#held -= count;
		if (this.#held === 0) liveLeases.delete(this);
		return new SpawnSlotLease(count);
	}

	release(): void {
		this.#held = 0;
		liveLeases.delete(this);
	}
}

/**
 * Reserve all requested slots before an async launch begins. The returned
 * lease is the only handle that gives them back; null means the limit is hit.
 */
export function tryAcquireSlots(count: number, limit: number | null): SpawnSlotLease | null {
	if (count <= 0) return new SpawnSlotLease(0);
	const effectiveLimit = limit === null ? null : getEffectiveSpawnWidthLimit(limit);
	if (effectiveLimit !== null && getLiveSlotCount() + count > effectiveLimit) return null;
	return new SpawnSlotLease(count);
}

export function getLiveSlotCount(): number {
	let count = 0;
	for (const lease of liveLeases) count += lease.held;
	return count;
}

/** Hands `lease` to `owner`; the owner's release gives back that lease only. */
export function claimSpawnWidthSlot(owner: SlotOwner, lease: SpawnSlotLease): void {
	owner.spawnWidthSlotAcquired = true;
	slotOwners.set(owner, lease);
}

export function releaseSpawnWidthSlot(owner: SlotOwner): void {
	const lease = slotOwners.get(owner);
	if (!lease) return;
	slotOwners.delete(owner);
	owner.spawnWidthSlotAcquired = false;
	lease.release();
}

export function releaseSpawnWidthSlotOnCompletion<T>(owner: SlotOwner, promise: Promise<T>): Promise<T> {
	return promise.finally(() => releaseSpawnWidthSlot(owner));
}

export function resetSpawnWidthForTest(): void {
	for (const owner of slotOwners.keys()) owner.spawnWidthSlotAcquired = false;
	slotOwners.clear();
	for (const lease of [...liveLeases]) lease.release();
	configuredWidth = undefined;
}
