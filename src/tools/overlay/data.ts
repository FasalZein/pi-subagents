import { loadAgentDefaults } from "../../agents/definitions.ts";
import { completedSubagentResults, runningSubagents } from "../../runtime/state.ts";
import { stopRunningSubagent } from "../../runtime/wiring.ts";
import { getEntries } from "../../session/session.ts";
import { getSubagentActivityStartIndex } from "../../session/session-files.ts";
import type { CompletedSubagentResult, RunningSubagent, SessionMessageLike, SessionUsage } from "../../types.ts";
import { type AgentDetailDefaults, buildSections, readRunDetailFacts } from "./detail-sections.ts";
import {
	newestRecordsBySession,
	newestRunsBySession,
	recordStatus,
	recoverResultDetails,
	recoverSummary,
	sessionRecords,
} from "./recovered-runs.ts";
import { compactCount, firstLine, formatElapsed, formatElapsedSeconds } from "./render-helpers.ts";
import type { DetailSection, OverlayContext, OverlayItem } from "./render-types.ts";

interface CompletedSessionStats {
	messages: number;
	toolUses: number;
	/** Snapshot of the final assistant message's usage total — the context footprint, not a cumulative sum. */
	contextTokens: number;
	inputTokens: number;
	outputTokens: number;
	model?: string;
	provider?: string;
}

function buildRuntimeSection(isRunning: boolean, r: RunningSubagent | CompletedSubagentResult): DetailSection {
	const fields: Array<{ label: string; value: string }> = [];
	const running = r as RunningSubagent;
	const completed = r as CompletedSubagentResult;

	if (isRunning && running.startTime) {
		fields.push({ label: "elapsed", value: formatElapsed(running.startTime) });
	} else if (completed.elapsed != null) {
		fields.push({ label: "elapsed", value: `${completed.elapsed}s` });
	}
	if (running.messageCount != null) fields.push({ label: "messages", value: `${running.messageCount}` });
	if (running.toolUses != null) fields.push({ label: "tool uses", value: `${running.toolUses}` });

	const ctxUsed = running.contextTokens ?? 0;
	const ctxW = running.modelContextWindow;
	if (ctxUsed > 0 && ctxW) {
		fields.push({
			label: "context",
			value: `${compactCount(ctxUsed)}/${compactCount(ctxW)}`,
		});
	} else if (running.contextLabel) {
		fields.push({ label: "context", value: running.contextLabel });
	} else if ((running.contextTokens ?? 0) > 0) {
		fields.push({
			label: "tokens",
			value: compactCount(running.contextTokens ?? 0),
		});
	}

	if (running.activity) fields.push({ label: "activity", value: running.activity });
	if (running.sessionFile) fields.push({ label: "session", value: running.sessionFile });
	if (running.surface) fields.push({ label: "pane", value: running.surface });
	if (running.childProcess?.pid) fields.push({ label: "PID", value: `${running.childProcess.pid}` });

	return { title: "Runtime", fields };
}

// ─── Safe helpers ───────────────────────────────────────────────────────────

function safeDefs(a: string, cwd: string): AgentDetailDefaults | null {
	try {
		return loadAgentDefaults(a, undefined, cwd, (_h, b) => b);
	} catch {
		return null;
	}
}

function usageTotal(usage: SessionUsage): number {
	return (
		usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
	);
}

function getSessionMessage(entry: { [key: string]: unknown }): SessionMessageLike | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	return typeof message === "object" && message !== null ? (message as SessionMessageLike) : undefined;
}

function readCompletedSessionStats(sessionFile?: string): CompletedSessionStats | undefined {
	if (!sessionFile) return undefined;
	try {
		let messages = 0;
		let toolUses = 0;
		let contextTokens = 0;
		let inputTokens = 0;
		let outputTokens = 0;
		let model: string | undefined;
		let provider: string | undefined;

		const entries = getEntries(sessionFile) as Array<{
			[key: string]: unknown;
		}>;
		// Skip inherited parent history in forked child sessions; count only
		// entries after this subagent's launch marker.
		const startIndex = getSubagentActivityStartIndex(entries);
		for (let i = startIndex; i < entries.length; i++) {
			const message = getSessionMessage(entries[i]);
			if (!message) continue;
			// One tool use per result, as the live widget counts; the assistant's call block is not counted again.
			if (message.role === "toolResult") {
				toolUses++;
				continue;
			}
			messages++;
			if (message.role !== "assistant") continue;
			if (message.model) model = message.model;
			if (message.provider) provider = message.provider;
			if (message.usage) {
				// Snapshot, not sum: the latest assistant turn reflects the context
				// footprint. Cumulative input/output are tracked separately below.
				contextTokens = usageTotal(message.usage);
				inputTokens += message.usage.input ?? 0;
				outputTokens += message.usage.output ?? 0;
			}
		}

		return {
			messages,
			toolUses,
			contextTokens,
			inputTokens,
			outputTokens,
			model,
			provider,
		};
	} catch {
		return undefined;
	}
}

