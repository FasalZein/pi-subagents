import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { getOwnedHistoryStartIndex } from "../session/session-files.ts";
import { isVerifiedReportPath } from "../vf/run/winner-store.ts";
import { isFinishedStatus, runEnds } from "./run-end-message.ts";

/**
 * The fold set of the settle fold (see context-fold.ts): which runs fold, decided only at a settle
 * and kept as durable session entries. Principle (owner, no regressions): when a run cannot be
 * proven safe to fold, it stays full.
 */
export const CONTEXT_FOLD_ENTRY = "subagent_context_fold";
/** The run ids one nested subagent call of a codemode script started (no task text). */
export const CONTEXT_FOLD_LAUNCH_ENTRY = "subagent_context_fold_launch";
/**
 * The run ids whose finished result one nested launch, resume or wait call of a codemode script took
 * (fold-waits S5, D4; owner rule 2026-11-23T11:58Z: run ids only). No result message follows such a
 * call, so this entry is the run's commit; it counts only when Pi's final record of the script's
 * successful result names the nested call as ok. The stub facts come from the run's record at settle.
 */
export const CONTEXT_FOLD_NESTED_ENTRY = "subagent_context_fold_nested";

/** The facts a stub names; fixed at the settle that folds the run, so every later stub is the same text. */
export interface FoldedRun {
	id: string;
	name: string;
	outcome: string;
	/** The saved report; a run folds only when this file exists at the settle. */
	report: string;
	/**
	 * Epoch ms of the settle that folded the run, kept as a fact only. Which messages fold follows
	 * branch order, not this time (a clock correction must not fold an unseen reply): readFoldOrder.
	 */
	foldedAt: number;
}

type Rec = Record<string, unknown>;

export function isRecord(value: unknown): value is Rec {
	return typeof value === "object" && value !== null;
}

export function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A child's transcript (a tracked child, or a forked child reopened as a plain session) holds the
 * launch metadata marker; such a session never folds, even without PI_SUBAGENT_SESSION.
 */
export function isChildTranscript(entries: readonly unknown[]): boolean {
	return (
		Boolean(process.env.PI_SUBAGENT_SESSION) ||
		getOwnedHistoryStartIndex(entries as ReadonlyArray<{ type?: unknown; customType?: unknown }>) > 0
	);
}

/**
 * A verified fan-out run or a provenance notice: never folded (owner-rules 2026-11-18T17:56Z). An
 * adopted delivery carries verifiedRunId; a waited launch, a join item and a lookup of a verified
 * winner carry only its report path, which lies in the run's generation folder.
 */
export function isVerifiedOrNotice(details: Rec): boolean {
	if (details.provenance === true || details.verifiedRunId !== undefined) return true;
	const report = reportPath(details);
	return report !== undefined && isVerifiedReportPath(report);
}

/**
 * The digest of the one text block a waited launch, resume or join reply was built with, kept in
 * its details (fold-waits review round 1). Another extension's tool_result handler can change the
 * content but leave the details: a reply folds only while its text still has this digest.
 */
