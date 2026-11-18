import { isAbsolute, relative } from "node:path";
import { formatElapsedSeconds } from "../tools/overlay/render-helpers.ts";
import { cutText } from "./result-assembler.ts";
import { type ResultOutcome, type ResultRecord, SUMMARY_MAX_CHARS } from "./result-record.ts";

/** D14: everything around the summary, unless a long report locator needs more. */
export const FRAME_MAX_CHARS = 400;
/** D14 and G1.3: the whole rendered text. */
export const RESULT_TEXT_MAX_CHARS = 1900;

/**
 * Room the frame keeps for the report locator. A longer locator widens the frame by its excess only
 * (D14), so the other footer lines keep the room they have with a short locator.
 */
const LOCATOR_ALLOWANCE_CHARS = 160;
/** Header names and short footer facts stay this short so the summary keeps its room. */
const NAME_MAX_CHARS = 60;
const FACT_MAX_CHARS = 160;
/** An optional footer line shorter than this carries too little to keep. */
const MIN_OPTIONAL_LINE_CHARS = 24;

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

function reportLine(record: ResultRecord, options: RenderOptions): { line: string; locatorExcess: number } {
	if (!record.report.saved) return { line: cutText(`report not saved: ${record.report.error}`, FACT_MAX_CHARS), locatorExcess: 0 };
	const locator = shortestReadLocator(record.report.path, options.cwd, options.homeDir);
	return { line: `report: ${locator}`, locatorExcess: Math.max(0, locator.length - LOCATOR_ALLOWANCE_CHARS) };
}

/** Footer lines that may be shortened or dropped, most important first. */
function optionalLines(record: ResultRecord, options: RenderOptions): string[] {
	const lines: string[] = [];
	if (!record.resume.resumable) lines.push(cutText(`not resumable: ${record.resume.reason}`, FACT_MAX_CHARS));
	if (options.verifierFooter) lines.push(options.verifierFooter);
	if (record.exit.error) lines.push(cutText(`error: ${record.exit.error}`, FACT_MAX_CHARS));
	for (const warning of options.warnings ?? []) lines.push(`warning: ${warning}`);
	if (options.showContextUsage && record.contextUsage) {
		const { tokens, window } = record.contextUsage;
		lines.push(window ? `context: ${tokens}/${window} tokens` : `context: ${tokens} tokens`);
	}
	return lines;
}

/**
 * D14: one text for the parent: header, summary, footer. The frame around the summary stays within
 * FRAME_MAX_CHARS; a report locator that does not fit widens the frame by its excess only and cuts
 * the summary further, so the text stays within RESULT_TEXT_MAX_CHARS. The session path and the
 * resume command line are not part of the text.
 */
export function renderResult(record: ResultRecord, options: RenderOptions): string {
	const header = headerLine(record);
	const report = reportLine(record, options);
	const footer = [report.line, `run: ${record.runId}`];
	// Two newlines join header, summary and footer; one more joins each footer line.
	const frameLength = (lines: readonly string[]) => header.length + 2 + lines.reduce((n, l) => n + l.length + 1, -1);
	const frameMax = FRAME_MAX_CHARS + report.locatorExcess;
	for (const line of optionalLines(record, options)) {
		const room = frameMax - frameLength(footer) - 1;
		if (room < MIN_OPTIONAL_LINE_CHARS) break;
		footer.push(cutText(line, room));
	}
	const summaryRoom = Math.min(SUMMARY_MAX_CHARS, RESULT_TEXT_MAX_CHARS - frameLength(footer));
	const summary = cutText(record.summary, Math.max(0, summaryRoom));
	return [header, summary, ...footer].join("\n");
}
