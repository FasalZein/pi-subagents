import { isAbsolute, relative } from "node:path";
import { formatElapsedSeconds } from "../tools/overlay/render-helpers.ts";
import { cutText } from "./result-assembler.ts";
import { CUT_MARK, type ResultOutcome, type ResultRecord, SUMMARY_MAX_CHARS } from "./result-record.ts";

/** D14: everything around the summary, unless a long report locator needs more. */
export const FRAME_MAX_CHARS = 400;
/** D14 and G1.3: the whole rendered text. */
export const RESULT_TEXT_MAX_CHARS = 1900;

/** Header names and short footer facts stay this short so the summary keeps its room. */
const NAME_MAX_CHARS = 60;
const FACT_MAX_CHARS = 160;

export interface RenderOptions {
	/** The parent's working directory, for the relative report locator. */
	cwd: string;
	homeDir: string;
	warnings?: readonly string[];
	/** Verified fan-out footer (D18), kept inside the frame. */
	verifierFooter?: string;
	/** True when the agent asks for the context usage line. */
	showContextUsage?: boolean;
}

const OUTCOME_WORDS: Record<ResultOutcome, string> = {
	done: "done",
	partial: "partial",
	blocked: "blocked",
	failed: "failed",
	timed_out: "timed out",
	cancelled: "cancelled",
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
	if (record.dataError !== undefined) parts.push("data error");
	return parts.join(" · ");
}

function reportLine(record: ResultRecord, options: RenderOptions): string {
	if (!record.report.saved) return cutText(`report not saved: ${record.report.error}`, FACT_MAX_CHARS);
	return `report: ${shortestReadLocator(record.report.path, options.cwd, options.homeDir)}`;
}

/**
 * Footer lines D14 and D18 require: the report file, the run id, why a run cannot resume, the verifier
 * footer (its staged or not-applied fact must survive the cap), requested context usage.
 */
function requiredLines(record: ResultRecord, options: RenderOptions): string[] {
	const lines = [reportLine(record, options), `run: ${record.runId}`];
	if (!record.resume.resumable) lines.push(cutText(`not resumable: ${record.resume.reason}`, FACT_MAX_CHARS));
	if (options.verifierFooter) lines.push(options.verifierFooter);
	if (options.showContextUsage && record.contextUsage) {
		const { tokens, window } = record.contextUsage;
		lines.push(window ? `context: ${tokens}/${window} tokens` : `context: ${tokens} tokens`);
	}
	return lines;
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
	const footer = requiredLines(record, options);
	// Two newlines join header, summary and footer; one more joins each footer line.
	const frameLength = (lines: readonly string[]) => header.length + 2 + lines.reduce((n, l) => n + l.length + 1, -1);
	for (const line of optionalLines(options)) {
		const room = FRAME_MAX_CHARS - frameLength(footer) - 1;
		if (room <= CUT_MARK.length) break;
		footer.push(cutText(line, room));
	}
	const summaryRoom = Math.min(SUMMARY_MAX_CHARS, RESULT_TEXT_MAX_CHARS - frameLength(footer));
	const summary = cutText(record.summary, Math.max(0, summaryRoom));
	return [header, summary, ...footer].join("\n");
}
