import { homedir } from "node:os";
import type { SessionEntry } from "../session/session.ts";
import type { SubagentResult } from "../types.ts";
import { assembleResult, type RunEnd } from "./result-assembler.ts";
import { parseRunId, type ResultRecord, type RunId } from "./result-record.ts";
import { renderResult } from "./result-render.ts";
import {
	CONTEXT_PRESSURE_RESUME_REASON,
	KILL_UNCONFIRMED_WARNING,
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
	if (result.exitCode === 0 && result.timeoutWrapUp) {
		return {
			kind: "timed_out",
			budget: result.timeoutWrapUp.kind,
			seconds: result.timeoutWrapUp.seconds,
			wrapUp: true,
		};
	}
	if (result.exitCode !== 0)
		return { kind: "failed", error: `exited with code ${result.exitCode}`, code: result.exitCode };
	return { kind: "exited", code: 0 };
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
	const assembled = assembleResult({
		runId: runIdOf(result),
		name: result.name,
		agent: result.agent ?? "",
		sessionFile: result.sessionFile,
		startedAt: endedAt - result.elapsed * 1000,
		endedAt,
		end: resultEnd(result),
		entries,
		launchEntryCount: 0,
		contextUsage:
			result.contextTokens !== undefined ? { tokens: result.contextTokens, window: result.contextWindow } : undefined,
		resume: resumeFacts(result),
	});
	const record: ResultRecord = { ...assembled.record, report: { saved: false, error: UNPUBLISHED_REPORT } };
	// The same unconfirmed-kill warning the published path adds: the pane can still be running.
	const warnings = result.timedOut && result.timeoutKillFailed ? [KILL_UNCONFIRMED_WARNING] : [];
	return renderResult(record, {
		cwd: parentCwd,
		homeDir: homedir(),
		showContextUsage: result.reportContextUsage !== false,
		warnings,
	});
}
