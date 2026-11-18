import type { SubagentTimeoutKind } from "../types.ts";

/** Outcomes of a finished run (D13). A completion call can state only the first three. */
export type ResultOutcome = "done" | "partial" | "blocked" | "failed" | "timed_out" | "cancelled";
export type CallOutcome = Extract<ResultOutcome, "done" | "partial" | "blocked">;

export const CALL_OUTCOMES: readonly CallOutcome[] = ["done", "partial", "blocked"];

/** D12: a summary holds at most this many characters, the cut mark included. */
export const SUMMARY_MAX_CHARS = 1500;

/** Appended where the assembler or the renderer shortens text. */
export const CUT_MARK = " [cut]";

declare const runIdBrand: unique symbol;
/** Run id of one result folder (D13). T06 reserves it; this module only carries it. */
export type RunId = string & { readonly [runIdBrand]: true };

/** One path segment: no separator, no dot-only name, no control character. */
export function parseRunId(value: string): RunId {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`invalid run id: ${JSON.stringify(value)}`);
	return value as RunId;
}

/**
 * Typed results carry data or a data error, never both (D12); untyped results carry neither.
 */
export type ResultTyping =
	| { typed: true; data?: unknown; dataError?: undefined }
	| { typed: true; data?: undefined; dataError: string }
	| { typed: false; data?: undefined; dataError?: undefined };

export type ResumeFacts = { resumable: true } | { resumable: false; reason: string };

export interface ExitFacts {
	code?: number;
	signal?: string;
	/** Watcher or process error text for a failed run. */
	error?: string;
}

export interface TimeLimitFacts {
	kind: SubagentTimeoutKind;
	seconds: number;
	/** True when the run ended in report-only wrap-up (D7). */
	wrapUp: boolean;
}

export interface ContextUsage {
	tokens: number;
	window?: number;
}

/** The record the assembler builds; the publisher (T06) adds where the report went. */
export type AssembledRecord = ResultTyping & {
	runId: RunId;
	name: string;
	agent: string;
	title?: string;
	modelRef?: string;
	outcome: ResultOutcome;
	/** At most SUMMARY_MAX_CHARS characters. */
	summary: string;
	sessionFile?: string;
	artifacts: string[];
	/** Epoch milliseconds. */
	endedAt: number;
	elapsedSeconds: number;
	exit: ExitFacts;
	timeLimit?: TimeLimitFacts;
	contextUsage?: ContextUsage;
	resume: ResumeFacts;
};

/** D13: a result names a saved report file, or says why the report was not saved. */
export type ReportStorage = { saved: true; path: string } | { saved: false; error: string };

export type ResultRecord = AssembledRecord & { report: ReportStorage };
