import { homedir } from "node:os";
import type { PollResult } from "../mux/poll.ts";
import { getEntries } from "../session/session.ts";
import type { RunningSubagent, SubagentSummarySource } from "../types.ts";
import { assembleResult, NO_REPORT_LINE } from "./result-assembler.ts";
import type { Reservation, ResultStore } from "./result-files.ts";
import type { ResultRecord } from "./result-record.ts";
import { renderResult } from "./result-render.ts";

/** Where a headless run publishes its result: the store of its parent session and its reserved id. */
export interface ResultTarget {
	store: ResultStore;
	reservation: Reservation;
}

export interface HeadlessResult {
	record: ResultRecord;
	/** The parent's text (D14); the message path and the wait path both show it. */
	text: string;
	summary: string;
	summarySource: SubagentSummarySource;
}

/**
 * D13 and D14: assembles, publishes and renders the result of a headless child that exited on its
 * own with code 0. Time-limit, error, ping and context-pressure ends keep their own texts until
 * their tickets move them here (T09).
 */
export function publishHeadlessResult(
	running: RunningSubagent,
	target: ResultTarget,
	exitSignal: PollResult | null,
	contextUsage: { contextTokens?: number; contextWindow?: number },
): HeadlessResult {
	const assembled = assembleResult({
		runId: target.reservation.runId,
		name: running.name,
		agent: running.agent ?? "",
		title: running.title,
		modelRef: running.modelRef,
		sessionFile: running.sessionFile,
		startedAt: running.startTime,
		endedAt: Date.now(),
		end: { kind: "exited", code: 0 },
		entries: getEntries(running.sessionFile),
		launchEntryCount: running.launchEntryCount ?? 0,
		acceptedCall: exitSignal?.acceptedCall,
		contextUsage:
			contextUsage.contextTokens !== undefined
				? { tokens: contextUsage.contextTokens, window: contextUsage.contextWindow }
				: undefined,
		resume: { resumable: true },
	});
	const record = target.store.publish(target.reservation, assembled);
	const text = renderResult(record, {
		cwd: process.cwd(),
		homeDir: homedir(),
		showContextUsage: running.reportContextUsage !== false,
	});
	const noText = !record.typed && assembled.report === `${record.summary}\n\n${NO_REPORT_LINE}`;
	return { record, text, summary: record.summary, summarySource: noText ? "runtime" : "subagent" };
}
