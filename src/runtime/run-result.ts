import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { runsInMemory } from "../launch/policy.ts";
import type { PollResult } from "../mux/poll.ts";
import { getEntries } from "../session/session.ts";
import { findNudgeEntryIndex } from "../tools/completion-nudge.ts";
import type { RunningSubagent, SubagentResult, SubagentSummarySource, SubagentTimeoutKind } from "../types.ts";
import { assembleResult, endedByOf, type RunEnd, type RunFacts, type WrapUpFact } from "./result-assembler.ts";
import type { Reservation, ResultStore } from "./result-files.ts";
import type { EndedBy, ResultRecord } from "./result-record.ts";
import { renderResult } from "./result-render.ts";
import type { ProcessOutput } from "./untyped-report.ts";

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

/** D13: why a no-session run cannot resume: it keeps no session file after the result. */
export const NO_SESSION_RESUME_REASON =
	"a no-session run keeps no session; launch a fresh sub-agent for unfinished work";

/** D13 with the context-warning policy: a no-session run that stopped early keeps both reasons. */
const NO_SESSION_CONTEXT_PRESSURE_RESUME_REASON =
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

interface PublishedResult {
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
	/**
	 * T70: the child's shutdown record says a person closed its pane (PollResult.closedByOperator). A
	 * headless child never has one; operatorClosed above is a shell status, not this fact.
	 */
	closedByPerson: boolean;
	/** D7: the parent asked this run to stop; it ends cancelled whatever the dying child wrote. */
	stopped: boolean;
	/** The hard budget the runtime killed the child on; unset when the child's own outcome beat it. */
	timedOut?: { kind: SubagentTimeoutKind; seconds: number };
	/** The child ended with caller_ping; the message comes from its exit record. */
	ping?: { message: string };
	errorMessage?: string;
	/** The exit record that carries the completion call, if any. */
	exitSignal: PollResult | null | undefined;
	/** D12: a headless child's stdout and stderr tails (RunFacts.processOutput); a pane child has none. */
	processOutput?: ProcessOutput;
	contextUsage: { contextTokens?: number; contextWindow?: number; contextWarned?: boolean };
}

/** The summary of a stopped run that has no published record. */
export const CANCELLED_SUMMARY = "Subagent cancelled.";

/**
 * D7: the watcher's abort signal fired because the parent asked the run to stop. The first cause
 * wins: a time limit that already expired keeps timed out, never cancelled (a pane kill that cannot
 * be confirmed aborts the same signal), and a deadline that passes after the stop never sets
 * timeoutExpiry (isDeadlineEnforceable), so the stop stays cancelled.
 */
export function isStopRequested(running: RunningSubagent, signal: AbortSignal): boolean {
	return signal.aborted && !running.timeoutExpiry;
}

/** D7: a deadline counts only while no stop came first; a later deadline does not change why the run ended. */
export function isDeadlineEnforceable(signal: AbortSignal): boolean {
	return !signal.aborted;
}

/** D7: the child's completion call was accepted; a plain `done` from a shutdown carries no call. */
export function isAcceptedCompletion(end: { reason: string; acceptedCall?: unknown } | null | undefined): boolean {
	return end?.reason === "done" && end.acceptedCall !== undefined;
}

/**
 * D7: a completion accepted while the soft interruption is under way, so before the hard deadline,
 * is the run's end. Pure: the caller applies keepCompletionOverWrapUp when this holds.
 */
export function keepsCompletionOverWrapUp(
	running: RunningSubagent,
	...ends: Array<{ reason: string; acceptedCall?: unknown } | null | undefined>
): boolean {
	return running.phase === "soft-limit" && ends.some(isAcceptedCompletion);
}

/** D7: the report-only wrap-up never runs after a kept completion, so the run carries no wrap-up marker. */
export function keepCompletionOverWrapUp(running: RunningSubagent): void {
	running.timeoutWrapUp = undefined;
	running.timeoutWrapUpDeadlineAt = undefined;
}

/** D7: the reason a stopped run's record names. */
export const STOPPED_REASON = "stopped by the parent";
/** T70: the reason of a run the operator stopped from the overlay. */
export const OPERATOR_STOPPED_REASON = "stopped by the operator";

/** D7 and T70: the cancelled end of a stopped run, with the reason of whoever asked for the stop. */
export function stoppedEnd(running: Pick<RunningSubagent, "stopRequestedBy">): RunEnd {
	return {
		kind: "cancelled",
		reason: running.stopRequestedBy === "operator" ? OPERATOR_STOPPED_REASON : STOPPED_REASON,
	};
}

