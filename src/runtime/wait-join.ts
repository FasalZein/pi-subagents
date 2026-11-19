import type { RunningSubagent, SubagentResult } from "../types.ts";
import { queuedRunEnd, queuedRunEndIds, settleWaitReply } from "./delivery-queue.ts";
import type { ResultStore } from "./result-files.ts";
import { parseRunId, type ResultRecord } from "./result-record.ts";
import { lookUpRecord, noRecordText, renderLookup } from "./run-lookup.ts";
import { completedSubagentResults, runningSubagents } from "./state.ts";
import { dropRunEndHold, holdRunEnd } from "./wait-holds.ts";
import { getSubagentWaitSuccessResult } from "./wait-result.ts";

type WaitMode = "all" | "any";

interface JoinParams {
	/** Run ids or names; none means every run of this parent that is running or queued. */
	ids?: readonly string[];
	mode?: WaitMode;
	/** Seconds; none means no limit. */
	timeout?: number;
}

/**
 * One ended run in a wait reply: the same rendering a message carries, and the run's published
 * record (D13), or null when the run published none (a launch that failed before it reserved one).
 * T67: runId and name are the launch children's field names, so a script joins the two by runId.
 */
export interface JoinedResult {
	runId: string;
	/** The run's launch name. */
	name: string;
	text: string;
	record: ResultRecord | null;
}