function compactStats(stats?: CompletedSessionStats, fallbackOutputTokens?: number): string[] {
	if (!stats) return fallbackOutputTokens ? [`${compactCount(fallbackOutputTokens)} output`] : [];
	const result: string[] = [];
	if (stats.messages > 0) result.push(`${stats.messages} msg`);
	if (stats.toolUses > 0) result.push(`${stats.toolUses} tool${stats.toolUses === 1 ? "" : "s"}`);
	if (stats.contextTokens > 0) result.push(`${compactCount(stats.contextTokens)} ctx`);
	else if (fallbackOutputTokens) result.push(`${compactCount(fallbackOutputTokens)} output`);
	return result;
}

function completedRuntimeSection(args: {
	status: "completed" | "cancelled" | "failed";
	elapsed?: number;
	exitCode?: number;
	outputTokens?: number;
	sessionFile?: string;
	stats?: CompletedSessionStats;
}): DetailSection {
	const fields: Array<{ label: string; value: string }> = [];
	fields.push({ label: "status", value: args.status });
	if (args.elapsed != null) fields.push({ label: "elapsed", value: `${args.elapsed}s` });
	if (args.exitCode != null) fields.push({ label: "exit", value: `${args.exitCode}` });
	if (args.stats?.messages) fields.push({ label: "messages", value: `${args.stats.messages}` });
	if (args.stats?.toolUses) fields.push({ label: "tool calls", value: `${args.stats.toolUses}` });
	if (args.stats?.contextTokens)
		fields.push({
			label: "context tokens",
			value: compactCount(args.stats.contextTokens),
		});
	if (args.stats?.inputTokens)
		fields.push({
			label: "input tokens",
			value: compactCount(args.stats.inputTokens),
		});
	if (args.stats?.outputTokens)
		fields.push({
			label: "output tokens",
			value: compactCount(args.stats.outputTokens),
		});
	else if (args.outputTokens)
		fields.push({
			label: "output tokens",
			value: compactCount(args.outputTokens),
		});
	if (args.sessionFile) fields.push({ label: "session", value: args.sessionFile });
	return { title: "Execution", fields };
}

/** Outcomes that the status icon does not already say (D14): blocked, partial, timed out. */
function shownOutcomeOf(outcome: string | undefined): string | undefined {
	return outcome && !["done", "failed", "cancelled"].includes(outcome) ? outcome.replace("_", " ") : undefined;
}

function statusVisuals(status: "completed" | "cancelled" | "failed") {
	if (status === "completed") return { icon: "✓", color: "success", label: "completed" };
	if (status === "cancelled") return { icon: "⚡", color: "warning", label: "cancelled" };
	return { icon: "✕", color: "error", label: "failed" };
}

// ─── Public item builders ───────────────────────────────────────────────────

export function buildRunningItems(ctx: OverlayContext): OverlayItem[] {
	const items: OverlayItem[] = [];
	for (const a of runningSubagents.values()) {
		// The running object holds this run's own model and launch entry, also when its append failed.
		const facts = readRunDetailFacts(a.sessionFile, { ref: a.modelRef, facts: a.launchMetadata });
		const defs = a.agent ? safeDefs(a.agent, ctx.cwd) : null;
		const sections = buildSections(defs, facts.grants, facts.model);
		sections.push(buildRuntimeSection(true, a));

		const stats: string[] = [];
		const modelRef = facts.model.ref;
		if (a.toolUses) stats.push(`${a.toolUses} tool${a.toolUses === 1 ? "" : "s"}`);
		const ctxUsed = a.contextTokens ?? 0;
		if (ctxUsed > 0 && a.modelContextWindow) {
			stats.push(`${compactCount(ctxUsed)}/${compactCount(a.modelContextWindow)} ctx`);
		} else if (a.contextLabel) {
			stats.push(a.contextLabel);
		} else if ((a.contextTokens ?? 0) > 0) {
			stats.push(`${compactCount(a.contextTokens ?? 0)} tokens`);
		}
		stats.push(formatElapsed(a.startTime));

		items.push({
			id: a.id,
			icon: "●",
			iconColor: "accent",
			name: a.name,
			agent: a.agent,
			modelRef,
			stats,
			activity: a.activity ?? a.taskPreview ?? "starting…",
			detailSections: sections,
			canKill: true,
			canResume: false,
			sessionFile: a.sessionFile,
			onKill: async () => {
				// Operator surface: a human may cancel even a non-recipient's run.
				// The item can outlive the run: stop then leaves an ended run as it is (T83).
				if (a.phase === "ended") {
					ctx.ui.notify(`${a.name} already ended`, "info");
					return;
				}
				await stopRunningSubagent(a, { operator: true });
				ctx.ui.notify(`Stopped ${a.name}`, "info");
			},
		});
	}
	return items;
}

