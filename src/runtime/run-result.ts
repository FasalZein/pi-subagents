import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { PollResult } from "../mux/poll.ts";
import { getEntries } from "../session/session.ts";
import type { RunningSubagent, SubagentResult, SubagentSummarySource } from "../types.ts";
import { assembleResult, NO_REPORT_LINE } from "./result-assembler.ts";
import type { Reservation, ResultStore } from "./result-files.ts";
import type { ResultRecord } from "./result-record.ts";
import { renderResult } from "./result-render.ts";

/** Where a watched run publishes its result: the store of its parent session and its reserved id. */
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

export interface PublishedResult {
	record: ResultRecord;
	/** The parent's text (D14); the message path and the wait path both show it. */
	text: string;
	summary: string;
	summarySource: SubagentSummarySource;
}

/** How a watched child ended, as its watcher decided it once; only an end of its own is published here. */
export interface WatchedEnd {
	/** The actual exit code; the record keeps it. */
	exitCode: number;
	/**
	 * An operator closed a manual pane (auto-exit: false) and its shell reported a nonzero status
	 * without a child error: a successful end when the child answered, a failure when it did not.
	 */
	operatorClosed: boolean;
	timedOut: boolean;
	pinged: boolean;
	errorMessage?: string;
	/** The exit record that carries the completion call, if any. */
	exitSignal: PollResult | null | undefined;
	contextUsage: { contextTokens?: number; contextWindow?: number; contextWarned?: boolean };
}

/**
 * D13 and D14: assembles, publishes and renders the result of a headless or pane child that exited
 * on its own with code 0, also after a context-pressure wrap-up, and of an operator-closed manual
 * pane that answered. Returns undefined for any other end: time-limit, error and ping ends keep their
 * own texts until their tickets move them here (T09), and a no-session child has no session to
 * assemble from (T08b).
 */
export function publishRunResult(running: RunningSubagent, end: WatchedEnd): PublishedResult | undefined {
	const target = running.resultTarget;
	const endedOnItsOwn =
		(end.exitCode === 0 || end.operatorClosed) &&
		!end.timedOut &&
		!end.pinged &&
		!end.errorMessage &&
		!running.timeoutWrapUp;
	if (!target || running.noSession || !endedOnItsOwn || !existsSync(running.sessionFile)) return undefined;
	const { contextUsage } = end;
	const assembled = assembleResult({
		runId: target.reservation.runId,
		name: running.name,
		agent: running.agent ?? "",
		title: running.title,
		modelRef: running.modelRef,
		sessionFile: running.sessionFile,
		startedAt: running.startTime,
		endedAt: Date.now(),
		end: { kind: "exited", code: end.exitCode },
		entries: getEntries(running.sessionFile),
		launchEntryCount: running.launchEntryCount ?? 0,
		acceptedCall: end.exitSignal?.acceptedCall,
		contextUsage:
			contextUsage.contextTokens !== undefined
				? { tokens: contextUsage.contextTokens, window: contextUsage.contextWindow }
				: undefined,
		resume: contextUsage.contextWarned
			? { resumable: false, reason: CONTEXT_PRESSURE_RESUME_REASON }
			: { resumable: true },
	});
	const noText = !assembled.record.typed && assembled.report === `${assembled.record.summary}\n\n${NO_REPORT_LINE}`;
	// A nonzero end without an answer is a crash, not an operator close: it keeps its failure text.
	if (end.exitCode !== 0 && noText) return undefined;
	const record = target.store.publish(target.reservation, assembled);
	const text = renderResult(record, {
		cwd: target.parentCwd,
		homeDir: homedir(),
		warnings: target.warnings,
		showContextUsage: running.reportContextUsage !== false,
	});
	return { record, text, summary: record.summary, summarySource: noText ? "runtime" : "subagent" };
}

/** The SubagentResult fields that carry a published rendering to the message and wait paths. */
export function publishedResultFields(
	published: PublishedResult | undefined,
): Pick<SubagentResult, "resultText" | "resultRunId" | "reportFile"> {
	if (!published) return {};
	return {
		resultText: published.text,
		resultRunId: published.record.runId,
		...(published.record.report.saved ? { reportFile: published.record.report.path } : {}),
	};
}
