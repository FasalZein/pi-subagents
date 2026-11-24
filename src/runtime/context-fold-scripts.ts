import { CONTEXT_FOLD_ENTRY, CONTEXT_FOLD_LAUNCH_ENTRY, isRecord, str } from "./context-fold-set.ts";

/**
 * Codemode launch scripts in the settle fold (owner rule 2026-11-23T11:58Z). A script folds only as
 * a whole, and only when it is launch-only: Pi's nested-call record of the script is complete, holds
 * only subagent calls that all succeeded, and every run its subagent calls started
 * is folded. The settle that folds a script freezes the decision in its fold entry by the script's
 * occurrence (outer tool-call id and the assistant message time), so a later entry or a reused id
 * cannot unfold it or change the prefix mid-turn. Any other script stays byte-identical.
 */

/** A folded script occurrence and the runs its stub names. */
export interface FoldedScript {
	callId: string;
	/** The timestamp of the assistant message that holds the call: one occurrence of a reused id. */
	at: number;
	runIds: string[];
}

const LAUNCH_ONLY_TOOLS: ReadonlySet<string> = new Set(["subagent"]);

/** The key of one script occurrence in a fold entry and in a provider message. */
export function scriptKey(callId: string, at: unknown): string | undefined {
	return typeof at === "number" ? `${callId}@${at}` : undefined;
}

/** The frozen script decisions of every fold entry on this branch. */
export function readFoldedScripts(entries: readonly unknown[]): Map<string, FoldedScript> {
	const scripts = new Map<string, FoldedScript>();
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CONTEXT_FOLD_ENTRY) continue;
		const list = isRecord(entry.data) && Array.isArray(entry.data.scripts) ? entry.data.scripts : [];
		for (const script of list) {
			if (!isRecord(script) || !str(script.callId) || !Array.isArray(script.runIds)) continue;
			const key = scriptKey(script.callId as string, script.at);
			if (key && !scripts.has(key)) scripts.set(key, script as unknown as FoldedScript);
		}
	}
	return scripts;
}

function message(entry: unknown): Record<string, unknown> | undefined {
	return isRecord(entry) && entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
}

/**
 * The run ids of one script occurrence when it is launch-only, else undefined. The launch entries
 * of its nested subagent calls sit between the call's assistant entry and its result entry: Pi
 * appends them while the script runs, before it commits the script's result.
 */
function launchOnlyRuns(entries: readonly unknown[], callIndex: number, callId: string): string[] | undefined {
	let resultIndex = -1;
	for (let i = callIndex + 1; i < entries.length; i++) {
		const m = message(entries[i]);
		if (m?.role === "assistant") break;
		if (m?.role === "toolResult" && m.toolCallId === callId) {
			resultIndex = i;
			break;
		}
	}
	const result = message(entries[resultIndex]);
	if (!result || result.isError === true) return undefined;
	const record = isRecord(result.nestedCalls) ? result.nestedCalls : undefined;
	if (!record || record.complete !== true || !Array.isArray(record.calls)) return undefined;
	const launches = new Map<string, string[]>();
	for (let i = callIndex + 1; i < resultIndex; i++) {
		const entry = entries[i];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CONTEXT_FOLD_LAUNCH_ENTRY) continue;
		const data = isRecord(entry.data) ? entry.data : {};
		const nestedId = str(data.nestedId);
		if (data.callId !== callId || !nestedId || !Array.isArray(data.runIds)) continue;
		// Two entries for one nested id: no guess.
		if (launches.has(nestedId)) return undefined;
		launches.set(
			nestedId,
			data.runIds.filter((id): id is string => typeof id === "string" && id.length > 0),
		);
	}
	const runIds: string[] = [];
	let launched = 0;
	for (const call of record.calls) {
		if (!isRecord(call) || call.status !== "ok" || typeof call.name !== "string") return undefined;
		if (!LAUNCH_ONLY_TOOLS.has(call.name)) return undefined;
		if (call.name !== "subagent") continue;
		const ids = typeof call.id === "string" ? launches.get(call.id) : undefined;
		if (!ids || ids.length === 0) return undefined;
		launched++;
		runIds.push(...ids);
	}
	return launched > 0 ? runIds : undefined;
}

/** The launch-only scripts this settle folds: every run they started is folded. Already frozen ones are left out. */
export function settleScripts(entries: readonly unknown[], isFolded: (id: string) => boolean): FoldedScript[] {
	const frozen = readFoldedScripts(entries);
	const scripts: FoldedScript[] = [];
	entries.forEach((entry, index) => {
		const m = message(entry);
		if (m?.role !== "assistant" || !Array.isArray(m.content)) return;
		for (const block of m.content) {
			if (!isRecord(block) || block.type !== "toolCall" || block.name !== "codemode") continue;
			const callId = str(block.id);
			const key = callId && scriptKey(callId, m.timestamp);
			if (!callId || !key || frozen.has(key)) continue;
			const runIds = launchOnlyRuns(entries, index, callId);
			if (runIds?.every(isFolded)) scripts.push({ callId, at: m.timestamp as number, runIds });
		}
	});
	return scripts;
}
