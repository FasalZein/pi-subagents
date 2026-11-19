import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { formatFinalContextUsage } from "../runtime/final-context-usage.ts";
import { OUTCOME_WORDS } from "../runtime/result-render.ts";
import { isFinishedStatus, type RunEndEntry, runEnds } from "../runtime/run-end-message.ts";
import type { SubagentPingMessageDetails, SubagentResultMessageDetails } from "../types.ts";
import { parseJsonContainer } from "./json-string-args.ts";

type ThemeLike = Parameters<Parameters<ExtensionAPI["registerMessageRenderer"]>[1]>[2];
type RenderOptions = { expanded: boolean; outputPad?: number };

type BatchChildArgs = {
	name?: string;
	agent?: string;
	task?: string;
	title?: string;
};

type SubagentCompletionDetails = SubagentResultMessageDetails & {
	id?: string;
	name?: string;
	status?: string;
	mode?: "interactive" | "background";
	deliveryState?: string;
	blocking?: boolean;
	async?: boolean;
	autoExit?: boolean;
	summary?: string;
	/** The report text this child's batch reply delivered; the box shows it, not the legacy summary. */
	report?: string;
	task?: string;
	title?: string;
};

type SubagentBatchDetails = {
	status?: string;
	children?: SubagentCompletionDetails[];
};

type SubagentBatchArgs = {
	children?: BatchChildArgs[];
};

function formatElapsedDefault(seconds: number): string {
	const s = Math.round(seconds);
	const m = Math.floor(s / 60);
	return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function expandHint(): string {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return "ctrl+o to expand";
	}
}

function stripSessionRef(text: string): string {
	return text.replace(/\n\nSub-agent context: .+ used at finish\.$/, "").replace(/\n\nSession: .+\nResume: .+$/, "");
}

/**
 * Render the final context-usage line for the TUI from structured details.
 *
 * The delivered message content already carries this line for the model, but
 * `stripSessionRef` intentionally removes it from the rendered summary (the
 * human-facing box shows a compact view). Re-add it from the structured
 * `contextTokens`/`contextWindow` details so the operator can see how much of
 * the child's context window was consumed, matching what the parent model was
 * told.
 */
function formatContextUsageLine(details: SubagentCompletionDetails | undefined): string | undefined {
	if (!details) return undefined;
	const formatted = formatFinalContextUsage({
		contextTokens: details.contextTokens,
		contextWindow: details.contextWindow,
	});
	return formatted ? formatted.trim() : undefined;
}

/** All text blocks of a reply: a notice block before the result must not hide the result. */
function replyTextContent(result: AgentToolResult<unknown>): string {
	return (result.content ?? [])
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n\n");
}

function getChildArg(args: SubagentBatchArgs | undefined, index: number): BatchChildArgs | undefined {
	// T64: Pi renders the raw arguments, where children may be a JSON string.
	const children = parseJsonContainer(args?.children);
	return Array.isArray(children) ? (children[index] as BatchChildArgs | undefined) : undefined;
}

function getChildAgent(
	child: SubagentCompletionDetails,
	args: SubagentBatchArgs | undefined,
	index: number,
): string | undefined {
	return child.agent ?? getChildArg(args, index)?.agent;
}

function getChildName(child: SubagentCompletionDetails, args: SubagentBatchArgs | undefined, index: number): string {
	return child.name ?? getChildArg(args, index)?.name ?? "subagent";
}

function extractSummary(
	rawContent: string,
	details: (SubagentResultMessageDetails & { summary?: string; status?: string }) | undefined,
	elapsed: string,
): string {
	// D14: a published result shows its rendered text (with its guidance), not the bare summary.
	if (typeof details?.runId === "string") return rawContent;
	if (typeof details?.summary === "string") return details.summary;
	const name = details?.name ?? "subagent";
	const exitCode = details?.exitCode ?? 0;
	return stripSessionRef(rawContent)
		.replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
		.replace(`Sub-agent "${name}" completed (exit code ${exitCode}).\n\n`, "")
		.replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
		.replace(`Sub-agent "${name}" failed (status failed).\n\n`, "")
		.replace(`Sub-agent "${name}" was cancelled (status cancelled).\n\n`, "")
		.replace(`Sub-agent "${name}" failed after ${elapsed} (provider/agent error — auto-retry exhausted).\n\n`, "");
}
function appendExpandableLines(
	lines: string[],
	body: string,
	options: RenderOptions,
	theme: ThemeLike,
	maxCollapsedLines = 10,
	color: "dim" | "toolOutput" = "dim",
): void {
	if (!body) return;
	const bodyLines = body.split("\n");
	const visibleLines = options.expanded ? bodyLines : bodyLines.slice(0, maxCollapsedLines);
	for (const line of visibleLines) {
		lines.push(theme.fg(color, line));
	}
	const remaining = bodyLines.length - visibleLines.length;
	if (!options.expanded && remaining > 0) {
		lines.push(theme.fg("muted", `... (${remaining} more lines,`) + ` ${expandHint()}` + theme.fg("muted", ")"));
	}
}

