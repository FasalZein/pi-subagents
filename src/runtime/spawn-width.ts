import { SUBAGENT_WAIT_TOOL_NAME } from "../tools/tool-names.ts";

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

type SlotOwner = { id: string; spawnWidthSlotAcquired?: boolean };

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

/** Run ids of the runs that hold slots now, in claim order. A launch that is still starting holds slots under no run id. */
function getSlotHolderRunIds(): string[] {
	return [...slotOwners.keys()].map((owner) => owner.id);
}

const AUTO_EXIT_PANE_NOTE = "Interactive children with auto-exit: false keep their slot until the pane closes.";

/** T89b: the one call that returns when a slot frees; without known holders it waits on every running run. */
function waitAnyCall(runIds: readonly string[]): string {
	if (runIds.length === 0) return `${SUBAGENT_WAIT_TOOL_NAME}({ mode: "any" })`;
	return `${SUBAGENT_WAIT_TOOL_NAME}({ runIds: [${runIds.join(", ")}], mode: "any" })`;
}

function quotedHolderIds(): string[] {
	return getSlotHolderRunIds().map((id) => JSON.stringify(id));
}

function busySlots(limit: number): string {
	const ids = getSlotHolderRunIds();
	const holders = ids.length > 0 ? `, held by ${ids.join(", ")}` : "";
	return `${getLiveSlotCount()}/${limit} slots busy${holders}`;
}

/** D9/T89b: a launch or resume that finds every slot busy is refused with the wait call that frees one. */
export function renderSpawnWidthBusyRefusal(limit: number): string {
	return `Spawn width limit reached (${busySlots(limit)}). Next call: ${waitAnyCall(quotedHolderIds())}, then launch again; or use subagent_kill on a running run to free a slot. ${AUTO_EXIT_PANE_NOTE}`;
}

/** D9/T89b: a batch wider than the limit is refused with how many children fit now and the wait call for the rest. */
export function renderBatchWidthRefusal(count: number, limit: number): string {
	const head = `Error: batch of ${count} subagents exceeds the spawn width limit of ${limit}.`;
	const free = Math.max(0, limit - getLiveSlotCount());
	if (free === 0) {
		return `${head} None fit now (${busySlots(limit)}). Next call: ${waitAnyCall(quotedHolderIds())}, then launch the children that fit. ${AUTO_EXIT_PANE_NOTE}`;
	}
	const wait = waitAnyCall([...quotedHolderIds(), "<the runIds that launch returns>"]);
	return `${head} ${free} fit now: launch ${free} of them, then call ${wait} and launch the rest when it returns. ${AUTO_EXIT_PANE_NOTE}`;
}

export function resetSpawnWidthForTest(): void {
	for (const owner of slotOwners.keys()) owner.spawnWidthSlotAcquired = false;
	slotOwners.clear();
	for (const lease of [...liveLeases]) lease.release();
	configuredWidth = undefined;
}
