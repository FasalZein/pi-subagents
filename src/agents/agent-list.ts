import type { ResolvedAgentDefinition } from "./definitions.ts";
import { getEffectiveAgentDefinitions } from "./definitions.ts";
import { resolveVerifierCandidateCount } from "../vf/criteria.ts";

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
	timeoutWarnThreshold?: string;
	onTimeout?: "report" | "block-resume";
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
		.map((agent) => toAgentListEntry(agent, resolveSessionMode));
}

/** The list view of one parsed definition. */
export function toAgentListEntry(
	agent: ResolvedAgentDefinition,
	resolveSessionMode: ResolveSubagentSessionMode,
): AgentListEntry {
	return {
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
		...(agent.timeoutWarnThreshold !== undefined ? { timeoutWarnThreshold: agent.timeoutWarnThreshold } : {}),
		...(agent.onTimeout !== undefined ? { onTimeout: agent.onTimeout } : {}),
		...(agent.llmAsVerifier !== undefined ? { llmAsVerifier: agent.llmAsVerifier } : {}),
		...(agent.llmAsVerifierCandidates !== undefined
			? { llmAsVerifierCandidates: agent.llmAsVerifierCandidates }
			: {}),
		...(agent.contextWarnThreshold !== undefined ? { contextWarnThreshold: agent.contextWarnThreshold } : {}),
		...(agent.contextWarnStep !== undefined ? { contextWarnStep: agent.contextWarnStep } : {}),
		...(agent.reportContextUsage !== undefined ? { reportContextUsage: agent.reportContextUsage } : {}),
		visibleTo: agent.visibleTo ?? ["all"],
	};
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
