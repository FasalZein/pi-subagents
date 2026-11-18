import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { PollResult } from "../mux/poll.ts";
import { getEntries } from "../session/session.ts";
import type { RunningSubagent, SubagentResult, SubagentSummarySource, SubagentTimeoutKind } from "../types.ts";
import { assembleResult, NO_REPORT_LINE, type RunEnd, type RunFacts } from "./result-assembler.ts";
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

/** D13: why a no-session run cannot resume: its temporary session file is deleted after the result. */
export const NO_SESSION_RESUME_REASON =
	"a no-session run keeps no session; launch a fresh sub-agent for unfinished work";

/** D13 with the context-warning policy: a no-session run that stopped early keeps both reasons. */
export const NO_SESSION_CONTEXT_PRESSURE_RESUME_REASON =
	"stopped early by its context-warning policy, and a no-session run keeps no session; launch a fresh sub-agent for unfinished work";

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

/** Adds a warning that arose after launch (for example a pane placement failure) to the run's result. */
export function addResultWarning(running: RunningSubagent, warning: string): void {
	if (running.resultTarget) {
		running.resultTarget = { ...running.resultTarget, warnings: [...running.resultTarget.warnings, warning] };
	}
}

export interface PublishedResult {
	record: ResultRecord;
	/** The parent's text (D14); the message path and the wait path both show it. */
	text: string;
	summary: string;
	summarySource: SubagentSummarySource;
}

/** How a watched child ended, as its watcher saw it; publishRunResult decides the outcome from it once. */
export interface WatchedEnd {
	/** The actual exit code; the record keeps it. */
	exitCode: number;
	/**
	 * An operator closed a manual pane (auto-exit: false) and its shell reported a nonzero status
	 * without a child error: a successful end when the child answered, a failure when it did not.
	 */
	operatorClosed: boolean;
	/** D7: the parent asked this run to stop; it ends cancelled whatever the dying child wrote. */
	stopped: boolean;
	/** The hard budget the runtime killed the child on; unset when the child's own outcome beat it. */
	timedOut?: { kind: SubagentTimeoutKind; seconds: number };
	/** The child ended with caller_ping; the message comes from its exit record. */
	ping?: { message: string };
	errorMessage?: string;
	/** The exit record that carries the completion call, if any. */
	exitSignal: PollResult | null | undefined;
	contextUsage: { contextTokens?: number; contextWindow?: number; contextWarned?: boolean };
}

/** The summary of a stopped run that has no published record. */
export const CANCELLED_SUMMARY = "Subagent cancelled.";

/**
 * D7: the watcher's abort signal fired because the parent asked the run to stop. A time limit that
 * already expired keeps timed out, never cancelled: a pane kill that cannot be confirmed aborts the
 * same signal, and a stop after the kill went out does not change why the run ended.
 */
export function isStopRequested(running: RunningSubagent, signal: AbortSignal): boolean {
	return signal.aborted && !running.timeoutExpiry;
}

/** D7: the reason a stopped run's record names. */
export const STOPPED_REASON = "stopped by the parent";

/**
 * D7 and D12: one decision per watched end. A stop wins over everything; a ping, which asks the
 * parent for help, outranks the time-limit kill; then the kill, a child error, a finished report-only
 * wrap-up, and an end of the child's own. Undefined for a nonzero exit that is no operator close: a
 * crash keeps its own failure text.
 */
function classifyWatchedEnd(running: RunningSubagent, end: WatchedEnd): RunEnd | undefined {
	if (end.stopped) return { kind: "cancelled", reason: STOPPED_REASON };
	if (end.ping) return { kind: "pinged", message: end.ping.message, code: end.exitCode };
	if (end.timedOut) {
		return { kind: "timed_out", budget: end.timedOut.kind, seconds: end.timedOut.seconds, wrapUp: false };
	}
	if (end.errorMessage) return { kind: "failed", error: end.errorMessage, code: end.exitCode };
	const wrapUp = running.timeoutWrapUp;
	if (wrapUp && running.timeoutWrapUpMode) {
		return { kind: "timed_out", budget: wrapUp.kind, seconds: wrapUp.seconds, wrapUp: true };
	}
	if (end.exitCode === 0 || end.operatorClosed) return { kind: "exited", code: end.exitCode };
	return undefined;
}

/**
 * D13 and D14: assembles, publishes and renders the result of a watched headless or pane child, for
 * every end the watcher decided (classifyWatchedEnd). Returns undefined for a crash, for a child that
 * exited without a session file, and for an operator-closed pane that never answered: those keep
 * their own failure texts. A no-session child is assembled from its temporary session file, which the
 * watcher deletes after this returns, so its record names no session file and says that it cannot be
 * resumed.
 */