/**
 * D7 and D12: one decision per watched end. A stop wins over everything; a ping, which asks the
 * parent for help, outranks the time-limit kill; then the kill, a child error, and an end of the
 * child's own. A nonzero exit that is no operator close is a crash: it fails with its exit code.
 * D21 (cf6dbf4): a report-only wrap-up that ended on its own is classified like any own end; its
 * time limit travels apart from the end (wrapUpOf), so a failed wrap-up keeps it too.
 */
function classifyWatchedEnd(running: RunningSubagent, end: WatchedEnd): RunEnd {
	if (end.stopped) return stoppedEnd(running);
	if (end.ping) return { kind: "pinged", message: end.ping.message, code: end.exitCode };
	if (end.timedOut) {
		return { kind: "timed_out", budget: end.timedOut.kind, seconds: end.timedOut.seconds, wrapUp: false };
	}
	if (end.errorMessage) return { kind: "failed", error: end.errorMessage, code: end.exitCode };
	if (end.exitCode === 0 || end.operatorClosed) return { kind: "exited", code: end.exitCode };
	return { kind: "failed", error: `exited with code ${end.exitCode}`, code: end.exitCode };
}

/**
 * D21: the time limit of a report-only wrap-up that ended by itself: a clean or nonzero exit or a
 * child error. A stop, a hard-deadline kill and a ping keep their own verdicts and get none.
 */
function wrapUpOf(running: RunningSubagent, end: WatchedEnd): WrapUpFact | undefined {
	const wrapUp = running.timeoutWrapUp;
	if (!wrapUp || running.phase !== "wrapping-up" || end.stopped || end.ping || end.timedOut) return undefined;
	return { budget: wrapUp.kind, seconds: wrapUp.seconds };
}

/** D14: an operator closed a manual pane with a nonzero status before the child answered. */
const CLOSED_WITHOUT_ANSWER_ERROR = "the pane closed with a nonzero status before the sub-agent answered";

/**
 * D13 and D14: assembles, publishes and renders the result of a watched headless or pane child, for
 * every end the watcher decided (classifyWatchedEnd), a crash included. Returns undefined only for a
 * child that exited cleanly without a session file and did not run in memory. An operator-closed pane with a nonzero status
 * and no answer publishes a failed record. A no-session child in Pi's in-memory mode is assembled from its process output
 * (D13, T73); one under strict wrap-up from its temporary session file, which the watcher deletes after
 * this returns. Either record names no session file and says that it cannot be resumed.
 */
export function publishRunResult(running: RunningSubagent, end: WatchedEnd): PublishedResult | undefined {
	const runEnd = classifyWatchedEnd(running, end);
	if (runEnd.kind === "exited" && !runsInMemory(running) && !existsSync(running.sessionFile)) return undefined;
	const { contextUsage } = end;
	return publishEnd(running, runEnd, {
		acceptedCall: end.exitSignal?.acceptedCall,
		contextUsage:
			contextUsage.contextTokens !== undefined
				? { tokens: contextUsage.contextTokens, window: contextUsage.contextWindow }
				: undefined,
		contextWarned: contextUsage.contextWarned === true,
		// A nonzero operator close without an answer is a failure, not the child's own end.
		failWithoutText: runEnd.kind === "exited" && end.exitCode !== 0,
		closedByPerson: end.closedByPerson,
		processOutput: end.processOutput,
		wrapUp: wrapUpOf(running, end),
	});
}

/**
 * D14 for an end the watcher built without an exit of the child's own (a stop before the exit, a
 * wrap-up that could not start, a watcher error): the same assembled record and rendering, as a
 * runtime-built SubagentResult with the published record's summary.
 */
export function withRuntimeEnd(
	running: RunningSubagent,
	result: SubagentResult,
	end: RunEnd,
	/** T70: who ended the run when the end kind does not say it (a wrap-up that could not start). */
	endedBy?: EndedBy,
): SubagentResult {
	const published = publishEnd(running, end, {
		contextWarned: false,
		failWithoutText: false,
		closedByPerson: false,
		endedBy,
	});
	if (!published) return result;
	return {
		...result,
		summary: published.summary,
		summarySource: published.summarySource,
		...publishedResultFields(published),
	};
}

interface PublishOptions {
	acceptedCall?: RunFacts["acceptedCall"];
	contextUsage?: RunFacts["contextUsage"];
	contextWarned: boolean;
	/** Publish a failed end instead when the run left no text (a nonzero operator close). */
	failWithoutText: boolean;
	/** T70: a person closed the pane (WatchedEnd.closedByPerson). */
	closedByPerson: boolean;
	/** T70: an ender the caller knows apart from the end kind. */
	endedBy?: EndedBy;
	processOutput?: ProcessOutput;
	wrapUp?: WrapUpFact;
}

