import { homedir } from "node:os";
import { cutText } from "./result-assembler.ts";
import type { ResultStore } from "./result-files.ts";
import { parseRunId, type ResultRecord, type RunId } from "./result-record.ts";
import { OUTCOME_WORDS, RESULT_TEXT_MAX_CHARS, renderResult } from "./result-render.ts";

/** D16: the recent list names at most this many ended runs; an older run is found by its run id. */
export const RECENT_RUNS_LIMIT = 20;

/** A name keeps this many characters in a recent line, so 20 lines stay within the cap. */
const RECENT_NAME_MAX_CHARS = 40;

/** One line of the recent list (D16): no summary, no report, never a full result. */
export interface RecentRun {
	runId: string;
	name: string;
	outcome: ResultRecord["outcome"];
	/** Epoch milliseconds, from the record. */
	endedAt: number;
}

function parseOrUndefined(value: string): RunId | undefined {
	try {
		return parseRunId(value);
	} catch {
		return undefined;
	}
}

/** The published record of a run id in this session's results, from its file or from memory (D13). */
export function lookUpRecord(store: ResultStore | undefined, query: string): ResultRecord | undefined {
	const id = parseOrUndefined(query);
	return id && store?.read(id);
}

/**
 * D14 and D16: a lookup returns the delivered rendering that the store kept with the record. A record
 * published without one (before T25, or by verified fan-out) is rendered again with the one renderer,
 * so it is still capped, but without the display facts of its delivery (warnings, context policy).
 */
export function renderLookup(store: ResultStore, record: ResultRecord, cwd: string): string {
	return (
		store.storedRendering(record) ??
		renderResult(record, { cwd, homeDir: homedir(), showContextUsage: record.contextUsage !== undefined })
	);
}

/**
 * D16: the answer for a run id that is neither active nor recorded: the session file from the launch
 * metadata when this process or the run folder knows it, never a made-up path.
 */
export function noRecordText(store: ResultStore | undefined, query: string): string {
	const id = parseOrUndefined(query);
	const sessionFile = id && store?.launchSessionFile(id);
	return sessionFile
		? `No result record for "${query}". Its session file: ${sessionFile}`
		: `No result record for "${query}".`;
}

/** D16: the last RECENT_RUNS_LIMIT ended runs, newest first by end time; equal end times by run id. */
export function recentRuns(store: ResultStore): RecentRun[] {
	return store
		.list()
		.sort((a, b) => b.endedAt - a.endedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
		.slice(0, RECENT_RUNS_LIMIT)
		.map(({ runId, name, outcome, endedAt }) => ({ runId, name, outcome, endedAt }));
}

function recentLine(run: RecentRun): string {
	const ended = new Date(run.endedAt).toISOString();
	return `${run.runId} · ${cutText(run.name, RECENT_NAME_MAX_CHARS)} · ${OUTCOME_WORDS[run.outcome]} · ${ended}`;
}

/** The recent list as text, within RESULT_TEXT_MAX_CHARS like every result copy. */
export function renderRecentRuns(runs: readonly RecentRun[]): string {
	if (runs.length === 0) return "No ended subagent run in this session.";
	const text = runs.map(recentLine).join("\n");
	// Only run ids longer than drawn ones can reach the cap; the cut keeps the newest lines whole.
	return cutText(text, RESULT_TEXT_MAX_CHARS);
}
