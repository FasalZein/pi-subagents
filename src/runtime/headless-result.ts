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
	/**
	 * The receiving parent's working directory (its ctx.cwd, which a resumed parent takes from its
	 * saved session, not process.cwd()); Pi's read tool resolves a relative report locator from it.
	 */
	parentCwd: string;
	/** Launch warnings the rendering repeats inside its frame, so every carrier shows the same text. */
	warnings: readonly string[];
}

/** D14 and the context-warning policy: why a run that wrapped up under context pressure cannot resume. */
export const CONTEXT_PRESSURE_RESUME_REASON =
	"stopped early by its context-warning policy and its context window is spent; launch a fresh sub-agent for unfinished work";

/**
 * True for a tool result that carries a published rendering (its details name the run id, as the
 * wait path sets them only then); its text already holds the launch warnings.
 */
export function isRenderedResult(result: { details?: unknown }): boolean {
	return typeof (result.details as { runId?: unknown } | undefined)?.runId === "string";
}

/** Splits a joined launch warning ("" when none) into renderer lines without the "Warning: " prefix. */
export function launchWarningLines(warning: string): string[] {
	return warning
		.split("\n\n")
		.map((line) => line.replace(/^Warning:\s*/, "").trim())
		.filter(Boolean);
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
 * own with code 0, also after a context-pressure wrap-up. Time-limit, error and ping ends keep their
 * own texts until their tickets move them here (T09).
 */
export function publishHeadlessResult(
	running: RunningSubagent,
	target: ResultTarget,
	exitSignal: PollResult | null,
	contextUsage: { contextTokens?: number; contextWindow?: number; contextWarned?: boolean },
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
		resume: contextUsage.contextWarned
			? { resumable: false, reason: CONTEXT_PRESSURE_RESUME_REASON }
			: { resumable: true },
	});
	const record = target.store.publish(target.reservation, assembled);
	const text = renderResult(record, {
		cwd: target.parentCwd,
		homeDir: homedir(),
		warnings: target.warnings,
		showContextUsage: running.reportContextUsage !== false,
	});
	const noText = !record.typed && assembled.report === `${record.summary}\n\n${NO_REPORT_LINE}`;
	return { record, text, summary: record.summary, summarySource: noText ? "runtime" : "subagent" };
}
