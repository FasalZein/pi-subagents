import type { RunningSubagent } from "../types.ts";
import { queuedRunEnd, queuedRunEndIds, settleWaitReply } from "./delivery-queue.ts";
import { findTrackedSubagent } from "./running-registry.ts";
import { completedSubagentResults, runningSubagents } from "./state.ts";
import { dropRunEndHold, holdRunEnd } from "./wait-holds.ts";
import { getSubagentWaitSuccessResult } from "./wait-result.ts";

export type WaitMode = "all" | "any";

export interface JoinParams {
	/** Run ids or names; none means every run of this parent that is running or queued. */
	ids?: readonly string[];
	mode?: WaitMode;
	/** Seconds; none means no limit. */
	timeout?: number;
}

/** One ended run in a wait reply: the same rendering a message carries, and its record. */
export interface JoinedResult {
	id: string;
	text: string;
	record: Record<string, unknown>;
}

export interface MissingRun {
	id: string;
	error: string;
}

/**
 * D16: a wait returns when its mode is met (complete), when its time limit passes (timeout), at
 * once when there is nothing to wait for (empty), or stops on Esc (interrupted). An interrupted
 * wait returns no results: its runs keep running and every end it took goes out as a message.
 */
export type JoinOutcome =
	| { status: "complete" | "timeout" | "empty"; results: JoinedResult[]; pending: string[]; missing: MissingRun[] }
	| { status: "interrupted"; results: []; pending: string[]; missing: MissingRun[] };

type Target = { kind: "active"; running: RunningSubagent } | { kind: "ended"; result: JoinedResult };

/** Seconds to milliseconds for the time limit. */
const MS_PER_SECOND = 1000;

function snapshotEnd(id: string): JoinedResult {
	// A held or queued run end is the rendering the message path would carry (D14).
	const queued = queuedRunEnd(id);
	if (queued) {
		const status = queued.customType === "subagent_ping" ? "pinged" : queued.details.status;
		return { id, text: queued.content, record: { ...queued.details, status, deliveryState: "awaited" } };
	}
	const cached = completedSubagentResults.get(id);
	if (cached) {
		const reply = getSubagentWaitSuccessResult(cached);
		return { id, text: reply.content[0]!.text, record: reply.details };
	}
	return { id, text: `Sub-agent "${id}" ended without a result.`, record: { id, status: "failed" } };
}

function resolveTarget(query: string): Target | MissingRun {
	// An active run comes first, by id or by name: a named run that still runs takes part (D16).
	const byId = runningSubagents.get(query);
	if (byId) return { kind: "active", running: byId };
	const byName = [...runningSubagents.values()].filter((running) => running.name === query);
	if (byName.length === 1) return { kind: "active", running: byName[0]! };
	if (byName.length > 1) return { id: query, error: `Multiple running subagents match "${query}". Use the id instead.` };
	if (queuedRunEnd(query)) return { kind: "ended", result: snapshotEnd(query) };
	const match = findTrackedSubagent(query);
	if (match.cached) return { kind: "ended", result: snapshotEnd(match.cached.id) };
	if (match.error) return { id: query, error: match.error };
	return { id: query, error: `No result record for "${query}".` };
}

function defaultIds(): string[] {
	return [...new Set([...runningSubagents.keys(), ...queuedRunEndIds()])];
}

/**
 * D15 and R4 for a wait of many runs: every run end that a running wait holds stays in the
 * delivery queue. A returned reply takes the ends it carries; an interrupted wait gives back each
 * end that no other wait still holds, and the queue sends it as a message.
 */
export async function joinRuns(params: JoinParams, signal?: AbortSignal): Promise<JoinOutcome> {
	const mode = params.mode ?? "all";
	const ids = params.ids && params.ids.length > 0 ? params.ids : defaultIds();
	const missing: MissingRun[] = [];
	const results = new Map<string, JoinedResult>();
	const active: RunningSubagent[] = [];
	for (const query of ids) {
		const target = resolveTarget(query);
		if (!("kind" in target)) missing.push(target);
		else if (target.kind === "ended") results.set(target.result.id, target.result);
		else if (!active.includes(target.running)) active.push(target.running);
	}
	if (active.length === 0 && results.size === 0) return { status: "empty", results: [], pending: [], missing };

	const holds = new Map(active.map((running) => [running.id, holdRunEnd(running.id)]));
	let wake = () => {};
	for (const running of active) {
		const ended = () => {
			// The router ran first (it was wired at launch), so the end is held in the queue now.
			if (!holds.has(running.id)) return;
			results.set(running.id, snapshotEnd(running.id));
			wake();
		};
		(running.completionPromise ?? new Promise<never>(() => {})).then(ended, ended);
	}
	const isMet = () =>
		mode === "any" ? results.size > 0 : active.every((running) => results.has(running.id));

	let status: "complete" | "timeout" | "interrupted" = "complete";
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort = () => {};
	try {
		const stop = new Promise<"timeout" | "interrupted">((resolve) => {
			if (params.timeout !== undefined && params.timeout >= 0)
				timer = setTimeout(() => resolve("timeout"), params.timeout * MS_PER_SECOND);
			onAbort = () => resolve("interrupted");
			if (signal?.aborted) onAbort();
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		while (!signal?.aborted && !isMet()) {
			const changed = new Promise<"changed">((resolve) => {
				wake = () => resolve("changed");
			});
			const next = await Promise.race([changed, stop]);
			if (next !== "changed") {
				status = next;
				break;
			}
			// Ends of one moment return together: let sibling ends of this tick arrive first.
			if (mode === "any") await new Promise((resolve) => setImmediate(resolve));
		}
		if (signal?.aborted) status = "interrupted";
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}

	// Freeze the reply, then end this wait's holds before the queue is settled.
	const reply = [...results.values()];
	const pending = active.filter((running) => !results.has(running.id)).map((running) => running.id);
	const stillHeld = new Set<string>();
	for (const [id, token] of holds) {
		holds.delete(id);
		if (dropRunEndHold(id, token)) stillHeld.add(id);
	}
	if (status === "interrupted") {
		// Another wait that still holds an end delivers it when it returns (or gives it back).
		settleWaitReply(
			reply.map((result) => result.id).filter((id) => !stillHeld.has(id)),
			[],
			signal,
		);
		return { status, results: [], pending: ids.filter((id) => !missing.some((m) => m.id === id)), missing };
	}
	settleWaitReply(
		reply.map((result) => result.id),
		reply.map((result) => ({ details: { id: result.id } })),
	);
	return { status, results: reply, pending, missing };
}
