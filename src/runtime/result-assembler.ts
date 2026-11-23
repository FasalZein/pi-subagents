import type { SessionEntry } from "../session/session.ts";
import { SUBAGENT_ACCEPTED_CALL_ENTRY } from "../tools/completion-call.ts";
import { CALLER_PING_TOOL_NAME, SUBAGENT_DONE_TOOL_NAME } from "../tools/tool-names.ts";
import { SUBAGENT_WRITTEN_FILE_ENTRY } from "../tools/written-files.ts";
import type { SubagentSummarySource, SubagentTimeoutKind } from "../types.ts";
import {
	type AssembledRecord,
	CALL_OUTCOMES,
	type CallOutcome,
	type ContextUsage,
	CUT_MARK,
	type EndedBy,
	type ExitFacts,
	type ResultOutcome,
	type ResultTyping,
	type ResumeFacts,
	type RunId,
	type TimeLimitFacts,
} from "./result-record.ts";
import { type ProcessOutput, selectUntypedReport, type UntypedReport } from "./untyped-report.ts";

/** D12: the report line of a run without assistant text. */
export const NO_REPORT_LINE = "no report beyond the summary";

/** How the run ended, as the watcher saw it. */
export type RunEnd =
	| { kind: "exited"; code?: number; signal?: string }
	| { kind: "failed"; error: string; code?: number; signal?: string }
	| { kind: "timed_out"; budget: SubagentTimeoutKind; seconds: number; wrapUp: boolean }
	| { kind: "cancelled"; reason: string }
	/** D12: the child asked its parent for help with caller_ping; the exit record carries the message. */
	| { kind: "pinged"; message: string; code?: number };

export interface RunFacts {
	runId: RunId;
	name: string;
	agent: string;
	title?: string;
	modelRef?: string;
	sessionFile?: string;
	/** Epoch milliseconds. */
	startedAt: number;
	/** Epoch milliseconds. */
	endedAt: number;
	end: RunEnd;
	/** T70: who ended the run, as the watcher's end facts say (endedByOf). */
	endedBy: EndedBy;
	/** Every entry of the child session file, in file order. */
	entries: readonly SessionEntry[];
	/** Entries before this index belong to fork history or an earlier run (D12). */
	launchEntryCount: number;
	/** Index in `entries` of the missing-call nudge message, when one was sent. */
	nudgeEntryIndex?: number;
	/**
	 * The arguments of the completion call as the child's completion tool accepted them, by tool call id
	 * (D12). Pi omits nested-call arguments over 8 KiB per call or 32 KiB per result
	 * (NESTED_CALL_LIMITS), so this is the payload source for such a call; recorded arguments win.
	 */
	acceptedCall?: AcceptedPayload;
	contextUsage?: ContextUsage;
	resume: ResumeFacts;
	/** D12: the child's captured process output (selectUntypedReport). */
	processOutput?: ProcessOutput;
	/** D12 and T73: true when the child ran without a session file, so its entries hold no transcript. */
	noTranscript?: boolean;
	/**
	 * D21: the run's report-only wrap-up continuation ended by itself (a clean exit, a nonzero exit or a
	 * child error). The outcome comes from that end; the record keeps the time limit and its ender.
	 * Unset for a stop, a hard-deadline kill or a ping.
	 */
	wrapUp?: WrapUpFact;
}

/** D21: the time limit whose soft threshold started the report-only wrap-up. */
export interface WrapUpFact {
	budget: SubagentTimeoutKind;
	seconds: number;
}

/** An accepted completion payload; dataError is set when its data failed the launch schema twice (D12). */
export interface AcceptedPayload {
	toolCallId: string;
	args: Record<string, unknown>;
	dataError?: string;
}

export interface AssembledResult {
	record: AssembledRecord;
	report: string;
	/** Who wrote the summary: the child, or the runtime when the run left no report of its own. */
	summarySource: SubagentSummarySource;
}

/**
 * Position of a session fact: entry index, then block index in an assistant message or call index in
 * the nested-call record of a tool result.
 */
type Position = readonly [entry: number, index: number];

/** One non-blank text block of an assistant message, untrimmed. */
interface AssistantText {
	at: Position;
	text: string;
}

type CompletionTool = "done" | "ping";