export function replyDigest(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export type RunFacts = { id: string; name?: string; outcome?: string; report?: string };

/** The saved report path: reportFile of a run end or launch reply, record.report.path of a wait reply. */
function reportPath(details: Rec): string | undefined {
	const record = isRecord(details.record) ? details.record : undefined;
	const report = record && isRecord(record.report) ? record.report : undefined;
	return str(details.reportFile) ?? (report?.saved === true ? str(report.path) : undefined);
}

export function runFacts(id: string, details: Rec): RunFacts {
	const record = isRecord(details.record) ? details.record : {};
	return {
		id,
		name: str(details.name) ?? str(record.name),
		outcome: str(details.outcome) ?? str(record.outcome) ?? str(details.status),
		report: reportPath(details),
	};
}

/**
 * The run ends of a result message, or undefined when any member is unidentified, verified or a
 * notice: such a message never folds, as a whole.
 */
export function messageRunIds(customType: unknown, content: unknown, details: unknown): string[] | undefined {
	const ends = runEnds(customType, content, details);
	if (ends.length === 0) return undefined;
	const members = isRecord(details) && Array.isArray(details.results) ? details.results.length : 1;
	if (ends.length !== members) return undefined;
	const ids: string[] = [];
	for (const end of ends) {
		const id = str(end.details.id);
		if (!id || isVerifiedOrNotice(end.details)) return undefined;
		ids.push(id);
	}
	return ids;
}

/**
 * The runs whose finished result a launch or resume reply delivered, or a subagent_wait reply holds
 * (compatibility: old sessions hold replies of the wait tool the fork had until 2026-11-24),
 * read from the reply's details (a direct reply in the session, a nested one in its tool_result
 * event). A started (detached) resume and an interrupted one carry no finished status: none.
 * A verified run or provenance notice is left out: it never folds.
 */
export function replyRunFacts(toolName: unknown, details: unknown): RunFacts[] {
	if (!isRecord(details)) return [];
	const listed =
		toolName === "subagent" || toolName === "subagent_resume"
			? (Array.isArray(details.children) ? details.children : [details]).filter(
					(child) => isRecord(child) && isFinishedStatus(str(child.status)),
				)
			: toolName === "subagent_wait" && Array.isArray(details.results)
				? details.results
				: [];
	return listed.flatMap((item) => {
		if (!isRecord(item) || isVerifiedOrNotice(item)) return [];
		const id = str(item.id) ?? str(item.runId);
		return id ? [runFacts(id, item)] : [];
	});
}

/**
 * The runs whose finished result one committed session entry carries: a subagent_result or
 * subagent_ping message, or a direct launch, resume or wait reply (replyRunFacts).
 */
function committedResults(entry: unknown): RunFacts[] {
	if (!isRecord(entry)) return [];
	if (entry.type === "custom_message") {
		if (!messageRunIds(entry.customType, entry.content, entry.details)) return [];
		return runEnds(entry.customType, entry.content, entry.details).map((end) =>
			runFacts(end.details.id as string, end.details),
		);
	}
	const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
	if (message?.role !== "toolResult") return [];
	return replyRunFacts(message.toolName, message.details);
}

/** One nested call that took finished runs, parsed from its entry in the session file. */
type NestedTake = { callId: string; nestedId: string; runIds: string[] };

function nestedTake(entry: unknown): NestedTake | undefined {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CONTEXT_FOLD_NESTED_ENTRY) return;
	const data = isRecord(entry.data) ? entry.data : {};
	const callId = str(data.callId);
	const nestedId = str(data.nestedId);
	if (!callId || !nestedId || !Array.isArray(data.runIds)) return;
	return {
		callId,
		nestedId,
		runIds: data.runIds.filter((id): id is string => typeof id === "string" && id.length > 0),
	};
}

/**
 * The nested call ids that Pi finalized as ok in a codemode script's result, or undefined when the
 * result is not a successful script result: another tool, an error, or no explicit isError false.
 * Pi writes a nested call's final status after every tool_result handler ran, so a later handler
 * that turned the call into an error shows here, even when the script caught it.
 */
function finalizedOkCalls(message: Rec): Set<string> | undefined {
	if (message.toolName !== "codemode" || message.isError !== false) return;
	const record = isRecord(message.nestedCalls) ? message.nestedCalls : undefined;
	if (!record || !Array.isArray(record.calls)) return;
	const ok = new Set<string>();
	for (const call of record.calls) {
		if (isRecord(call) && call.status === "ok" && typeof call.id === "string") ok.add(call.id);
	}
	return ok;
}

/**
 * The runs each entry commits, by branch index. A nested-take entry sits before its script's result
 * (Pi appends it while the script runs): its runs commit at the script's result entry, only when that
 * is a successful codemode result whose final nested record names the call as ok. Their facts come
 * from `recordFacts` (the run's record); an unreadable record gives no report, so the run stays full.
 * A script without a committed result commits nothing; an assistant message ends the wait for it.
 */
function commitsByIndex(
	entries: readonly unknown[],
	recordFacts: (id: string) => RunFacts | undefined,
): Array<{ index: number; isMessage: boolean; facts: RunFacts[] }> {
	const commits: Array<{ index: number; isMessage: boolean; facts: RunFacts[] }> = [];
	let nested = new Map<string, NestedTake[]>();
	entries.forEach((entry, index) => {
		const message = isRecord(entry) && entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
		if (message?.role === "assistant") nested = new Map();
		const take = nestedTake(entry);
		if (take) nested.set(take.callId, [...(nested.get(take.callId) ?? []), take]);
		const facts = committedResults(entry);
		if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
			const takes = nested.get(message.toolCallId) ?? [];
			nested.delete(message.toolCallId);
			const ok = takes.length > 0 ? finalizedOkCalls(message) : undefined;
			for (const { nestedId, runIds } of takes) {
				if (!ok?.has(nestedId)) continue;
				facts.push(...runIds.map((id) => recordFacts(id) ?? { id }));
			}
		}
		if (facts.length > 0) commits.push({ index, isMessage: isRecord(entry) && entry.type === "custom_message", facts });
	});
	return commits;
}

