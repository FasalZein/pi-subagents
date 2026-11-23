import type { SubagentTimeoutKind } from "../types.ts";

/** Outcomes of a finished run (D13). A completion call can state only the first three. */
export type ResultOutcome = "done" | "partial" | "blocked" | "failed" | "timed_out" | "cancelled";
export type CallOutcome = Extract<ResultOutcome, "done" | "partial" | "blocked">;

export const CALL_OUTCOMES: readonly CallOutcome[] = ["done", "partial", "blocked"];

/** Appended where the renderer or a line of the recent list shortens text. */
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

/**
 * T70: who ended the run. child: its completion call, caller_ping, its own exit or a crash. operator: a
 * person closed the pane (also after a takeover) or stopped the run from the overlay. parent: subagent_kill
 * or another stop of the parent. time_limit: a hard kill or a report-only wrap-up.
 */
export type EndedBy = "child" | "operator" | "parent" | "time_limit";

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

/** The fields every record has, published before T70 or after. */
type RecordFields = {
	runId: RunId;
	name: string;
	agent: string;
	title?: string;
	modelRef?: string;
	outcome: ResultOutcome;
	/** The child's whole answer or ping message, or the runtime's account of the end; never cut. */
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

/** The record the assembler builds; every new record names its ender (T70). The publisher adds the report. */
export type AssembledRecord = ResultTyping & RecordFields & { endedBy: EndedBy };

/** D13: a result names a saved report file, or says why the report was not saved. */
export type ReportStorage = { saved: true; path: string } | { saved: false; error: string };

/**
 * A record as readers get it. A record stored before T70 has no endedBy, so a reader may not rely on
 * it; publication still requires it (AssembledRecord).
 */
export type ResultRecord = ResultTyping & RecordFields & { endedBy?: EndedBy; report: ReportStorage };