function publishEnd(running: RunningSubagent, end: RunEnd, options: PublishOptions): PublishedResult | undefined {
	const target = running.resultTarget;
	if (!target) return undefined;
	// D13 (T73): an in-memory run writes no transcript; its file holds only the launch seed.
	const inMemory = runsInMemory(running);
	const entries = !inMemory && existsSync(running.sessionFile) ? getEntries(running.sessionFile) : [];
	const launchEntryCount = running.launchEntryCount ?? 0;
	const assemble = (runEnd: RunEnd) =>
		assembleResult({
			runId: target.reservation.runId,
			name: running.name,
			agent: running.agent ?? "",
			title: running.title,
			modelRef: running.modelRef,
			sessionFile: running.noSession ? undefined : running.sessionFile,
			startedAt: running.startTime,
			endedAt: Date.now(),
			end: runEnd,
			endedBy:
				options.endedBy ??
				endedByOf(runEnd, {
					stoppedBy: running.stopRequestedBy,
					closedByPerson: options.closedByPerson,
					wrapUp: options.wrapUp !== undefined,
				}),
			entries,
			launchEntryCount,
			noTranscript: inMemory,
			nudgeEntryIndex: findNudgeEntryIndex(entries, Math.max(launchEntryCount, running.processEntryCount ?? 0)),
			acceptedCall: options.acceptedCall,
			contextUsage: options.contextUsage,
			resume: resumeFact(running, runEnd, options.contextWarned),
			processOutput: options.processOutput,
			wrapUp: options.wrapUp,
		});
	let assembled = assemble(end);
	if (options.failWithoutText && assembled.summarySource === "runtime") {
		end = { kind: "failed", error: CLOSED_WITHOUT_ANSWER_ERROR, code: end.kind === "exited" ? end.code : undefined };
		assembled = assemble(end);
	}
	const killUnconfirmed = end.kind === "timed_out" && running.timeoutKillFailed === true;
	// D16: the store keeps this exact text with the record, so a lookup replays it.
	const render = (published: ResultRecord) =>
		renderResult(published, {
			cwd: target.parentCwd,
			homeDir: homedir(),
			warnings: target.warnings,
			// The pane can still run: this warning keeps its place even beside a time-limit line.
			requiredWarnings: killUnconfirmed ? [KILL_UNCONFIRMED_WARNING] : [],
			showContextUsage: running.reportContextUsage !== false,
		});
	const record = target.store.publish(target.reservation, assembled, render);
	const text = render(record);
	return { record, text, summary: record.summary, summarySource: assembled.summarySource };
}

/** An unconfirmed kill must not read as a clean one: the pane can still be running. */
export const KILL_UNCONFIRMED_WARNING =
	"the system could not confirm that this sub-agent stopped; check its pane and close it before you trust this result";

/** D8 with the agent's time-limit policy: why a run that a time limit stopped cannot resume. */
export const TIME_LIMIT_RESUME_REASON = "its agent does not allow a resume after a time limit stops it";

function resumeFact(running: RunningSubagent, end: RunEnd, contextWarned: boolean): ResultRecord["resume"] {
	const noSession = running.noSession === true;
	if (noSession && contextWarned) return { resumable: false, reason: NO_SESSION_CONTEXT_PRESSURE_RESUME_REASON };
	if (noSession) return { resumable: false, reason: NO_SESSION_RESUME_REASON };
	// The resume guard reads the timeout sidecar that only a hard kill writes: a report-only
	// continuation that finished before its hard deadline stays resumable.
	if (end.kind === "timed_out" && !end.wrapUp && running.timeoutBlocksResume === true) {
		return { resumable: false, reason: TIME_LIMIT_RESUME_REASON };
	}
	if (contextWarned) return { resumable: false, reason: CONTEXT_PRESSURE_RESUME_REASON };
	return { resumable: true };
}

/** The SubagentResult fields that carry a published rendering to the message and wait paths. */
export function publishedResultFields(
	published: PublishedResult | undefined,
): Pick<SubagentResult, "resultText" | "resultRunId" | "reportFile" | "resultOutcome" | "resultEndedBy"> {
	if (!published) return {};
	return {
		resultText: published.text,
		resultOutcome: published.record.outcome,
		resultEndedBy: published.record.endedBy,
		resultRunId: published.record.runId,
		...(published.record.report.saved ? { reportFile: published.record.report.path } : {}),
	};
}