/** One Completed row, from a published record, a cache entry or a run-end message. */
interface CompletedRow {
	id: string;
	name: string;
	agent?: string;
	status: "completed" | "cancelled" | "failed";
	outcome?: string;
	activity: string;
	elapsed?: number;
	exitCode?: number;
	outputTokens?: number;
	sessionFile?: string;
	/** The model ref this run ran on, from its record or cache entry; absent in old messages. */
	modelRef?: string;
}

function completedItem(ctx: OverlayContext, row: CompletedRow): OverlayItem {
	const visual = statusVisuals(row.status);
	const shownOutcome = shownOutcomeOf(row.outcome);
	const sessionStats = readCompletedSessionStats(row.sessionFile);
	const facts = readRunDetailFacts(row.sessionFile, { ref: row.modelRef });
	const defs = row.agent ? safeDefs(row.agent, ctx.cwd) : null;
	const sections = buildSections(defs, facts.grants, facts.model);
	sections.push(
		completedRuntimeSection({
			status: row.status,
			elapsed: row.elapsed,
			exitCode: row.exitCode,
			outputTokens: row.outputTokens,
			sessionFile: row.sessionFile,
			stats: sessionStats,
		}),
	);
	return {
		id: row.id,
		icon: visual.icon,
		iconColor: visual.color,
		name: row.name,
		agent: row.agent,
		modelRef: facts.model.ref,
		status: shownOutcome ?? (row.status === "completed" ? undefined : visual.label),
		statusColor: shownOutcome ? "warning" : row.status === "completed" ? undefined : visual.color,
		stats: [
			...(row.elapsed != null ? [formatElapsedSeconds(row.elapsed)] : []),
			...compactStats(sessionStats, row.outputTokens),
		],
		activity: row.activity,
		detailSections: sections,
		canKill: false,
		// An ephemeral run has no session to resume.
		canResume: Boolean(row.sessionFile),
		sessionFile: row.sessionFile,
	};
}

export async function buildCompletedItems(ctx: OverlayContext): Promise<OverlayItem[]> {
	const items: OverlayItem[] = [];
	const seen = new Set<string>();
	const latestCompleted = new Map<string, CompletedSubagentResult>();
	const runningSessionFiles = new Set(
		[...runningSubagents.values()].map((subagent) => subagent.sessionFile).filter(Boolean),
	);

	// Published records come first: the newest run of a session wins over an older cached one.
	for (const record of newestRecordsBySession(sessionRecords(ctx))) {
		seen.add(record.sessionFile ?? record.runId);
		seen.add(record.runId);
		const status = recordStatus(record.outcome);
		items.push(
			completedItem(ctx, {
				id: record.runId,
				name: record.name,
				agent: record.agent,
				status,
				outcome: record.outcome,
				activity:
					status === "failed" && record.exit.error
						? `error: ${firstLine(record.exit.error, 40)}`
						: record.summary
							? firstLine(record.summary, 40)
							: `exit ${record.exit.code}`,
				elapsed: record.elapsedSeconds,
				exitCode: record.exit.code,
				outputTokens: completedSubagentResults.get(record.runId)?.outputTokens,
				sessionFile: record.sessionFile,
				modelRef: record.modelRef,
			}),
		);
	}

	for (const [id, r] of completedSubagentResults) {
		latestCompleted.set(r.sessionFile ?? id, r);
	}

	for (const [dedupeKey, r] of latestCompleted) {
		if (seen.has(dedupeKey) || seen.has(r.id)) continue;
		seen.add(dedupeKey);
		seen.add(r.id);
		items.push(
			completedItem(ctx, {
				id: r.id,
				name: r.name,
				agent: r.agent,
				status: r.status,
				outcome: r.resultOutcome,
				activity: r.errorMessage
					? `error: ${firstLine(r.errorMessage, 40)}`
					: r.summary
						? firstLine(r.summary, 40)
						: `exit ${r.exitCode}`,
				elapsed: r.elapsed,
				exitCode: r.exitCode,
				outputTokens: r.outputTokens,
				sessionFile: r.sessionFile,
				modelRef: r.modelRef,
			}),
		);
	}

	const sf = ctx.sessionManager.getSessionFile?.();
	if (sf) {
		try {
			const entries = getEntries(sf) as Array<{ [key: string]: unknown }>;
			for (const [key, recovered] of newestRunsBySession(entries.flatMap(recoverResultDetails))) {
				if (seen.has(key) || seen.has(recovered.id)) continue;
				if (recovered.sessionFile && runningSessionFiles.has(recovered.sessionFile)) continue;
				seen.add(key);
				items.push(
					completedItem(ctx, {
						id: recovered.id,
						name: recovered.name,
						agent: recovered.agent,
						status: recovered.status,
						outcome: recovered.outcome,
						activity: recovered.errorMessage
							? `error: ${firstLine(recovered.errorMessage, 80)}`
							: recoverSummary(recovered.content, recovered.published),
						elapsed: recovered.elapsed,
						exitCode: recovered.exitCode,
						sessionFile: recovered.sessionFile,
					}),
				);
			}
		} catch {
			/* ignore */
		}
	}

	return items;
}
