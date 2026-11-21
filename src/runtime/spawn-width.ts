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

/** Run ids of the runs that hold slots now, in claim order. Each one is registered, so subagent_wait can wait for it. */
function getSlotHolderRunIds(): string[] {
	return [...slotOwners.keys()].map((owner) => owner.id);
}

/** Slots held by a launch that is still starting: reserved, but not yet claimed by a run with an id. */
function getStartingSlotCount(): number {
	let claimed = 0;
	for (const lease of slotOwners.values()) claimed += lease.held;
	return getLiveSlotCount() - claimed;
}

/** How many leading children fit in `free` slots, and the slots they take. */
function fittingPrefix(slotCosts: readonly number[], free: number): { count: number; slots: number } {
	let slots = 0;
	let count = 0;
	for (const cost of slotCosts) {
		if (slots + cost > free) break;
		slots += cost;
		count++;
	}
	return { count, slots };
}

const plural = (count: number, noun: string, many = `${noun}s`) => `${count} ${count === 1 ? noun : many}`;

const AUTO_EXIT_PANE_NOTE = "Interactive children with auto-exit: false keep their slot until the pane closes.";

/** The refused tool: a launch retries with the children not started yet, a resume retries the same resume. */
export type WidthRefusedCall = "subagent" | "subagent_resume";

/**
 * D9/T89b: the refusal of a launch or resume that the spawn width does not admit. Every step it
 * names works when a parent follows it literally: the fit-now count uses the same slot costs as
 * admission, the wait call names only runs that subagent_wait can wait for (never a launch that is
 * still starting), and one wait is never promised to admit the rest.
 */
export function renderSpawnWidthRefusal(call: WidthRefusedCall, slotCosts: readonly number[], limit: number): string {
	const live = getLiveSlotCount();
	const holders = getSlotHolderRunIds();
	const starting = getStartingSlotCount();
	const head =
		call === "subagent" && slotCosts.length > limit
			? `Error: batch of ${slotCosts.length} subagents exceeds the spawn width limit of ${limit}.`
			: `Spawn width limit reached (${live}/${limit} slots busy${holders.length > 0 ? `, held by ${holders.join(", ")}` : ""}).`;
	const firstCost = slotCosts[0] ?? 0;
	if (firstCost > limit) {
		const subject = slotCosts.length === 1 ? `This ${call === "subagent" ? "child" : "resume"}` : "The first child";
		return `${head} ${subject} needs ${plural(firstCost, "slot")}, more than the whole limit of ${limit}, so no wait admits it. Nothing started.`;
	}
	const parts = [head, "Nothing started."];
	const fit = fittingPrefix(slotCosts, Math.max(0, limit - live));
	if (fit.count > 0) {
		parts.push(
			`The first ${plural(fit.count, "child", "children")} (${plural(fit.slots, "slot")}) ${fit.count === 1 ? "fits" : "fit"} now: call subagent with only ${fit.count === 1 ? "that child" : "those children"}.`,
		);
	}
	const then = fit.count > 0 ? "Then call" : "Next call:";
	if (holders.length > 0) {
		parts.push(
			`${then} ${SUBAGENT_WAIT_TOOL_NAME}({ runIds: ${JSON.stringify(holders)}, mode: "any" }); it returns when one of these runs ends and frees its slots.`,
		);
	} else if (fit.count > 0) {
		parts.push(`Then call ${SUBAGENT_WAIT_TOOL_NAME} with mode "any" and the runIds of that launch reply.`);
	}
	if (starting > 0) {
		const retry = holders.length > 0 || fit.count > 0 ? "Or retry" : "Retry";
		parts.push(
			`${plural(starting, "slot")} ${starting === 1 ? "is" : "are"} held by a launch that is still starting; it has no run id yet, so ${SUBAGENT_WAIT_TOOL_NAME} cannot wait for it. ${retry} the refused call after that launch replies.`,
		);
	}
	if (holders.length > 0 || fit.count > 0) {
		const retry =
			call === "subagent"
				? "call subagent again with the children that have not started, at most as many as fit then"
				: "call subagent_resume again";
		parts.push(`When the wait returns, ${retry}; repeat while it is refused.`);
	}
	if (holders.length > 0) parts.push("Or free a slot with subagent_kill on one of these runs.");
	parts.push(AUTO_EXIT_PANE_NOTE);
	return parts.join(" ");
}

export function resetSpawnWidthForTest(): void {
	for (const owner of slotOwners.keys()) owner.spawnWidthSlotAcquired = false;
	slotOwners.clear();
	for (const lease of [...liveLeases]) lease.release();
	configuredWidth = undefined;
}
