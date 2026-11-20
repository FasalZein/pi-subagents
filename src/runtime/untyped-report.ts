import { findLastSubagentOutputWithSource, type SessionEntry } from "../session/session.ts";
import type { RunEnd } from "./result-assembler.ts";

/**
 * D12: what a child process printed, as its watcher captured it (the bounded stdout and stderr tails
 * of a headless child). A pane child has none.
 */
export interface ProcessOutput {
	stdout?: string;
	stderr?: string;
}

/**
 * D12: the untyped report of a run. text is child-authored; diagnostic is runtime-owned process output
 * that the report keeps after the description of the end; end is the end after the terminal-stop rule.
 */
export interface UntypedReport {
	text?: string;
	diagnostic?: string;
	end: RunEnd;
}

/**
 * D12 (cf6dbf4 session.ts findLastSubagentOutputWithSource and the background watcher): the one place
 * that turns session entries or process output into an untyped report. entries are this run's entries
 * up to its report boundary; undefined means the child kept no transcript (T73 in-memory child).
 *
 * With a transcript: the last assistant text; after a tool-use turn without text, the trailing tool
 * result that is not subagent_done or caller_ping. An empty final turn with a terminal stop reason is
 * runtime text, never the report, and fails a clean exit by its reason (cf6dbf4 state.ts). With no
 * such output: stdout after a clean exit; else the last assistant text before the boundary (a fork
 * addition: cf6dbf4 reported nothing when a text message preceded a tool call without text); else
 * stderr as a diagnostic after a failed one. Without a transcript: stdout on any end, else stderr.
 */
export function selectUntypedReport(
	entries: readonly SessionEntry[] | undefined,
	end: RunEnd,
	output: ProcessOutput = {},
): UntypedReport {
	const stdout = output.stdout?.trim() || undefined;
	const stderr = end.kind === "failed" ? output.stderr?.trim() || undefined : undefined;
	if (entries === undefined) return stdout ? { text: stdout, end } : { diagnostic: stderr, end };
	const found = findLastSubagentOutputWithSource([...entries]);
	if (found?.summarySource === "runtime") {
		if (end.kind !== "exited") return { end };
		return { end: { kind: "failed", error: found.summary, code: end.code, signal: end.signal } };
	}
	if (found) return { text: found.summary, end };
	if (end.kind === "exited" && stdout) return { text: stdout, end };
	const earlier = lastAssistantText(entries);
	return earlier ? { text: earlier, end } : { diagnostic: stderr, end };
}

/** The joined text blocks of the last assistant message that has text, as session.ts joins them. */
function lastAssistantText(entries: readonly SessionEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "assistant") continue;
		const content = Array.isArray(entry.message.content) ? entry.message.content : [];
		const texts = content.flatMap((block: unknown) =>
			isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim() !== ""
				? [block.text]
				: [],
		);
		if (texts.length > 0) return texts.join("\n");
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
