import { homedir } from "node:os";
import { getSubagentTerminalStopReason, type SessionEntry } from "../session/session.ts";
import type { SubagentResult } from "../types.ts";
import { assembleResult, endedByOf, type RunEnd, type WrapUpFact } from "./result-assembler.ts";
import { parseRunId, type ResultRecord, type RunId } from "./result-record.ts";
import { renderResult } from "./result-render.ts";
import {
	CONTEXT_PRESSURE_RESUME_REASON,
	NO_SESSION_RESUME_REASON,
	STOPPED_REASON,
	TIME_LIMIT_RESUME_REASON,
} from "./run-result.ts";
import { hasRealSubagentOutput } from "./state.ts";

/** D13: what the footer says when a run ended without a published record (no results folder was reserved). */
const UNPUBLISHED_REPORT = "no result record was published for this run";

/** A result that reached a delivery path without a rendering, with the facts a footer needs. */
type UnpublishedResult = SubagentResult & {
	id?: string;
	agent?: string;
	status?: string;
	reportContextUsage?: boolean;
};

/** The end the result's fields describe, in the order the watcher decides it (D7, D12). */
function resultEnd(result: UnpublishedResult): RunEnd {
	if (result.status === "cancelled") return { kind: "cancelled", reason: STOPPED_REASON };
	if (result.ping) return { kind: "pinged", message: result.ping.message, code: result.exitCode };
	if (result.timedOut) {
		return { kind: "timed_out", budget: result.timedOut, seconds: result.timedOutAfter ?? 0, wrapUp: false };
	}
	if (result.errorMessage) return { kind: "failed", error: result.errorMessage, code: result.exitCode };
	// D12 (cf6dbf4 state.ts): an empty terminal stop fails the run, also after exit 0.
	if (getSubagentTerminalStopReason(result.summary)) {
		return { kind: "failed", error: result.summary, code: result.exitCode };
	}
	if (result.exitCode !== 0)
		return { kind: "failed", error: `exited with code ${result.exitCode}`, code: result.exitCode };
	return { kind: "exited", code: 0 };
}

/** D21: a report-only wrap-up that ended by itself keeps its time limit, whatever its own end. */
function wrapUpOf(result: UnpublishedResult, end: RunEnd): WrapUpFact | undefined {
	const wrapUp = result.timeoutWrapUp;
	if (!wrapUp || end.kind === "cancelled" || end.kind === "pinged" || end.kind === "timed_out") return undefined;
	return { budget: wrapUp.kind, seconds: wrapUp.seconds };
}

function resumeFacts(result: UnpublishedResult): ResultRecord["resume"] {
	if (!result.sessionFile) return { resumable: false, reason: NO_SESSION_RESUME_REASON };
	if (result.timedOut && result.timeoutBlocksResume) return { resumable: false, reason: TIME_LIMIT_RESUME_REASON };
	if (result.contextWarned) return { resumable: false, reason: CONTEXT_PRESSURE_RESUME_REASON };
	return { resumable: true };
}

function runIdOf(result: UnpublishedResult): RunId {
	try {
		return parseRunId(result.id ?? "");
	} catch {
		return parseRunId("unpublished");
	}
}

/**
 * D14: the one rendering for a result that carries none, for example a run whose watcher had no
 * results folder. The same assembler and renderer as every published end; the footer says that no
 * record exists, and the text names no session path and no resume command.
 */
export function resultTextOf(result: UnpublishedResult, parentCwd: string = process.cwd()): string {
	if (result.resultText !== undefined) return result.resultText;
	const endedAt = Date.now();
	const text = hasRealSubagentOutput(result) ? result.summary : "";
	const entries: SessionEntry[] = text
		? [{ type: "message", id: "result-summary", message: { role: "assistant", content: [{ type: "text", text }] } }]
		: [];
	const end = resultEnd(result);
	const wrapUp = wrapUpOf(result, end);
	const assembled = assembleResult({
		runId: runIdOf(result),
		name: result.name,
		agent: result.agent ?? "",
		sessionFile: result.sessionFile,
		startedAt: endedAt - result.elapsed * 1000,
		endedAt,
		end,
		// No watcher facts reach this path, so a stop names the parent and a close stays the child's.
		endedBy: endedByOf(end, { closedByPerson: false, wrapUp: wrapUp !== undefined }),
		wrapUp,
		entries,
		launchEntryCount: 0,
		contextUsage:
			result.contextTokens !== undefined ? { tokens: result.contextTokens, window: result.contextWindow } : undefined,
		resume: resumeFacts(result),
	});
	const record: ResultRecord = { ...assembled.record, report: { saved: false, error: UNPUBLISHED_REPORT } };
	// The same unconfirmed-kill warning the published path adds: the pane can still be running.
	return renderResult(record, {
		cwd: parentCwd,
		homeDir: homedir(),
		showContextUsage: result.reportContextUsage !== false,
		killUnconfirmed: Boolean(result.timedOut && result.timeoutKillFailed),
	});
}
