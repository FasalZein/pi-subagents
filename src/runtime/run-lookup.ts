import { homedir } from "node:os";
import type { RunningSubagent } from "../types.ts";
import { resultsRoot } from "../vf/run/winner-store.ts";
import type { ResultStore } from "./result-files.ts";
import { parseRunId, type ResultRecord, type RunId } from "./result-record.ts";
import { renderResult } from "./result-render.ts";

/**
 * Owner decision 2026-11-24: the folder where a run's report lands, so a parent can read the result
 * by path after a reopen or a compaction. A session run (background, pane, resume; typed or untyped)
 * publishes report-<n>.md and record.json in its reserved run folder (result-files.ts publish); a
 * verified run publishes g<n>/report.md under its run directory (winner-store.ts). undefined when
 * the run folder could not be created: its result then exists only in memory and in the message.
 */
export function runReportFolder(running: Pick<RunningSubagent, "verifiedRunDir" | "resultTarget">): string | undefined {
	if (running.verifiedRunDir) return resultsRoot(running.verifiedRunDir);
	return running.resultTarget?.reservation.folder;
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
 * but without the display facts of its delivery (warnings, context policy).
 */
export function renderLookup(store: ResultStore, record: ResultRecord, cwd: string): string {
	return (
		store.storedRendering(record) ??
		renderResult(record, { cwd, homeDir: homedir(), showContextUsage: record.contextUsage !== undefined })
	);
}
