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

/** Position of an assistant content block: entry index, then block index. */
type Position = readonly [entry: number, block: number];

interface AssistantText {
	at: Position;
	text: string;
}

type CompletionCall =
	| { tool: "done"; at: Position; args: Record<string, unknown> }
	| { tool: "ping"; at: Position; args: Record<string, unknown> };

interface RunTranscript {
	texts: AssistantText[];
	/** The last completion call that was not refused, if any. */
	call?: CompletionCall;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function before(a: Position, b: Position): boolean {
	return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

/** Reads assistant text and completion calls of this run; tool output never counts as text (D12). */
function readTranscript(entries: readonly SessionEntry[], launchEntryCount: number): RunTranscript {
	const texts: AssistantText[] = [];
	const calls: Array<CompletionCall & { id?: string }> = [];
	const refusedCallIds = new Set<string>();
	for (let i = Math.max(0, launchEntryCount); i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "message" || !isRecord(entry.message)) continue;
		const message = entry.message;
		if (message.role === "toolResult") {
			if (message.isError === true && typeof message.toolCallId === "string") refusedCallIds.add(message.toolCallId);
			continue;
		}
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		message.content.forEach((block: unknown, b) => {
			if (!isRecord(block)) return;
			if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
				texts.push({ at: [i, b], text: block.text.trim() });
			} else if (block.type === "toolCall" && isRecord(block.arguments)) {
				const tool =
					block.name === SUBAGENT_DONE_TOOL_NAME ? "done" : block.name === CALLER_PING_TOOL_NAME ? "ping" : undefined;
				const id = typeof block.id === "string" ? block.id : undefined;
				if (tool) calls.push({ tool, at: [i, b], args: block.arguments, id });
			}
		});
	}
	const accepted = calls.filter((call) => call.id === undefined || !refusedCallIds.has(call.id));
	const last = accepted.at(-1);
	return { texts, call: last && { tool: last.tool, at: last.at, args: last.args } };
}

/** Cuts `text` to at most `max` characters with the cut mark, never inside a surrogate pair. */
export function cutText(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = Math.max(0, max - CUT_MARK.length);
	if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
	return `${text.slice(0, end).trimEnd()}${CUT_MARK}`;
}

/** D14: the start of the report cut at a line end within the limit; one long line is cut inside. */
export function cutAtLineEnd(text: string, max: number): string {
	if (text.length <= max) return text;
	const room = max - CUT_MARK.length;
	const lineEnd = text.lastIndexOf("\n", room);
	if (lineEnd <= 0) return cutText(text, max);
	return `${text.slice(0, lineEnd).trimEnd()}${CUT_MARK}`;
}

function lastText(texts: readonly AssistantText[]): string | undefined {
	return texts.at(-1)?.text;
}

/** D12 report source of a run without an accepted call: text before the nudge wins over text after it. */
function untypedReportText(texts: readonly AssistantText[], nudgeEntryIndex: number | undefined): string | undefined {
	if (nudgeEntryIndex === undefined) return lastText(texts);
	return lastText(texts.filter((t) => t.at[0] < nudgeEntryIndex)) ?? lastText(texts);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function describeEnd(end: RunEnd): string {
	switch (end.kind) {
		case "exited":
			return "the run ended without assistant text";
		case "failed":
			return `failed: ${end.error}`;
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
function typedBody(call: CompletionCall, transcript: RunTranscript, dataError: string | undefined): Body | undefined {
	if (call.tool === "ping") {
		const message = nonEmptyString(call.args.message);
		if (!message) return undefined;
		return {
			typing: { typed: true },
			outcome: "blocked",
			summary: cutText(message, SUMMARY_MAX_CHARS),
			report: message,
			artifacts: [],
		};
	}
	const outcome = parseCallOutcome(call.args.outcome);
	const fullSummary = nonEmptyString(call.args.summary);
	if (!outcome || !fullSummary) return undefined;
	const text = lastText(transcript.texts.filter((t) => before(t.at, call.at)));
	const longSummary = fullSummary.length > SUMMARY_MAX_CHARS;
	const report = text
		? longSummary
			? `${fullSummary}\n\n${text}`
			: text
		: withNoReportLine(fullSummary);
	const typing: ResultTyping =
		dataError !== undefined ? { typed: true, dataError } : { typed: true, data: call.args.data };
	return {
		typing,
		outcome,
		summary: cutText(fullSummary, SUMMARY_MAX_CHARS),
		report,
		artifacts: parseArtifacts(call.args.artifacts),
	};
}

function untypedBody(facts: RunFacts, transcript: RunTranscript): Body {
	const text = untypedReportText(transcript.texts, facts.nudgeEntryIndex);
	const outcome = endOutcome(facts.end);
	if (!text) {
		const summary = cutText(describeEnd(facts.end), SUMMARY_MAX_CHARS);
		return { typing: { typed: false }, outcome, summary, report: withNoReportLine(summary), artifacts: [] };
	}
	return { typing: { typed: false }, outcome, summary: cutAtLineEnd(text, SUMMARY_MAX_CHARS), report: text, artifacts: [] };
}

/**
 * D14: turns the facts of one finished run into its record and report text. Pure: no file access.
 *
 * An accepted completion call types the result, whatever way the process then ended: the call is the
 * child's own end of the run. Assistant text after the call (a pane child after a takeover) makes the
 * result untyped again, built from that text (D12).
 */
export function assembleResult(facts: RunFacts): AssembledResult {
	const transcript = readTranscript(facts.entries, facts.launchEntryCount);
	const call = transcript.call;
	const textAfterCall = call !== undefined && transcript.texts.some((t) => before(call.at, t.at));
	const typed = call && !textAfterCall ? typedBody(call, transcript, facts.dataError) : undefined;
	const body = typed ?? untypedBody(facts, transcript);
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
