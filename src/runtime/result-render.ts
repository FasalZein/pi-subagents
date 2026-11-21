import { isAbsolute, relative } from "node:path";
import { formatElapsedSeconds } from "../tools/overlay/render-helpers.ts";
import { SUBAGENT_RESUME_TOOL_NAME } from "../tools/tool-names.ts";
import { cutText } from "./result-assembler.ts";
import { CUT_MARK, type EndedBy, type ResultOutcome, type ResultRecord, SUMMARY_MAX_CHARS } from "./result-record.ts";

/** D14: everything around the summary, unless a long report locator needs more. */
export const FRAME_MAX_CHARS = 400;
/** D14 and G1.3: the whole rendered text. */
export const RESULT_TEXT_MAX_CHARS = 1900;

/** Header names and short footer facts stay this short so the summary keeps its room. */
const NAME_MAX_CHARS = 60;
const FACT_MAX_CHARS = 160;

interface RenderOptions {
	/** The parent's working directory, for the relative report locator. */
	cwd: string;
	homeDir: string;
	warnings?: readonly string[];
	/** Warnings that survive every cap, such as an unconfirmed kill; the other warnings get the rest. */
	requiredWarnings?: readonly string[];
	/** Verified fan-out footer (D18), kept inside the frame. */
	verifierFooter?: VerifierFooter;
	/** True when the agent asks for the context usage line. */
	showContextUsage?: boolean;
}

/**
 * D18: the winner fact survives every cap; the descriptive text (for example the provenance) gets the
 * room the other required fields leave.
 */
export interface VerifierFooter {
	winner: "staged" | "not applied";
	detail?: string;
}

export const OUTCOME_WORDS: Record<ResultOutcome, string> = {
	done: "done",
	partial: "partial",
	blocked: "blocked",
	failed: "failed",
	timed_out: "timed out",
	cancelled: "cancelled",
};

/** T70: the header names who ended the run only when it was not the child, so the common case adds no text. */
const ENDED_BY_WORDS: Record<EndedBy, string | undefined> = {
	child: undefined,
	operator: "ended by operator",
	parent: "ended by parent",
	time_limit: "ended by time limit",
};

function isHomePath(path: string, homeDir: string): boolean {
	return homeDir !== "" && path.startsWith(homeDir.endsWith("/") ? homeDir : `${homeDir}/`);
}

/**
 * D14: the shortest form of an absolute path that Pi's read tool resolves back to it: the path itself,
 * ~/ plus the path under the home folder, or the path relative to the working directory. Pi strips a
 * leading @ and expands a leading ~, so a relative form that starts with either is not a candidate.
 */
export function shortestReadLocator(path: string, cwd: string, homeDir: string): string {
	if (!isAbsolute(path)) return path;
	const candidates = [path];
	if (isHomePath(path, homeDir)) candidates.push(`~/${path.slice(homeDir.replace(/\/$/, "").length + 1)}`);
	const fromCwd = relative(cwd, path);
	if (fromCwd !== "" && !isAbsolute(fromCwd) && !/^[@~]/.test(fromCwd)) candidates.push(fromCwd);
	return candidates.reduce((best, candidate) => (candidate.length < best.length ? candidate : best));
}

function headerLine(record: ResultRecord): string {
	const parts = [
		cutText(record.name, NAME_MAX_CHARS),
		cutText(record.agent, NAME_MAX_CHARS),
		OUTCOME_WORDS[record.outcome],
		formatElapsedSeconds(record.elapsedSeconds),
		record.typed ? "typed" : "untyped",
	];
	// A record stored before T70 has no endedBy and gets no words.
	const endedBy = record.endedBy && ENDED_BY_WORDS[record.endedBy];
	if (endedBy) parts.push(endedBy);
	if (record.dataError !== undefined) parts.push("data error");
	return parts.join(" · ");
}

/**
 * One required footer line: the fact always stays; the detail after ": " gets at most `max`
 * characters of the room the facts leave, in `priority` order (lower first).
 */
interface RequiredLine {
	fact: string;
	detail?: { text: string; max: number; priority: number };
}

/** Separates a fact from its detail. */
const DETAIL_SEPARATOR = ": ";

/**
 * T88: a resumable run that a time limit ended or wrapped up is continued, not relaunched: the footer
 * names the resume call instead of the bare run id (audit row 6: relaunches after a time-limit PARTIAL).
 */
function resumeCall(record: ResultRecord): string | undefined {
	if (!record.timeLimit || !record.resume.resumable) return undefined;
	return `${SUBAGENT_RESUME_TOOL_NAME}({ runId: "${record.runId}" })`;
}

/** T88: one line says the run id once, as the run fact or inside the resume call, then the report file. */
function runAndReportLine(record: ResultRecord, options: RenderOptions): RequiredLine {
	const call = resumeCall(record);
	const run = call ? `resume: ${call}` : `run: ${record.runId}`;
	if (!record.report.saved) {
		return {
			fact: `${run} · report not saved`,
			detail: { text: record.report.error, max: FACT_MAX_CHARS, priority: 1 },
		};
	}
	return { fact: `${run} · report: ${shortestReadLocator(record.report.path, options.cwd, options.homeDir)}` };
}

/**
 * T88: the context line costs every result about 10 tokens, so it shows only when the child used at
 * least this share of a known window, where the parent may need it to size a resume or a next task.
 */
