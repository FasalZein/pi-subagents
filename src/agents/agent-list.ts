import type { ResolvedAgentDefinition } from "./definitions.ts";
import { getEffectiveAgentDefinitions } from "./definitions.ts";
import { resolveVerifierCandidateCount } from "../vf/criteria.ts";
import {
	getContextReminderThresholds,
	parseContextWarnStep,
	parseContextWarnThreshold,
} from "../tools/context-reminders.ts";

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface AgentListEntry {
	name: string;
	source: "project" | "global";
	mode?: "interactive" | "background";
	sessionMode: SubagentSessionMode;
	async?: boolean;
	autoExit?: boolean;
	description?: string;
	pinned?: boolean;
	model?: string;
	thinking?: string;
	allowedModels?: string;
	allowModelOverride?: boolean;
	spawning: true | string[] | false;
	spawnDepth?: number;
	spawnWidth?: number;
	timeout?: number;
	idleTimeout?: number;
	/** `llm-as-a-verifier` marker: launches fan out to ranked candidates. */
	llmAsVerifier?: boolean;
	/** Explicit `llm-as-a-verifier-candidates` count, when set. */
	llmAsVerifierCandidates?: number;
	contextWarnThreshold?: string;
	contextWarnStep?: string;
	reportContextUsage?: boolean;
	visibleTo: string[];
}

export interface AgentListOptions {
	callerAgent: string | null;
	callerSpawnable: string[] | true;
}

export type ResolveSubagentSessionMode = (agent: ResolvedAgentDefinition) => SubagentSessionMode;

export function getAgentListEntries(
	baseCwd: string,
	resolveSessionMode: ResolveSubagentSessionMode,
	options: AgentListOptions = { callerAgent: null, callerSpawnable: true },
): AgentListEntry[] {
	return getEffectiveAgentDefinitions(baseCwd)
		.filter((agent) => agent.description?.trim())
		.filter(
			(agent) =>
				(options.callerAgent === null ||
					options.callerSpawnable === true ||
					options.callerSpawnable.includes(agent.name)) &&
				(agent.visibleTo?.includes("all") ||
					(options.callerAgent === null
						? agent.visibleTo?.includes("root")
						: options.callerAgent !== "root" && agent.visibleTo?.includes(options.callerAgent))),
		)
		.map((agent) => ({
			name: agent.name,
			source: agent.source,
			mode: agent.mode,
			sessionMode: resolveSessionMode(agent),
			async: agent.async,
			autoExit: agent.autoExit,
			description: agent.description,
			...(agent.pinned ? { pinned: true } : {}),
			model: agent.model,
			thinking: agent.thinking,
			allowedModels: agent.allowedModels,
			allowModelOverride: agent.allowModelOverride,
			spawning: agent.spawning ?? false,
			...(agent.spawnDepth !== undefined ? { spawnDepth: agent.spawnDepth } : {}),
			...(agent.spawnWidth !== undefined ? { spawnWidth: agent.spawnWidth } : {}),
			...(agent.timeout !== undefined ? { timeout: agent.timeout } : {}),
			...(agent.idleTimeout !== undefined ? { idleTimeout: agent.idleTimeout } : {}),
			...(agent.llmAsVerifier !== undefined ? { llmAsVerifier: agent.llmAsVerifier } : {}),
			...(agent.llmAsVerifierCandidates !== undefined
				? { llmAsVerifierCandidates: agent.llmAsVerifierCandidates }
				: {}),
			...(agent.contextWarnThreshold !== undefined ? { contextWarnThreshold: agent.contextWarnThreshold } : {}),
			...(agent.contextWarnStep !== undefined ? { contextWarnStep: agent.contextWarnStep } : {}),
			...(agent.reportContextUsage !== undefined ? { reportContextUsage: agent.reportContextUsage } : {}),
			visibleTo: agent.visibleTo ?? ["all"],
		}));
}

/** How a launched agent ends: on its own, or when a human or the agent finishes it. */
export function getCompletion(entry: AgentListEntry): "exits_automatically" | "human_or_agent_must_finish" {
	if (entry.autoExit === true) return "exits_automatically";
	if (entry.autoExit === false) return "human_or_agent_must_finish";
	// Undefined `auto-exit` resolves to manual lifecycle at launch: interactive
	// children are told to stay open for the operator and never receive
	// `subagent_done`, so their result only arrives once a human (or
	// subagent_kill) closes the pane. Background children must call
	// `subagent_done` themselves and keep the exits_automatically contract.
	return entry.mode === "background" ? "exits_automatically" : "human_or_agent_must_finish";
}

/**
 * The starting percentage of a schedule that reaches the final "stop" stage,
 * or undefined when the policy is off or the schedule collapsed to fewer than
 * three distinct thresholds — a collapsed schedule warns the child but never
 * instructs it to stop, so no parent-facing stop behavior exists.
 */
export function getContextWarnPercent(entry: AgentListEntry): number | undefined {
	if (entry.contextWarnThreshold === undefined) return undefined;
	const percent = parseContextWarnThreshold(entry.contextWarnThreshold);
	if (percent === null) return undefined;
	const step = parseContextWarnStep(entry.contextWarnStep);
	return getContextReminderThresholds(percent, step).length === 3 ? percent : undefined;
}

/** The attempt count of a verified fan-out, or the error that fails its launch. */
export function describeVerifiedFanOut(entry: AgentListEntry): string | undefined {
	if (entry.llmAsVerifier !== true) return undefined;
	// Resolved N: explicit field > PI_SUBAGENT_LLM_VERIFIER_CANDIDATES > 3.
	// The view is advisory, so a bad env value surfaces inline here; the
	// same error fails the actual launch closed at pre-flight.
	try {
		return `${resolveVerifierCandidateCount(entry.llmAsVerifierCandidates)} attempts`;
	} catch (error) {
		return (error as Error).message;
	}
}