export function formatTaskPreview(task: string | undefined, options: RenderOptions, theme: ThemeLike): string {
	if (!task) return "";
	const lines: string[] = [];
	appendExpandableLines(lines, task, options, theme, 10, "toolOutput");
	return lines.length ? `\n${lines.join("\n")}` : "";
}

function formatSubagentCompletionHeader(
	details: SubagentCompletionDetails | undefined,
	theme: ThemeLike,
	formatElapsed: (elapsed: number) => string,
	fallbackName = "subagent",
	fallbackAgent?: string,
): string {
	const name = details?.name ?? fallbackName;
	const elapsed = details?.elapsed != null ? formatElapsed(details.elapsed) : "?";
	const agent = details?.agent ?? fallbackAgent;
	const agentTag = agent ? theme.fg("dim", ` (${agent})`) : "";
	const verdict = completionVerdict(details);
	const icon =
		verdict.tone === "help"
			? theme.fg("accent", "?")
			: verdict.tone === "failed"
				? theme.fg("error", "✗")
				: theme.fg("success", "✓");
	const status = verdict.label;
	return `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
}

/**
 * D14: the published outcome decides the header; the exit facts decide it only for a result without
 * a published record (an old message or a run without a result store).
 */
function completionVerdict(details: (SubagentResultMessageDetails & { status?: string }) | undefined): {
	label: string;
	tone: "ok" | "failed" | "help";
} {
	const outcome = details?.outcome;
	if (outcome) {
		const tone = outcome === "done" || outcome === "partial" ? "ok" : outcome === "blocked" ? "help" : "failed";
		return { label: OUTCOME_WORDS[outcome], tone };
	}
	if (details?.status === "pinged") return { label: "needs help", tone: "help" };
	// A wait that ended without a report (the launch reply's typed status): no completion to show.
	if (details?.status === "interrupted") return { label: "interrupted", tone: "failed" };
	if (details?.status === "wait_failed")
		return { label: `wait failed (${details.error ?? "unknown"})`, tone: "failed" };
	const errorMessage = details?.errorMessage;
	const exitCode = details?.exitCode ?? 0;
	const failed = !!errorMessage || exitCode !== 0;
	const label =
		details?.status === "cancelled"
			? "cancelled"
			: errorMessage
				? "failed (provider/agent error)"
				: exitCode === 0
					? "completed"
					: `failed (exit ${exitCode})`;
	return { label, tone: failed ? "failed" : "ok" };
}

export function formatSubagentCompletionLines(
	result: AgentToolResult<unknown>,
	options: RenderOptions,
	theme: ThemeLike,
	formatElapsed: (elapsed: number) => string = formatElapsedDefault,
): string[] {
	const details = result.details as SubagentCompletionDetails | undefined;
	const rawContent = replyTextContent(result);
	const elapsed = details?.elapsed != null ? formatElapsed(details.elapsed) : "?";
	const lines = [formatSubagentCompletionHeader(details, theme, formatElapsed)];
	const summary = extractSummary(rawContent, details, elapsed);
	appendExpandableLines(lines, summary, options, theme);
	const contextUsage = formatContextUsageLine(details);
	if (contextUsage) {
		lines.push(theme.fg("dim", contextUsage));
	}
	if (options.expanded && details?.sessionFile) {
		lines.push("");
		lines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
		lines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
	}
	return lines;
}

export function formatSubagentBatchLines(
	result: AgentToolResult<unknown>,
	args: SubagentBatchArgs | undefined,
	options: RenderOptions,
	theme: ThemeLike,
	formatElapsed: (elapsed: number) => string = formatElapsedDefault,
): string[] {
	const details = result.details as SubagentBatchDetails | undefined;
	const children = Array.isArray(details?.children) ? details.children : [];
	const lines: string[] = [];

	children.forEach((child, index) => {
		if (index > 0) lines.push("");
		const fallbackName = getChildName(child, args, index);
		const fallbackAgent = getChildAgent(child, args, index);
		lines.push(formatSubagentCompletionHeader(child, theme, formatElapsed, fallbackName, fallbackAgent));

		const elapsed = child.elapsed != null ? formatElapsed(child.elapsed) : "?";
		const summary = child.report !== undefined ? extractSummary(child.report, child, elapsed) : (child.summary ?? "");
		appendExpandableLines(lines, summary, options, theme);

		const contextUsage = formatContextUsageLine(child);
		if (contextUsage) {
			lines.push(theme.fg("dim", contextUsage));
		}

		if (options.expanded && child.sessionFile) {
			lines.push("");
			lines.push(theme.fg("dim", `Session: ${child.sessionFile}`));
			lines.push(theme.fg("dim", `Resume:  pi --session ${child.sessionFile}`));
		}
	});

	return lines;
}

/** A waited launch reply that holds a finished run, a waiting ping included, renders as a completion. */
export function renderSubagentCompletionText(
	result: AgentToolResult<unknown>,
	options: RenderOptions,
	theme: ThemeLike,
	component?: Text,
	prefixBlankLine = false,
): Text {
	const text = component ?? new Text("", 0, 0);
	const rendered = formatSubagentCompletionLines(result, options, theme).join("\n");
	text.setText(prefixBlankLine ? `\n${rendered}` : rendered);
	return text;
}

type ElapsedFormatter = (elapsed: number) => string;

function renderResultBox(
	entry: RunEndEntry,
	width: number,
	options: RenderOptions,
	theme: ThemeLike,
	formatElapsed: ElapsedFormatter,
): string[] {
	const details = entry.details as SubagentResultMessageDetails;
	const failed = completionVerdict(details).tone === "failed";
	const bgFn = failed
		? (text: string) => theme.bg("toolErrorBg", text)
		: (text: string) => theme.bg("toolSuccessBg", text);
	const result = { content: [{ type: "text" as const, text: entry.content }], details };
	const box = new Box(options.outputPad ?? 1, 1, bgFn);
	box.addChild(new Text(formatSubagentCompletionLines(result, options, theme, formatElapsed).join("\n"), 0, 0));
	return ["", ...box.render(width)];
}

function renderPingBox(
	entry: RunEndEntry,
	width: number,
	options: RenderOptions,
	theme: ThemeLike,
	formatElapsed: ElapsedFormatter,
): string[] {
	const details = entry.details as SubagentPingMessageDetails;
	const name = details.name ?? "subagent";
	const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
	const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
	const label = details.outcome ? OUTCOME_WORDS[details.outcome] : "needs help";
	const header = `${theme.fg("accent", "?")} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${label} ${theme.fg("dim", `(${elapsed})`)}`;
	// D14: a published ping shows its rendered record, the same text the model reads.
	const rawMessage = details.runId ? entry.content : (details.message ?? entry.content);
	const body = stripSessionRef(rawMessage);
	const contentLines = [header];

	appendExpandableLines(contentLines, body, options, theme, 4);
	if (options.expanded && details.sessionFile) {
		contentLines.push("");
		contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
		contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
	}

	const box = new Box(options.outputPad ?? 1, 1, (text: string) => theme.bg("toolPendingBg", text));
	box.addChild(new Text(contentLines.join("\n"), 0, 0));
	return ["", ...box.render(width)];
}

export function registerSubagentMessageRenderers(pi: ExtensionAPI, formatElapsed: ElapsedFormatter): void {
	// D15: a grouped message carries several run ends; each keeps the box of its own kind.
	for (const customType of ["subagent_result", "subagent_ping"] as const) {
		pi.registerMessageRenderer(customType, (message, options, theme) => {
			const entries = runEnds(customType, message.content, message.details);
			if (entries.length === 0) return undefined;
			return {
				invalidate() {},
				render(width: number): string[] {
					return entries.flatMap((entry) =>
						entry.customType === "subagent_ping"
							? renderPingBox(entry, width, options, theme, formatElapsed)
							: renderResultBox(entry, width, options, theme, formatElapsed),
					);
				},
			};
		});
	}
}
