import type { SessionEntry } from "../session/session.ts";
import { CALLER_PING_TOOL_NAME, SUBAGENT_DONE_TOOL_NAME } from "../tools/tool-names.ts";
import type { SubagentTimeoutKind } from "../types.ts";
import {
	type AssembledRecord,
	CALL_OUTCOMES,
	type CallOutcome,
	type ContextUsage,
	CUT_MARK,
	type ExitFacts,
	type ResultOutcome,
	type ResultTyping,
	type ResumeFacts,
	type RunId,
	SUMMARY_MAX_CHARS,
	type TimeLimitFacts,
} from "./result-record.ts";

/** D12: the report line of a run without assistant text. */
export const NO_REPORT_LINE = "no report beyond the summary";

/** How the run ended, as the watcher saw it. */
export type RunEnd =
	| { kind: "exited"; code?: number; signal?: string }
	| { kind: "failed"; error: string; code?: number; signal?: string }
	| { kind: "timed_out"; budget: SubagentTimeoutKind; seconds: number; wrapUp: boolean }
	| { kind: "cancelled"; reason: string };

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
	/** Every entry of the child session file, in file order. */
	entries: readonly SessionEntry[];
	/** Entries before this index belong to fork history or an earlier run (D12). */
	launchEntryCount: number;
	/** Index in `entries` of the missing-call nudge message, when one was sent. */
	nudgeEntryIndex?: number;
	/** Set when the accepted completion call carried data that failed its schema twice (D12). */
	dataError?: string;
	contextUsage?: ContextUsage;
	resume: ResumeFacts;
}

export interface AssembledResult {
	record: AssembledRecord;
	report: string;
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
 * undefined when Pi omitted oversize nested arguments; such a call ends the run untyped.
 */
interface CompletionCall {
	tool: CompletionTool;
	at: Position;
	args: Record<string, unknown> | undefined;
}

interface RunTranscript {
	texts: AssistantText[];
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
		if (!isRecord(record) || record.status !== "ok") return;
		const tool = completionTool(record.name);
		if (tool) calls.push({ tool, at: [entry, index], args: isRecord(record.arguments) ? record.arguments : undefined });
	});
	return calls;
}

/**
 * Reads assistant text and completion facts of this run; tool output never counts as text (D12).
 * A completion is accepted only from its successful result, never from a request alone (D14).
 */
function readTranscript(entries: readonly SessionEntry[], launchEntryCount: number): RunTranscript {
	const texts: AssistantText[] = [];
	const requested = new Map<string, CompletionCall>();
	const completed: CompletionCall[] = [];
	for (let i = Math.max(0, launchEntryCount); i < entries.length; i++) {
		const entry = entries[i];
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
				if (tool) requested.set(block.id, { tool, at: [i, b], args: isRecord(block.arguments) ? block.arguments : {} });
			}
		});
	}
	const call = completed.reduce<CompletionCall | undefined>(
		(last, c) => (!last || before(last.at, c.at) ? c : last),
		undefined,
	);
	return { texts, call };
}

/** Cuts `text` to at most `max` characters with the cut mark, never inside a surrogate pair. */
export function cutText(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = Math.max(0, max - CUT_MARK.length);
	if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
	return `${text.slice(0, end).trimEnd()}${CUT_MARK}`;
}