export const CONTEXT_LINE_MIN_PERCENT = 80;

function contextLine(record: ResultRecord): RequiredLine | undefined {
	const usage = record.contextUsage;
	if (!usage?.window || usage.tokens * 100 < usage.window * CONTEXT_LINE_MIN_PERCENT) return undefined;
	return { fact: `context: ${usage.tokens}/${usage.window} tokens` };
}

/**
 * Footer lines D14 and D18 require: the report file, the run id, why a run cannot resume, the verifier
 * footer (its staged or not-applied fact must survive the cap), requested context usage. The resume
 * reason gets room first, then the storage diagnostic, then the verifier's descriptive text.
 */
function requiredLines(record: ResultRecord, options: RenderOptions): RequiredLine[] {
	const lines: RequiredLine[] = [runAndReportLine(record, options)];
	if (!record.resume.resumable) {
		lines.push({ fact: "not resumable", detail: { text: record.resume.reason, max: FACT_MAX_CHARS, priority: 0 } });
	}
	const timeLimit = timeLimitLine(record);
	if (timeLimit) lines.push(timeLimit);
	const verifier = options.verifierFooter;
	if (verifier) {
		const fact = `verifier: winner ${verifier.winner}`;
		lines.push({
			fact,
			detail: verifier.detail ? { text: verifier.detail, max: FRAME_MAX_CHARS, priority: 2 } : undefined,
		});
	}
	const context = options.showContextUsage ? contextLine(record) : undefined;
	if (context) lines.push(context);
	for (const warning of options.requiredWarnings ?? []) lines.push({ fact: `warning: ${warning}` });
	return lines;
}

/** D7: a time-limit kill's one line of guidance. */
export const TIME_LIMIT_GUIDANCE =
	"resume this child with a smaller next step as its task; the resume gets the same limit";
/** D7: the same guidance when the agent forbids a resume after a time limit. */
export const TIME_LIMIT_NO_RESUME_GUIDANCE = "start a new sub-agent with a smaller task";
/** D7: a report-only wrap-up's notice. */
export const WRAP_UP_NOTICE =
	"the parent interrupted the run before its limit and kept the rest for this report; expect a short or partial report and check what remains";

/**
 * D7: the time limit of a timed-out run, with the guidance of a kill or the notice of a report-only
 * wrap-up. The limit stays; the guidance or notice gets the room the resume reason leaves. D21: a
 * completed wrap-up keeps its report outcome and still names the limit here.
 */
function timeLimitLine(record: ResultRecord): RequiredLine | undefined {
	const limit = record.timeLimit;
	if (!limit || (record.outcome !== "timed_out" && !limit.wrapUp)) return undefined;
	const budget =
		limit.kind === "idle-timeout" ? `${limit.seconds}s without output` : `${limit.seconds}s for the whole run`;
	const [label, text] = limit.wrapUp
		? ["wrap-up", WRAP_UP_NOTICE]
		: ["time limit", record.resume.resumable ? TIME_LIMIT_GUIDANCE : TIME_LIMIT_NO_RESUME_GUIDANCE];
	return {
		fact: `${label}: ${budget}`,
		detail: { text, max: FACT_MAX_CHARS, priority: 1 },
	};
}

/** Fits the details of the required lines into the room left within FRAME_MAX_CHARS. */
function fitRequiredLines(lines: readonly RequiredLine[], frameLength: (lines: readonly string[]) => number): string[] {
	const text = lines.map((line) => line.fact);
	const details = lines.flatMap((line, i) => (line.detail ? [{ i, ...line.detail }] : []));
	for (const { i, text: detail, max } of details.sort((a, b) => a.priority - b.priority)) {
		const room = Math.min(max, FRAME_MAX_CHARS - frameLength(text)) - DETAIL_SEPARATOR.length;
		if (room <= CUT_MARK.length) continue;
		text[i] = `${lines[i].fact}${DETAIL_SEPARATOR}${cutText(detail, room)}`;
	}
	return text;
}

/** Footer lines that get only the room the required fields leave, in order. */
function optionalLines(options: RenderOptions): string[] {
	return (options.warnings ?? []).map((warning) => `warning: ${warning}`);
}

/**
 * D14: one text for the parent: header, summary, footer. The required fields come first; optional
 * lines fill the rest of FRAME_MAX_CHARS. The frame exceeds FRAME_MAX_CHARS only when the required
 * fields with the whole report locator do not fit; the summary is then cut further, so the text
 * stays within RESULT_TEXT_MAX_CHARS. The session path, raw watcher errors and the resume command
 * line are not part of the text.
 */
export function renderResult(record: ResultRecord, options: RenderOptions): string {
	const header = headerLine(record);
	// Two newlines join header, summary and footer; one more joins each footer line.
	const frameLength = (lines: readonly string[]) => header.length + 2 + lines.reduce((n, l) => n + l.length + 1, -1);
	const footer = fitRequiredLines(requiredLines(record, options), frameLength);
	for (const line of optionalLines(options)) {
		const room = FRAME_MAX_CHARS - frameLength(footer) - 1;
		if (room <= CUT_MARK.length) break;
		footer.push(cutText(line, room));
	}
	const summaryRoom = Math.min(SUMMARY_MAX_CHARS, RESULT_TEXT_MAX_CHARS - frameLength(footer));
	const summary = cutText(record.summary, Math.max(0, summaryRoom));
	return [header, summary, ...footer].join("\n");
}