/**
 * A completion call that ran and succeeded: a direct call with its successful tool result, or a
 * nested call (for example from a codemode script) that Pi recorded with status ok. `args` is
 * undefined when Pi omitted oversize nested arguments; the accepted payload of the same call
 * (RunFacts.acceptedCall) then supplies them, and without it the call ends the run untyped.
 */
interface CompletionCall {
	tool: CompletionTool;
	id: string;
	at: Position;
	args: Record<string, unknown> | undefined;
}

interface RunTranscript {
	texts: AssistantText[];
	/** Accepted completion payloads the child recorded in its session, by tool call id (D12). */
	accepted: Map<string, Record<string, unknown>>;
	/** Data errors of accepted calls, by tool call id (D12). */
	dataErrors: Map<string, string>;
	/** Tool call ids of accepted calls made with no takeover: each is final for the result (D12). */
	autonomous: Set<string>;
	/** The last completion call that succeeded, if any. */
	call?: CompletionCall;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function before(a: Position, b: Position): boolean {
	return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

function completionTool(name: unknown): CompletionTool | undefined {
	return name === SUBAGENT_DONE_TOOL_NAME ? "done" : name === CALLER_PING_TOOL_NAME ? "ping" : undefined;
}

function isNonBlank(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

/** Nested completion calls that Pi recorded as finished without error on one tool result. */
function nestedCompletions(message: Record<string, unknown>, entry: number): CompletionCall[] {
	const nested = message.nestedCalls;
	if (!isRecord(nested) || !Array.isArray(nested.calls)) return [];
	const calls: CompletionCall[] = [];
	nested.calls.forEach((record: unknown, index) => {
		if (!isRecord(record) || record.status !== "ok" || typeof record.id !== "string") return;
		const tool = completionTool(record.name);
		if (tool)
			calls.push({
				tool,
				id: record.id,
				at: [entry, index],
				args: isRecord(record.arguments) ? record.arguments : undefined,
			});
	});
	return calls;
}

/** A completion call the child's tool accepted and recorded in the session (SUBAGENT_ACCEPTED_CALL_ENTRY). */
function acceptedEntry(
	entry: SessionEntry,
):
	| { id: string; tool: CompletionTool; args: Record<string, unknown>; autonomous: boolean; dataError?: string }
	| undefined {
	const raw = entry as { type?: unknown; customType?: unknown; data?: unknown };
	if (raw.type !== "custom" || raw.customType !== SUBAGENT_ACCEPTED_CALL_ENTRY || !isRecord(raw.data)) return undefined;
	const { toolCallId, tool, args, autonomous, dataError } = raw.data;
	const kind = completionTool(tool);
	if (typeof toolCallId !== "string" || !kind || !isRecord(args)) return undefined;
	return {
		id: toolCallId,
		tool: kind,
		args,
		autonomous: autonomous === true,
		dataError: typeof dataError === "string" ? dataError : undefined,
	};
}

/**
 * Reads assistant text and completion facts of this run; tool output never counts as text (D12).
 * A completion is accepted from its successful result or from the accepted-call entry the child's
 * tool wrote before it returned, never from a request alone (D14). The entry stands at its request's
 * position, so it types the result also before Pi persists the tool result.
 */
function readTranscript(entries: readonly SessionEntry[], launchEntryCount: number): RunTranscript {
	const texts: AssistantText[] = [];
	const requested = new Map<string, CompletionCall>();
	const completed: CompletionCall[] = [];
	const accepted = new Map<string, Record<string, unknown>>();
	const autonomous = new Set<string>();
	const dataErrors = new Map<string, string>();
	for (let i = Math.max(0, launchEntryCount); i < entries.length; i++) {
		const entry = entries[i];
		const acceptance = acceptedEntry(entry);
		if (acceptance) {
			accepted.set(acceptance.id, acceptance.args);
			if (acceptance.autonomous) autonomous.add(acceptance.id);
			if (acceptance.dataError !== undefined) dataErrors.set(acceptance.id, acceptance.dataError);
			const request = requested.get(acceptance.id);
			completed.push(request ?? { tool: acceptance.tool, id: acceptance.id, at: [i, 0], args: acceptance.args });
			continue;
		}
		if (entry.type !== "message" || !isRecord(entry.message)) continue;
		const message = entry.message;
		if (message.role === "toolResult") {
			const request = typeof message.toolCallId === "string" ? requested.get(message.toolCallId) : undefined;
			if (request && message.isError === false) completed.push(request);
			completed.push(...nestedCompletions(message, i));
			continue;
		}
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		message.content.forEach((block: unknown, b) => {
			if (!isRecord(block)) return;
			if (block.type === "text" && isNonBlank(block.text)) {
				texts.push({ at: [i, b], text: block.text });
			} else if (block.type === "toolCall" && typeof block.id === "string") {
				const tool = completionTool(block.name);
				if (tool)
					requested.set(block.id, {
						tool,
						id: block.id,
						at: [i, b],
						args: isRecord(block.arguments) ? block.arguments : {},
					});
			}
		});
	}
	const call = completed.reduce<CompletionCall | undefined>(
		(last, c) => (!last || before(last.at, c.at) ? c : last),
		undefined,
	);
	return { texts, accepted, dataErrors, autonomous, call };
}

/**
 * T70: who ended a run, from the watcher's end facts only. A requested stop names its origin (the
 * overlay operator, else the parent); a time limit and a wrap-up are the time limit; a ping and a
 * crash are the child's own end; a clean or failed exit is the child's unless a person closed the pane.
 */
export function endedByOf(
	end: RunEnd,
	facts: { stoppedBy?: "operator" | "parent"; closedByPerson: boolean; wrapUp?: boolean },
): EndedBy {
	switch (end.kind) {
		case "cancelled":
			return facts.stoppedBy ?? "parent";
		case "timed_out":
			return "time_limit";
		case "pinged":
			return "child";
		case "exited":
		case "failed":
			// D21: a wrap-up ran because of the time limit; a person who closed its pane still ended it.
			if (facts.closedByPerson) return "operator";
			return facts.wrapUp ? "time_limit" : "child";
	}
}

/**
 * T70: the files this run wrote: the targets the child recorded for its successful write and edit
 * calls (SUBAGENT_WRITTEN_FILE_ENTRY, already absolute), after the launch entry, deduplicated, in the
 * order of the first write.
 */
export function writtenFiles(entries: readonly SessionEntry[], launchEntryCount: number): string[] {
	const paths = new Set<string>();
	for (let i = Math.max(0, launchEntryCount); i < entries.length; i++) {
		const raw = entries[i] as { type?: unknown; customType?: unknown; data?: unknown };
		if (raw.type !== "custom" || raw.customType !== SUBAGENT_WRITTEN_FILE_ENTRY || !isRecord(raw.data)) continue;
		if (isNonBlank(raw.data.path)) paths.add(raw.data.path);
	}
	return [...paths];
}

/** Cuts `text` to at most `max` characters with the cut mark, never inside a surrogate pair. */
export function cutText(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = Math.max(0, max - CUT_MARK.length);
	if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
	return `${text.slice(0, end).trimEnd()}${CUT_MARK}`;
}

/** The text of the message of the last candidate block: its candidate blocks joined as session.ts does. */
function lastMessageText(candidates: readonly AssistantText[]): string | undefined {
	const last = candidates.at(-1);
	if (!last) return undefined;
	return candidates
		.filter((t) => t.at[0] === last.at[0])
		.map((t) => t.text)
		.join("\n");
}

/**
 * D12 report boundary, chosen apart from the typed flag. With a call: the last text before it, or the
 * last text of a later message (a takeover; never after a final call). Without a call: text before the
 * nudge wins over text after it.
 */
function reportText(
	texts: readonly AssistantText[],
	call: CompletionCall | undefined,
	final: boolean,
	nudgeEntryIndex: number | undefined,
): string | undefined {
	if (call) {
		if (!final && textAfterCall(texts, call)) return lastMessageText(texts);
		return lastMessageText(texts.filter((t) => before(t.at, call.at)));
	}
	if (nudgeEntryIndex === undefined) return lastMessageText(texts);
	return lastMessageText(texts.filter((t) => t.at[0] < nudgeEntryIndex)) ?? lastMessageText(texts);
}

/** Text in a message after the call's own message: the person took over the pane (D12). */
function textAfterCall(texts: readonly AssistantText[], call: CompletionCall): boolean {
	return texts.some((t) => t.at[0] > call.at[0]);
}

function nonBlankString(value: unknown): string | undefined {
	return isNonBlank(value) ? value : undefined;
}

function parseCallOutcome(value: unknown): CallOutcome | undefined {
	return CALL_OUTCOMES.find((outcome) => outcome === value);
}

function parseArtifacts(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : [];
}

function withNoReportLine(summary: string): string {
	return `${summary}\n\n${NO_REPORT_LINE}`;
}

/** The session path leaves the parent's text (D14); the exit facts keep the raw error. */
function withoutSessionPath(error: string, sessionFile: string | undefined): string {
	return sessionFile ? error.split(sessionFile).join("the session file") : error;
}

function describeEnd(end: RunEnd, sessionFile: string | undefined): string {
	switch (end.kind) {
		case "exited":
			return "the run ended without assistant text";
		case "failed":
			return `failed: ${withoutSessionPath(end.error, sessionFile)}`;
		case "timed_out":
			return `timed out after ${end.seconds}s (${end.budget})`;
		case "cancelled":
			return `cancelled: ${end.reason}`;
		case "pinged":
			return "the run asked its parent for help without a message";
	}
}

function endOutcome(end: RunEnd): ResultOutcome {
	switch (end.kind) {
		case "exited":
			return "done";
		case "failed":
			return "failed";
		case "timed_out":
			return "timed_out";
		case "cancelled":
			return "cancelled";
		case "pinged":
			return "blocked";
	}
}

function exitFacts(end: RunEnd): ExitFacts {
	switch (end.kind) {
		case "exited":
			return { code: end.code, signal: end.signal };
		case "pinged":
			return { code: end.code };
		case "failed":
			return { code: end.code, signal: end.signal, error: end.error };
		case "timed_out":
		case "cancelled":
			return {};
	}
}

function timeLimitFacts(end: RunEnd, wrapUp: WrapUpFact | undefined): TimeLimitFacts | undefined {
	if (end.kind === "timed_out") return { kind: end.budget, seconds: end.seconds, wrapUp: end.wrapUp };
	return wrapUp && { kind: wrapUp.budget, seconds: wrapUp.seconds, wrapUp: true };
}

interface Body {
	typing: ResultTyping;
	summarySource: SubagentSummarySource;
	outcome: ResultOutcome;
	summary: string;
	report: string;
	artifacts: string[];
}

/**
 * The arguments the child's tool executed, from the session or the exit record, else the call's
 * transcript arguments. D05: a JSON string in them keeps its string type, as the child's tool saw it.
 */
function callArgs(
	call: CompletionCall,
	recorded: ReadonlyMap<string, Record<string, unknown>>,
	accepted: RunFacts["acceptedCall"],
): Record<string, unknown> | undefined {
	const executed = recorded.get(call.id) ?? (accepted?.toolCallId === call.id ? accepted.args : undefined);
	if (executed) return executed;
	return call.args;
}

/** A typed body from an accepted call, or undefined when the call does not make the result typed (D12). */
function typedBody(
	call: CompletionCall,
	text: string | undefined,
	facts: RunFacts,
	recorded: ReadonlyMap<string, Record<string, unknown>>,
	dataErrors: ReadonlyMap<string, string>,
): Body | undefined {
	const args = callArgs(call, recorded, facts.acceptedCall);
	const dataError =
		dataErrors.get(call.id) ?? (facts.acceptedCall?.toolCallId === call.id ? facts.acceptedCall.dataError : undefined);
	if (!args) return undefined;
	if (call.tool === "ping") return pingBody(args.message);
	const outcome = parseCallOutcome(args.outcome);
	const summary = nonBlankString(args.summary);
	if (!outcome || !summary) return undefined;
	const report = text || withNoReportLine(summary);
	const typing: ResultTyping = dataError !== undefined ? { typed: true, dataError } : { typed: true, data: args.data };
	return {
		typing,
		summarySource: "subagent",
		outcome,
		summary,
		report,
		artifacts: parseArtifacts(args.artifacts),
	};
}

/**
 * D12: a caller_ping with a message is typed and blocked; its full message is both the summary and the
 * report. The exit record is the source on a ping end: the ping tool requests shutdown before
 * Pi can record its successful result, so the transcript may hold the request alone.
 */
function pingBody(value: unknown): Body | undefined {
	const message = nonBlankString(value);
	if (!message) return undefined;
	return {
		typing: { typed: true },
		summarySource: "subagent",
		outcome: "blocked",
		summary: message,
		report: message,
		artifacts: [],
	};
}

/**
 * The untyped report boundary: older sessions with a nudge entry keep the pre-T72 rule; otherwise the
 * selector reads this run's entries, up to a completion call that ended the run.
 */
function untypedReport(
	facts: RunFacts,
	texts: readonly AssistantText[],
	call: CompletionCall | undefined,
	final: boolean,
	callEnds: boolean,
): UntypedReport {
	if (facts.nudgeEntryIndex !== undefined) {
		return { text: reportText(texts, call, final, facts.nudgeEntryIndex), end: facts.end };
	}
	if (facts.noTranscript) return selectUntypedReport(undefined, facts.end, facts.processOutput);
	const stop = call && callEnds ? call.at[0] + 1 : facts.entries.length;
	return selectUntypedReport(
		facts.entries.slice(Math.max(0, facts.launchEntryCount), stop),
		facts.end,
		facts.processOutput,
	);
}

/** T70: an untyped run names the files it wrote, as no completion call listed them. */
function untypedBody(facts: RunFacts, selected: UntypedReport): Body {
	const { text, diagnostic, end } = selected;
	const outcome = endOutcome(end);
	const artifacts = writtenFiles(facts.entries, facts.launchEntryCount);
	const typing: ResultTyping = { typed: false };
	if (text) {
		return { typing, summarySource: "subagent", outcome, summary: text, report: text, artifacts };
	}
	const described = describeEnd(end, facts.sessionFile);
	if (!diagnostic) {
		return {
			typing,
			summarySource: "runtime",
			outcome,
			summary: described,
			report: withNoReportLine(described),
			artifacts,
		};
	}
	// cf6dbf4 put a failed child's stderr into its runtime-owned summary.
	const report = `${described}\n\n${diagnostic}`;
	return { typing, summarySource: "runtime", outcome, summary: report, report, artifacts };
}

/**
 * D7 and D12: a requested stop and a time limit decide the outcome over any call. The watchers file a
 * hard time limit only when no accepted completion reached the exit record first (isAcceptedCompletion,
 * keepsCompletionOverWrapUp), so a call that is still in the transcript then never ended the run: a
 * taken-over pane records its call without an exit record and keeps running into the deadline.
 */
function endOverridesCall(end: RunEnd): boolean {
	return end.kind === "cancelled" || end.kind === "timed_out";
}

/**
 * D14: turns the facts of one finished run into its record and report text. Pure: no file access.
 *
 * A completion call that succeeded types the result, unless a requested stop or a report-only
 * wrap-up ended the run, or assistant text in a later message (a takeover) followed a call that a
 * person's takeover left open (D7, D12). An autonomous call is final: later text is an
 * acknowledgement turn. The report boundary is chosen apart from the typed flag.
 */
export function assembleResult(facts: RunFacts): AssembledResult {
	const { texts, accepted, dataErrors, autonomous, call } = readTranscript(facts.entries, facts.launchEntryCount);
	// D21: a report-only wrap-up is untyped; a call from before its restart never decides its verdict.
	const runCall = facts.wrapUp ? undefined : call;
	const final = runCall !== undefined && autonomous.has(runCall.id);
	const callEnds = runCall !== undefined && (final || !textAfterCall(texts, runCall));
	const typing = runCall && callEnds && !endOverridesCall(facts.end);
	const typed =
		(facts.end.kind === "pinged" ? pingBody(facts.end.message) : undefined) ??
		(typing
			? typedBody(runCall, reportText(texts, runCall, final, facts.nudgeEntryIndex), facts, accepted, dataErrors)
			: undefined);
	const untyped = typed ? undefined : untypedReport(facts, texts, runCall, final, callEnds);
	const body = typed ?? untypedBody(facts, untyped ?? { end: facts.end });
	const end = untyped?.end ?? facts.end;
	const record: AssembledRecord = {
		...body.typing,
		runId: facts.runId,
		name: facts.name,
		agent: facts.agent,
		title: facts.title,
		modelRef: facts.modelRef,
		outcome: body.outcome,
		endedBy: facts.endedBy,
		summary: body.summary,
		sessionFile: facts.sessionFile,
		artifacts: body.artifacts,
		endedAt: facts.endedAt,
		elapsedSeconds: Math.max(0, (facts.endedAt - facts.startedAt) / 1000),
		exit: exitFacts(end),
		timeLimit: timeLimitFacts(end, facts.wrapUp),
		contextUsage: facts.contextUsage,
		resume: facts.resume,
	};
	return { record, report: body.report, summarySource: body.summarySource };
}
