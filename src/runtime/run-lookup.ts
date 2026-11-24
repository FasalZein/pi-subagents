import { homedir } from "node:os";
import type { ResultStore } from "./result-files.ts";
import { parseRunId, type ResultRecord, type RunId } from "./result-record.ts";
import { renderResult } from "./result-render.ts";

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