/** Each folded run with the branch index of the last fold entry that names it; a later entry wins. */
function scanFoldEntries(entries: readonly unknown[]): Map<string, { run: FoldedRun; index: number }> {
	const folded = new Map<string, { run: FoldedRun; index: number }>();
	entries.forEach((entry, index) => {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CONTEXT_FOLD_ENTRY) return;
		const runs = isRecord(entry.data) && Array.isArray(entry.data.runs) ? entry.data.runs : [];
		for (const run of runs) {
			if (isRecord(run) && typeof run.id === "string" && typeof run.foldedAt === "number") {
				folded.set(run.id, { run: run as unknown as FoldedRun, index });
			}
		}
	});
	return folded;
}

/** The fold set: every run that a fold entry on this branch names. */
export function readFoldedRuns(entries: readonly unknown[]): Map<string, FoldedRun> {
	return new Map([...scanFoldEntries(entries)].map(([id, { run }]) => [id, run]));
}

/**
 * The key of one result message or tool result, the same for its session entry and for the message
 * Pi builds from it (a custom message gets its entry's time in epoch ms).
 */
function occurrenceKey(message: Rec): string | undefined {
	if (message.role === "toolResult" && typeof message.toolCallId === "string") {
		return `tool:${message.toolCallId}@${String(message.timestamp)}`;
	}
	if (message.role === "custom" && typeof message.customType === "string") {
		return `custom:${message.customType}@${String(message.timestamp)}`;
	}
	return undefined;
}

/**
 * Whether a run's copy in one message was used before its fold, by branch order: the message's entry
 * lies before the last fold entry that names the run. A settle folds a run only when a completed
 * request saw its latest commit, so every earlier copy was seen too; a copy after that entry (a new
 * lookup) stays full until a later settle names the run again. Fold entries only append, so a folded
 * copy never comes back, whatever the clock says. A key seen twice takes its later entry.
 */
export function readFoldOrder(entries: readonly unknown[]): (message: Rec, runId: string) => boolean {
	const position = new Map<string, number>();
	entries.forEach((entry, index) => {
		if (!isRecord(entry)) return;
		const message =
			entry.type === "message" && isRecord(entry.message)
				? entry.message
				: entry.type === "custom_message"
					? { role: "custom", customType: entry.customType, timestamp: new Date(entry.timestamp as string).getTime() }
					: undefined;
		const key = message && occurrenceKey(message);
		if (key) position.set(key, index);
	});
	const lastFold = scanFoldEntries(entries);
	return (message, runId) => {
		const key = occurrenceKey(message);
		const at = key === undefined ? undefined : position.get(key);
		return at !== undefined && at < (lastFold.get(runId)?.index ?? -1);
	};
}

/** A provider request that completed: an errored or aborted one is no proof that the model read anything. */
function isCompletedRequest(entry: unknown): boolean {
	if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return false;
	const { role, stopReason } = entry.message;
	return role === "assistant" && stopReason !== "error" && stopReason !== "aborted";
}

/**
 * The runs to fold at this settle: a run ended, a message with its finished result was committed,
 * a later completed provider request saw it, and its report file exists now (the stub's lookup
 * must work after a reload). A run that runs again does not fold; once it ended again and a request
 * saw its new result message, it folds again with the new facts. A later wait or launch reply of a
 * folded run (a lookup copy) refolds it with its old facts and a new foldedAt, so that reply folds
 * too and every earlier stub keeps its text (fold-waits D3).
 */
export function settleFold(
	entries: readonly unknown[],
	isRunning: (id: string) => boolean,
	now: number = Date.now(),
	reportExists: (path: string) => boolean = existsSync,
	recordFacts: (id: string) => RunFacts | undefined = () => undefined,
): FoldedRun[] {
	if (isChildTranscript(entries)) return [];
	const folded = scanFoldEntries(entries);
	const commits = new Map<string, { index: number; messageIndex: number; facts: RunFacts }>();
	const lastRequest = entries.findLastIndex(isCompletedRequest);
	for (const { index, isMessage, facts: list } of commitsByIndex(entries, recordFacts)) {
		for (const facts of list) {
			const known = commits.get(facts.id);
			// The latest commit's facts only: an older report never joins a newer outcome.
			commits.set(facts.id, { index, messageIndex: isMessage ? index : (known?.messageIndex ?? -1), facts });
		}
	}
	const runs: FoldedRun[] = [];
	for (const [id, { index, messageIndex, facts }] of commits) {
		const fold = folded.get(id);
		if (index > lastRequest || isRunning(id) || (fold && index < fold.index)) continue;
		if (fold && messageIndex < fold.index) {
			if (reportExists(fold.run.report)) runs.push({ ...fold.run, foldedAt: now });
			continue;
		}
		if (!facts.report || !reportExists(facts.report)) continue;
		runs.push({
			id,
			name: facts.name ?? "unnamed",
			outcome: facts.outcome ?? "ended",
			report: facts.report,
			foldedAt: now,
		});
	}
	return runs;
}
