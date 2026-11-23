import { existsSync } from "node:fs";
import { getOwnedHistoryStartIndex } from "../session/session-files.ts";
import { isFinishedStatus, runEnds } from "./run-end-message.ts";

/**
 * The fold set of the settle fold (see context-fold.ts): which runs fold, decided only at a settle
 * and kept as durable session entries. Principle (owner, no regressions): when a run cannot be
 * proven safe to fold, it stays full.
 */
export const CONTEXT_FOLD_ENTRY = "subagent_context_fold";
/** The run ids one nested subagent call of a codemode script started (no task text). */
export const CONTEXT_FOLD_LAUNCH_ENTRY = "subagent_context_fold_launch";

/** The facts a stub names; fixed at the settle that folds the run, so every later stub is the same text. */
export interface FoldedRun {
	id: string;
	name: string;
	outcome: string;
	/** The saved report; a run folds only when this file exists at the settle. */
	report: string;
	/**
	 * Epoch ms of the settle that folded the run. A result message of the same run id from after it
	 * is not used yet and stays full until a later settle folds it.
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

/** A verified fan-out run or a provenance notice: never folded (owner-rules 2026-11-18T17:56Z). */
function isVerifiedOrNotice(details: Rec): boolean {
	return details.provenance === true || details.verifiedRunId !== undefined;
}

type RunFacts = { id: string; name?: string; outcome?: string; report?: string };

/** The saved report path: reportFile of a run end or launch reply, record.report.path of a wait reply. */
function reportPath(details: Rec): string | undefined {
	const record = isRecord(details.record) ? details.record : undefined;
	const report = record && isRecord(record.report) ? record.report : undefined;
	return str(details.reportFile) ?? (report?.saved === true ? str(report.path) : undefined);
}

function runFacts(id: string, details: Rec): RunFacts {
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
 * The runs whose finished result one committed session entry carries: a subagent_result or
 * subagent_ping message, a launch reply that delivered a report, or a subagent_wait reply.
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
	if (!message || message.role !== "toolResult" || !isRecord(message.details)) return [];
	const details = message.details;
	const listed =
		message.toolName === "subagent"
			? (Array.isArray(details.children) ? details.children : [details]).filter(
					(child) => isRecord(child) && isFinishedStatus(str(child.status)),
				)
			: message.toolName === "subagent_wait" && Array.isArray(details.results)
				? details.results
				: [];
	return listed.flatMap((item) => {
		if (!isRecord(item) || isVerifiedOrNotice(item)) return [];
		const id = str(item.id) ?? str(item.runId);
		return id ? [runFacts(id, item)] : [];
	});
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
 * saw its new result message, it folds again with the new facts. A later wait or launch reply for a
 * folded run stays full (owner rule) and triggers no new fold.
 */
export function settleFold(
	entries: readonly unknown[],
	isRunning: (id: string) => boolean,
	now: number = Date.now(),
	reportExists: (path: string) => boolean = existsSync,
): FoldedRun[] {
	if (isChildTranscript(entries)) return [];
	const folded = scanFoldEntries(entries);
	const commits = new Map<string, { index: number; messageIndex: number; facts: RunFacts }>();
	let lastRequest = -1;
	entries.forEach((entry, index) => {
		if (isCompletedRequest(entry)) lastRequest = index;
		const isMessage = isRecord(entry) && entry.type === "custom_message";
		for (const facts of committedResults(entry)) {
			const known = commits.get(facts.id);
			// The latest commit's facts only: an older report never joins a newer outcome.
			commits.set(facts.id, { index, messageIndex: isMessage ? index : (known?.messageIndex ?? -1), facts });
		}
	});
	const runs: FoldedRun[] = [];
	for (const [id, { index, messageIndex, facts }] of commits) {
		const fold = folded.get(id);
		if (index > lastRequest || isRunning(id) || (fold && messageIndex < fold.index)) continue;
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