export interface MissingRun {
	/** The requested run id or name that matched no run. */
	runId: string;
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

/**
 * An ended run: queued (the wait takes it, D15) or already delivered (a lookup, D16, which changes
 * no state: no queue take, no release).
 */
type Target = { kind: "active"; running: RunningSubagent } | { kind: "ended"; result: JoinedResult; lookup: boolean };

/** This parent session's results, for the record of an ended run and for a lookup's rendering. */
interface SessionResults {
	store: ResultStore;
	/** The parent's working directory, for the report locator of a rendered record. */
	cwd: string;
}

/** Seconds to milliseconds for the time limit. */
const MS_PER_SECOND = 1000;

/** Where an ended run's record is read: the run's own store first, then this parent session's. */
interface RecordSources {
	runStore?: ResultStore;
	sessionStore?: ResultStore;
	/** The published run id the run's end names, when the caller has it. */
	runId?: string;
}

function readRecord(runId: string | undefined, sources: RecordSources): ResultRecord | null {
	if (!runId) return null;
	let id: ReturnType<typeof parseRunId>;
	try {
		id = parseRunId(runId);
	} catch {
		return null;
	}
	return sources.runStore?.read(id) ?? sources.sessionStore?.read(id) ?? null;
}

/** `name` is the launch name when the caller has the running run. */
function snapshotEnd(id: string, sources: RecordSources, name?: string): JoinedResult {
	// The text is the rendering the message path would carry (D14); the record is the published one.
	const queued = queuedRunEnd(id);
	const cached = completedSubagentResults.get(id);
	const queuedRunId = typeof queued?.details.runId === "string" ? queued.details.runId : undefined;
	const queuedName = typeof queued?.details.name === "string" ? queued.details.name : undefined;
	const record = readRecord(sources.runId ?? cached?.resultRunId ?? queuedRunId, sources);
	// Parent-owned names first (a queued ping's sidecar name can be missing or differ); the id is the last resort.
	const ended = { runId: id, name: name ?? cached?.name ?? record?.name ?? queuedName ?? id, record };
	if (queued) return { ...ended, text: queued.content };
	if (cached) {
		const reply = getSubagentWaitSuccessResult(cached);
		return { ...ended, text: reply.content.map((block) => block.text).join("\n\n") };
	}
	return { ...ended, text: `Sub-agent "${id}" ended without a result.` };
}

/**
 * D16 and D18: the runs this parent may receive. A verified run this session only observes is not
 * one; it fails closed, so a verified run counts only when it says that this session is a recipient.
 */
function receivableRuns(): RunningSubagent[] {
	return [...runningSubagents.values()].filter(
		(running) => running.verifiedRunId === undefined || running.verifiedRunCancelDenied === false,
	);
}

function resolveTarget(query: string, session: SessionResults | undefined): Target | MissingRun {
	const sessionStore = session?.store;
	const receivable = receivableRuns();
	// An active run comes first, by id or by name: a named run that still runs takes part (D16).
	const byId = receivable.find((running) => running.id === query);
	if (byId) return { kind: "active", running: byId };
	const [named, ...others] = receivable.filter((running) => running.name === query);
	if (named && others.length === 0) return { kind: "active", running: named };
	if (named) return { runId: query, error: `Multiple running subagents match "${query}". Use the id instead.` };
	if (queuedRunEnd(query)) return { kind: "ended", result: snapshotEnd(query, { sessionStore }), lookup: false };
	// An ended run this process still knows, by id only (D16): a lookup returns its rendering.
	if (completedSubagentResults.has(query))
		return { kind: "ended", result: snapshotEnd(query, { sessionStore }), lookup: true };
	// After a reload, a restart or a compaction: the record file, or the record kept in memory (D13).
	const record = lookUpRecord(sessionStore, query);
	if (record && session) {
		const text = renderLookup(session.store, record, session.cwd);
		return { kind: "ended", result: { runId: query, name: record.name, text, record }, lookup: true };
	}
	return { runId: query, error: noRecordText(sessionStore, query) };
}

function defaultIds(): string[] {
	return [...new Set([...receivableRuns().map((running) => running.id), ...queuedRunEndIds()])];
}

/**
 * D15 and R4 for a wait of many runs: every run end that a running wait holds stays in the
 * delivery queue. A returned reply takes the ends it carries; an interrupted wait gives back each
 * end that no other wait still holds, and the queue sends it as a message.
 */
export async function joinRuns(
	params: JoinParams,
	signal?: AbortSignal,
	session?: SessionResults,
): Promise<JoinOutcome> {
	const sessionStore = session?.store;
	const mode = params.mode ?? "all";
	const ids = params.ids && params.ids.length > 0 ? params.ids : defaultIds();
	const missing: MissingRun[] = [];
	const results = new Map<string, JoinedResult>();
	/** Already delivered runs in this reply: copies by lookup that settle nothing (D16). */
	const lookups = new Set<string>();
	const active: RunningSubagent[] = [];
	/** T67: the reply order, the order of the requested ids (with no ids: running runs in launch order, then queued ends). */
	const order: string[] = [];
	for (const query of ids) {
		const target = resolveTarget(query, session);
		if (!("kind" in target)) missing.push(target);
		else if (target.kind === "ended") {
			results.set(target.result.runId, target.result);
			if (!order.includes(target.result.runId)) order.push(target.result.runId);
			if (target.lookup) lookups.add(target.result.runId);
		} else if (!active.includes(target.running)) {
			active.push(target.running);
			if (!order.includes(target.running.id)) order.push(target.running.id);
		}
	}
	if (active.length === 0 && results.size === 0) return { status: "empty", results: [], pending: [], missing };

	const holds = new Map(active.map((running) => [running.id, holdRunEnd(running.id)]));
	let wake = () => {};
	for (const running of active) {
		const ended = (result?: SubagentResult) => {
			// The router ran first (it was wired at launch), so the end is held in the queue now.
			if (!holds.has(running.id)) return;
			const sources = { runStore: running.resultTarget?.store, sessionStore, runId: result?.resultRunId };
			results.set(running.id, snapshotEnd(running.id, sources, running.name));
			wake();
		};
		(running.completionPromise ?? new Promise<never>(() => {})).then(ended, () => ended());
	}
	const isMet = () => (mode === "any" ? results.size > 0 : active.every((running) => results.has(running.id)));

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
	const reply = order.flatMap((id) => results.get(id) ?? []);
	const settled = reply.filter((result) => !lookups.has(result.runId));
	const pending = active.filter((running) => !results.has(running.id)).map((running) => running.id);
	const stillHeld = new Set<string>();
	for (const [id, token] of holds) {
		holds.delete(id);
		if (dropRunEndHold(id, token)) stillHeld.add(id);
	}
	if (status === "interrupted") {
		// Another wait that still holds an end delivers it when it returns (or gives it back).
		settleWaitReply(
			settled.map((result) => result.runId).filter((id) => !stillHeld.has(id)),
			[],
			signal,
		);
		// Only runs that still run report later; an end another wait holds is delivered by that wait.
		return { status, results: [], pending, missing };
	}
	// Every returned result carries its report; a copy by lookup settles nothing (D16).
	const settledIds = settled.map((result) => result.runId);
	settleWaitReply(settledIds, settledIds);
	return { status, results: reply, pending, missing };
}
