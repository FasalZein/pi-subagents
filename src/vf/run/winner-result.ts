import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assembleResult, cutText, type RunEnd } from "../../runtime/result-assembler.ts";
import { publishResult, type Reservation, readResultRecord } from "../../runtime/result-files.ts";
import { parseRunId, type ResultRecord, SUMMARY_MAX_CHARS } from "../../runtime/result-record.ts";
import { renderResult, type VerifierFooter } from "../../runtime/result-render.ts";
import type { SessionEntry } from "../../session/session.ts";
import type { SubagentParamsInput, SubagentResult } from "../../types.ts";
import type { VerifiedRunManifest } from "./types.ts";

/** A verified run's result with the renderer's text, which every carrier shows. */
export type RenderedVerifiedResult = SubagentResult & { resultText: string };

/** D18: an attempt of a verified fan-out is never resumed. */
const NO_ATTEMPT_RESUME_REASON = "a verified fan-out attempt cannot be resumed; launch a new run for unfinished work";

/** D18: the record and report files of a verified run live with the run, so adoption and a retry find them. */
function runResultFolder(runDir: string): string {
	return join(runDir, "result");
}

interface WinnerText {
	end: RunEnd;
	report: string;
	verifierFooter?: VerifierFooter;
}

/**
 * D18: the full provenance of the selection, kept in the report file: N, winner id, rank, criteria,
 * verifier token usage, the artifact folder, and the inspect or undo commands of the applied winner.
 * The rank is the verifier's relative preference between attempts, not a grade.
 */
function provenance(manifest: VerifiedRunManifest, runDir: string): string {
	const selection = manifest.result!.selection!;
	const apply = manifest.result!.apply;
	const usage = selection.usage;
	const applyLine = apply?.applied
		? `winner changes staged — inspect \`git diff --staged\`; undo only if the user asks: \`git reset --hard ${manifest.request.baseCommit}\``
		: apply
			? `winner not applied (${apply.code}); kept on branch \`${selection.winnerBranch}\``
			: `winner kept on branch \`${selection.winnerBranch}\``;
	return (
		`[llm-as-a-verifier ${manifest.runId}: winner w${selection.winnerIndex} of ` +
		`${manifest.request.candidateCount} attempts (${selection.distinctCandidates} distinct), ` +
		`rank ${selection.winnerScore.toFixed(3)}, criteria ${selection.criteria.join("+")}, ` +
		`verifier ${selection.model} (${usage.calls} calls, ${usage.inputTokens} in / ${usage.outputTokens} out tokens)\n` +
		`${applyLine}; artifacts ${runDir}]`
	);
}

/** D18: the staged or not-applied fact survives every cap; the short detail tells how to inspect it. */
function verifierFooter(manifest: VerifiedRunManifest): VerifierFooter {
	const selection = manifest.result!.selection!;
	const apply = manifest.result!.apply;
	const pick = `w${selection.winnerIndex} of ${manifest.request.candidateCount}`;
	if (apply?.applied) return { winner: "staged", detail: `${pick}; inspect git diff --staged` };
	const reason = apply ? ` (${apply.code})` : "";
	return { winner: "not applied", detail: `${pick}${reason}; kept on branch ${selection.winnerBranch}` };
}

function winnerText(manifest: VerifiedRunManifest, runDir: string): WinnerText {
	const result = manifest.result;
	if (!result) {
		const error = `run ${manifest.state} without a result`;
		return {
			end: { kind: "failed", error },
			report: `llm-as-a-verifier run ${manifest.runId} is ${manifest.state} with no recorded result.`,
		};
	}
	if (result.ok && result.selection) {
		return {
			end: { kind: "exited", code: 0 },
			report: `${result.selection.winnerReport}\n\n${provenance(manifest, runDir)}`,
			verifierFooter: verifierFooter(manifest),
		};
	}
	const error = result.failure ? `${result.failure.code}: ${result.failure.message}` : "run failed";
	return {
		end: { kind: "failed", error },
		report: result.failure?.message ?? `llm-as-a-verifier run ${manifest.runId} failed.`,
	};
}

/** The report text as the one assistant message of the run, so the assembler reads it like any report. */
function reportEntries(report: string): SessionEntry[] {
	const entry: SessionEntry = {
		type: "message",
		id: "verified-report",
		message: { role: "assistant", content: [{ type: "text", text: report }] },
	};
	return [entry];
}