/** D14: the start of the report cut at a line end within the limit; one long line is cut inside. */
function cutAtLineEnd(text: string, max: number): string {
	if (text.length <= max) return text;
	const room = max - CUT_MARK.length;
	const lineEnd = text.lastIndexOf("\n", room);
	if (lineEnd <= 0) return cutText(text, max);
	return `${text.slice(0, lineEnd).trimEnd()}${CUT_MARK}`;
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
 * last text of a later message (a takeover). Without a call: text before the nudge wins over text
 * after it.
 */
function reportText(texts: readonly AssistantText[], call: CompletionCall | undefined, nudgeEntryIndex: number | undefined): string | undefined {
	if (call) {
		if (textAfterCall(texts, call)) return lastMessageText(texts);
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
	}
}

function exitFacts(end: RunEnd): ExitFacts {
	switch (end.kind) {
		case "exited":
			return { code: end.code, signal: end.signal };
		case "failed":
			return { code: end.code, signal: end.signal, error: end.error };
		case "timed_out":
		case "cancelled":
			return {};
	}
}

function timeLimitFacts(end: RunEnd): TimeLimitFacts | undefined {
	return end.kind === "timed_out" ? { kind: end.budget, seconds: end.seconds, wrapUp: end.wrapUp } : undefined;
}

interface Body {
	typing: ResultTyping;
	outcome: ResultOutcome;
	summary: string;
	report: string;
	artifacts: string[];
}

/** A typed body from an accepted call, or undefined when the call does not make the result typed (D12). */
function typedBody(call: CompletionCall, text: string | undefined, dataError: string | undefined): Body | undefined {
	const args = call.args;
	if (!args) return undefined;
	if (call.tool === "ping") {
		const message = nonBlankString(args.message);
		if (!message) return undefined;
		return {
			typing: { typed: true },
			outcome: "blocked",
			summary: cutText(message, SUMMARY_MAX_CHARS),
			report: message,
			artifacts: [],
		};
	}
	const outcome = parseCallOutcome(args.outcome);
	const fullSummary = nonBlankString(args.summary);
	if (!outcome || !fullSummary) return undefined;
	const longSummary = fullSummary.length > SUMMARY_MAX_CHARS;
	const report = text ? (longSummary ? `${fullSummary}\n\n${text}` : text) : withNoReportLine(fullSummary);
	const typing: ResultTyping = dataError !== undefined ? { typed: true, dataError } : { typed: true, data: args.data };
	return {
		typing,
		outcome,
		summary: cutText(fullSummary, SUMMARY_MAX_CHARS),
		report,
		artifacts: parseArtifacts(args.artifacts),
	};
}

function untypedBody(facts: RunFacts, text: string | undefined): Body {
	const outcome = endOutcome(facts.end);
	if (!text) {
		const summary = cutText(describeEnd(facts.end, facts.sessionFile), SUMMARY_MAX_CHARS);
		return { typing: { typed: false }, outcome, summary, report: withNoReportLine(summary), artifacts: [] };
	}
	return { typing: { typed: false }, outcome, summary: cutAtLineEnd(text, SUMMARY_MAX_CHARS), report: text, artifacts: [] };
}

/** D7 and D12: a requested stop and a report-only wrap-up decide the outcome over any call. */
function endOverridesCall(end: RunEnd): boolean {
	return end.kind === "cancelled" || (end.kind === "timed_out" && end.wrapUp);
}

/**
 * D14: turns the facts of one finished run into its record and report text. Pure: no file access.
 *
 * A completion call that succeeded types the result, unless a requested stop or a report-only
 * wrap-up ended the run, or assistant text in a later message (a takeover) followed the call (D7,
 * D12). The report boundary is chosen apart from the typed flag.
 */
export function assembleResult(facts: RunFacts): AssembledResult {
	const { texts, call } = readTranscript(facts.entries, facts.launchEntryCount);
	const text = reportText(texts, call, facts.nudgeEntryIndex);
	const typing = call && !textAfterCall(texts, call) && !endOverridesCall(facts.end);
	const body = (typing ? typedBody(call, text, facts.dataError) : undefined) ?? untypedBody(facts, text);
	const record: AssembledRecord = {
		...body.typing,
		runId: facts.runId,
		name: facts.name,
		agent: facts.agent,
		title: facts.title,
		modelRef: facts.modelRef,
		outcome: body.outcome,
		summary: body.summary,
		sessionFile: facts.sessionFile,
		artifacts: body.artifacts,
		endedAt: facts.endedAt,
		elapsedSeconds: Math.max(0, (facts.endedAt - facts.startedAt) / 1000),
		exit: exitFacts(facts.end),
		timeLimit: timeLimitFacts(facts.end),
		contextUsage: facts.contextUsage,
		resume: facts.resume,
	};
	return { record, report: body.report };
}
