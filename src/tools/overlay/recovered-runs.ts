import { getSessionResultsDir } from "../../artifact-storage.ts";
import { sessionResultStore } from "../../runtime/result-files.ts";
import type { ResultOutcome, ResultRecord } from "../../runtime/result-record.ts";
import { type RunEndEntry, runEnds } from "../../runtime/run-end-message.ts";
import { firstLine } from "./render-helpers.ts";
import type { OverlayContext } from "./render-types.ts";

// The /subagents overlay reads finished runs back from the parent session's published records
// (D13) and, for runs without one, from the parent session file (D15): one entry per run end,
// from grouped messages and from old single-result and ping messages alike.

interface RecoveredResultDetails {
	id: string;
	name: string;
	agent?: string;
	status: "completed" | "cancelled" | "failed";
	/** The published outcome (D14), shown when it is not plain done. */
	outcome?: string;
	content: string;
	/** A published record (D14): the content is header, summary, footer, one per line. */
	published: boolean;
	exitCode?: number;
	elapsed?: number;
	sessionFile?: string;
	errorMessage?: string;
}

function getEntryDetails(entry: { [key: string]: unknown }): Record<string, unknown> | undefined {
	const direct = entry.details;
	if (typeof direct === "object" && direct !== null) return direct as Record<string, unknown>;
	const message = entry.message;
	if (typeof message !== "object" || message === null) return undefined;
	const details = (message as { details?: unknown }).details;
	return typeof details === "object" && details !== null ? (details as Record<string, unknown>) : undefined;
}

/** Every run end a session entry carries: one per old single-result or ping message, several per group (D15). */
export function recoverResultDetails(entry: { [key: string]: unknown }): RecoveredResultDetails[] {
	if (entry.type !== "custom_message") return [];
	return runEnds(entry.customType, entry.content, getEntryDetails(entry)).flatMap((runEnd) => {
		const recovered = recoverRunEnd(runEnd);
		return recovered ? [recovered] : [];
	});
}

function recoverRunEnd({ customType, content, details }: RunEndEntry): RecoveredResultDetails | undefined {
	const name = typeof details.name === "string" ? details.name : undefined;
	const id = typeof details.id === "string" ? details.id : name;
	const rawStatus = typeof details.status === "string" ? details.status : undefined;
	const status =
		rawStatus === "completed" || rawStatus === "cancelled" || rawStatus === "failed"
			? rawStatus
			: details.exitCode === 0 || customType === "subagent_ping"
				? "completed"
				: "failed";
	if (!id || !name) return undefined;
	const outcome =
		typeof details.outcome === "string" ? details.outcome : customType === "subagent_ping" ? "blocked" : undefined;
	return {
		id,
		name,
		content,
		published: typeof details.runId === "string",
		...(outcome ? { outcome } : {}),
		agent: typeof details.agent === "string" ? details.agent : undefined,
		status,
		exitCode: typeof details.exitCode === "number" ? details.exitCode : undefined,
		elapsed: typeof details.elapsed === "number" ? details.elapsed : undefined,
		sessionFile: typeof details.sessionFile === "string" ? details.sessionFile : undefined,
		errorMessage: typeof details.errorMessage === "string" ? details.errorMessage : undefined,
	};
}

export function recoverSummary(content: string, published: boolean): string {
	// A published record puts the summary on the line after the header; an old message after a blank line.
	if (published) return firstLine(content.split("\n").slice(1).join("\n"), 90) || "completed";
	const [, afterHeader = content] = content.split(/\n\n/, 2);
	return firstLine(afterHeader.replace(/\n\nSession:[\s\S]*$/, ""), 90) || "completed";
}

/** One run per session, or per run without one; a session that ran again keeps its newest run. */
export function newestRunsBySession(runs: readonly RecoveredResultDetails[]): Map<string, RecoveredResultDetails> {
	const newest = new Map<string, RecoveredResultDetails>();
	for (const run of runs) {
		const key = run.sessionFile ?? run.id;
		newest.delete(key);
		newest.set(key, run);
	}
	return newest;
}

export function recordStatus(outcome: ResultOutcome): RecoveredResultDetails["status"] {
	if (outcome === "cancelled") return "cancelled";
	return outcome === "failed" || outcome === "timed_out" ? "failed" : "completed";
}

/**
 * The published records of this parent session (D13), whatever channel delivered them: a message,
 * the launch reply or a wait. Pi's real session manager always has a session id; without one, none.
 */
export function sessionRecords(ctx: OverlayContext): ResultRecord[] {
	const sessionId = ctx.sessionManager.getSessionId?.();
	if (!sessionId) return [];
	try {
		return sessionResultStore(getSessionResultsDir(ctx.cwd, sessionId)).list();
	} catch {
		return [];
	}
}

/** The newest record per session (or per run without one), by end time, then run id; oldest row first. */
export function newestRecordsBySession(records: readonly ResultRecord[]): ResultRecord[] {
	const newest = new Map<string, ResultRecord>();
	for (const record of records) {
		const key = record.sessionFile ?? record.runId;
		const kept = newest.get(key);
		if (!kept || record.endedAt > kept.endedAt || (record.endedAt === kept.endedAt && record.runId > kept.runId)) {
			newest.set(key, record);
		}
	}
	return [...newest.values()].sort((a, b) => a.endedAt - b.endedAt || (a.runId < b.runId ? -1 : 1));
}