export function publishRunResult(running: RunningSubagent, end: WatchedEnd): PublishedResult | undefined {
	const runEnd = classifyWatchedEnd(running, end);
	if (!runEnd || (runEnd.kind === "exited" && !existsSync(running.sessionFile))) return undefined;
	const { contextUsage } = end;
	return publishEnd(running, runEnd, {
		acceptedCall: end.exitSignal?.acceptedCall,
		contextUsage:
			contextUsage.contextTokens !== undefined
				? { tokens: contextUsage.contextTokens, window: contextUsage.contextWindow }
				: undefined,
		contextWarned: contextUsage.contextWarned === true,
		// A nonzero end without an answer is a crash, not an operator close: it keeps its failure text.
		keepCrashText: runEnd.kind === "exited" && end.exitCode !== 0,
	});
}

/**
 * D14 for an end the watcher built without an exit of the child's own (a stop before the exit, a
 * wrap-up that could not start, a watcher error): the same assembled record and rendering.
 */
function publishRuntimeEnd(running: RunningSubagent, end: RunEnd): PublishedResult | undefined {
	return publishEnd(running, end, { contextWarned: false, keepCrashText: false });
}

/** A runtime-built SubagentResult with the published record's summary and rendering. */
export function withRuntimeEnd(running: RunningSubagent, result: SubagentResult, end: RunEnd): SubagentResult {
	const published = publishRuntimeEnd(running, end);
	if (!published) return result;
	return { ...result, summary: published.summary, summarySource: published.summarySource, ...publishedResultFields(published) };
}

interface PublishOptions {
	acceptedCall?: RunFacts["acceptedCall"];
	contextUsage?: RunFacts["contextUsage"];
	contextWarned: boolean;
	keepCrashText: boolean;
}

function publishEnd(running: RunningSubagent, end: RunEnd, options: PublishOptions): PublishedResult | undefined {
	const target = running.resultTarget;
	if (!target) return undefined;
	const assembled = assembleResult({
		runId: target.reservation.runId,
		name: running.name,
		agent: running.agent ?? "",
		title: running.title,
		modelRef: running.modelRef,
		sessionFile: running.noSession ? undefined : running.sessionFile,
		startedAt: running.startTime,
		endedAt: Date.now(),
		end,
		entries: existsSync(running.sessionFile) ? getEntries(running.sessionFile) : [],
		launchEntryCount: running.launchEntryCount ?? 0,
		acceptedCall: options.acceptedCall,
		contextUsage: options.contextUsage,
		resume: resumeFact(running, end, options.contextWarned),
	});
	const noText = !assembled.record.typed && assembled.report === `${assembled.record.summary}\n\n${NO_REPORT_LINE}`;
	if (options.keepCrashText && noText) return undefined;
	const record = target.store.publish(target.reservation, assembled);
	const killUnconfirmed = end.kind === "timed_out" && running.timeoutKillFailed === true;
	const text = renderResult(record, {
		cwd: target.parentCwd,
		homeDir: homedir(),
		warnings: killUnconfirmed ? [KILL_UNCONFIRMED_WARNING, ...target.warnings] : target.warnings,
		showContextUsage: running.reportContextUsage !== false,
	});
	return { record, text, summary: record.summary, summarySource: noText ? "runtime" : "subagent" };
}

/** An unconfirmed kill must not read as a clean one: the pane can still be running. */
const KILL_UNCONFIRMED_WARNING =
	"the system could not confirm that this sub-agent stopped; check its pane and close it before you trust this result";

/** D8 with the agent's time-limit policy: why a run that a time limit stopped cannot resume. */
export const TIME_LIMIT_RESUME_REASON = "its agent does not allow a resume after a time limit stops it";

function resumeFact(running: RunningSubagent, end: RunEnd, contextWarned: boolean): ResultRecord["resume"] {
	const noSession = running.noSession === true;
	if (noSession && contextWarned) return { resumable: false, reason: NO_SESSION_CONTEXT_PRESSURE_RESUME_REASON };
	if (noSession) return { resumable: false, reason: NO_SESSION_RESUME_REASON };
	if (end.kind === "timed_out" && running.timeoutBlocksResume === true) {
		return { resumable: false, reason: TIME_LIMIT_RESUME_REASON };
	}
	if (contextWarned) return { resumable: false, reason: CONTEXT_PRESSURE_RESUME_REASON };
	return { resumable: true };
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