/**
 * D18 and D14: turns a verified run into ONE logical result. The winner report and its provenance go
 * through the assembler into the run's report file; the parent's text is the renderer's, with the
 * verifier footer inside the frame. Each call publishes one revision, so a retry's newer generation
 * switches the run's record to its own report (D13). `parentCwd` is the receiving parent's working
 * directory, for the shortest report locator.
 */
export function verifiedRunToSubagentResult(
	manifest: VerifiedRunManifest,
	runDir: string,
	params: Pick<SubagentParamsInput, "name" | "task">,
	startTime: number,
	parentCwd: string = manifest.request.sourceRepo,
): RenderedVerifiedResult {
	const text = winnerText(manifest, runDir);
	const endedAt = Date.now();
	const winnerSession = manifest.result?.selection?.winnerSessionFile;
	const sessionFile = winnerSession ?? (manifest.result ? undefined : manifest.request.candidates[0]?.sessionFile);
	const assembled = assembleResult({
		runId: parseRunId(manifest.runId),
		name: params.name,
		agent: manifest.request.agent,
		sessionFile,
		startedAt: startTime,
		endedAt,
		end: text.end,
		entries: reportEntries(text.report),
		launchEntryCount: 0,
		resume: { resumable: false, reason: NO_ATTEMPT_RESUME_REASON },
	});
	const record = publishResult(reserveRunFolder(manifest, runDir), assembled);
	const rendered = renderVerified(record, parentCwd, text.verifierFooter);
	return {
		name: params.name,
		task: params.task,
		summary: rendered,
		summarySource: "subagent",
		sessionFile,
		exitCode: text.end.kind === "exited" ? 0 : 1,
		elapsed: Math.max(0, (endedAt - startTime) / 1000),
		...(text.end.kind === "failed" ? { errorMessage: text.end.error } : {}),
		resultText: rendered,
		resultRunId: record.runId,
		resultOutcome: record.outcome,
		...(record.report.saved ? { reportFile: record.report.path } : {}),
	};
}

/**
 * A notice about a verified run that is not its winner report (the report was already delivered,
 * or this session stopped watching): the same renderer, with the notice as the summary. It names
 * the run's committed report when one exists and never publishes a revision.
 */
export function verifiedRunNotice(
	manifest: VerifiedRunManifest,
	runDir: string,
	params: Pick<SubagentParamsInput, "name" | "task">,
	startTime: number,
	notice: string,
	parentCwd: string = manifest.request.sourceRepo,
): RenderedVerifiedResult {
	const endedAt = Date.now();
	let committed: ResultRecord | undefined;
	try {
		committed = readResultRecord(runResultFolder(runDir));
	} catch {
		committed = undefined;
	}
	const record: ResultRecord = committed ?? {
		...assembleResult({
			runId: parseRunId(manifest.runId),
			name: params.name,
			agent: manifest.request.agent,
			startedAt: startTime,
			endedAt,
			end: { kind: "exited", code: 0 },
			entries: reportEntries(notice),
			launchEntryCount: 0,
			resume: { resumable: false, reason: NO_ATTEMPT_RESUME_REASON },
		}).record,
		report: { saved: false, error: "the run continues; its report is published with the run when it ends" },
	};
	const rendered = renderVerified({ ...record, summary: cutText(notice, SUMMARY_MAX_CHARS) }, parentCwd, undefined);
	return {
		name: params.name,
		task: params.task,
		summary: rendered,
		exitCode: 0,
		elapsed: Math.max(0, (endedAt - startTime) / 1000),
		sessionFile: record.sessionFile ?? manifest.request.candidates[0]?.sessionFile,
		resultText: rendered,
		resultRunId: record.runId,
		resultOutcome: record.outcome,
		...(record.report.saved ? { reportFile: record.report.path } : {}),
	};
}

function renderVerified(record: ResultRecord, parentCwd: string, footer: VerifierFooter | undefined): string {
	return renderResult(record, { cwd: parentCwd, homeDir: homedir(), verifierFooter: footer });
}

function reserveRunFolder(manifest: VerifiedRunManifest, runDir: string): Reservation {
	const runId = parseRunId(manifest.runId);
	const folder = runResultFolder(runDir);
	try {
		mkdirSync(folder, { recursive: true });
		return { runId, folder };
	} catch (error) {
		return { runId, error: error instanceof Error ? error.message : String(error) };
	}
}
