import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentDefaults } from "../agents/definitions.ts";
import { isSetTabTitleToolEnabled } from "../agents/titles.ts";
import { markSubagentBatchBlocking } from "../runtime/state.ts";
import type { SubagentParamsInput } from "../types.ts";
import {
	CALLER_PING_TOOL_NAME,
	SET_TAB_TITLE_TOOL_NAME,
	SPAWNING_TOOL_NAMES,
	SUBAGENT_DONE_TOOL_NAME,
} from "./tool-names.ts";

/**
 * Whether the model of this session can call the tool: Pi registered it (so no
 * --tools or --exclude-tools filter removed it) and it is either active (a
 * direct or model-only declaration) or exposed to codemode, which can call it
 * without a declaration.
 */
export function isToolCallable(pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">, name: string): boolean {
	const tool = pi.getAllTools().find((candidate) => candidate.name === name);
	if (!tool) return false;
	const exposure = tool.exposure ?? "direct";
	if (exposure === "codemode" || exposure === "deferred") return true;
	if (exposure === "hidden") return false;
	return pi.getActiveTools().includes(name);
}

const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

/**
 * Names pi-subagents can validate at the parent boundary. Extension/custom tool
 * names cannot be validated here because the parent never loads the child's
 * extensions, so it cannot know which names they will register.
 */
const KNOWN_TOOL_NAMES = new Set<string>([
	...BUILTIN_TOOL_NAMES,
	CALLER_PING_TOOL_NAME,
	SUBAGENT_DONE_TOOL_NAME,
	SET_TAB_TITLE_TOOL_NAME,
]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning` defaults to false; any truthy spawn list or `true` allows spawning tools.
 * `deny-tools` adds individual tool names on top.
 */
export function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
	const denied = new Set<string>();
	if (!agentDefs) return denied;

	// spawning defaults to false → deny all spawning tools unless explicitly enabled
	if (!agentDefs.spawning) {
		for (const t of SPAWNING_TOOL_NAMES) denied.add(t);
	}

	// deny-tools: explicit list
	if (agentDefs.denyTools) {
		for (const t of agentDefs.denyTools
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)) {
			denied.add(t);
		}
	}

	return denied;
}

function parseToolNames(tools: string): string[] {
	return tools
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
}

function damerauLevenshtein(a: string, b: string): number {
	const aChars = [...a];
	const bChars = [...b];
	const aLen = aChars.length;
	const bLen = bChars.length;
	if (aLen === 0) return bLen;
	if (bLen === 0) return aLen;

	const previousPrevious = new Array<number>(bLen + 1).fill(0);
	const previous = new Array<number>(bLen + 1);
	for (let j = 0; j <= bLen; j++) previous[j] = j;
	const current = new Array<number>(bLen + 1).fill(0);

	for (let i = 1; i <= aLen; i++) {
		current[0] = i;
		for (let j = 1; j <= bLen; j++) {
			const cost = aChars[i - 1] === bChars[j - 1] ? 0 : 1;
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
			if (i > 1 && j > 1 && aChars[i - 1] === bChars[j - 2] && aChars[i - 2] === bChars[j - 1]) {
				current[j] = Math.min(current[j], previousPrevious[j - 2] + 1);
			}
		}
		previousPrevious.splice(0, bLen + 1, ...previous);
		previous.splice(0, bLen + 1, ...current);
	}
	return previous[bLen];
}

function findLikelyBuiltinTypo(tool: string): string | null {
	let best: string | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const builtin of BUILTIN_TOOL_NAMES) {
		const distance = damerauLevenshtein(tool, builtin);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = builtin;
		}
	}
	return bestDistance === 1 ? best : null;
}

export interface SubagentToolsWarning {
	name: string;
	suggestion: string;
	message: string;
}

/**
 * Detect likely built-in typos in `tools:` at the parent boundary. A name that
 * is not known and sits within Damerau-Levenshtein distance 1 of a built-in
 * (single-char insertion/deletion/substitution or a transposition) is flagged.
 *
 * This is a NON-BLOCKING hint only. Pi core silently drops unknown tool names,
 * and the parent never loads the child's extensions, so it cannot distinguish a
 * real typo from a legitimate custom tool that happens to be one edit from a
 * built-in (e.g. `hash` vs `bash`, `exit` vs `edit`). Blocking on fuzzy match
 * would reject valid custom tools, so callers must surface this as a warning,
 * never prevent the launch.
 */
export function getSubagentToolsWarning(tools?: string): SubagentToolsWarning | null {
	if (!tools) return null;
	if (tools.trim().toLowerCase() === "all" || tools.trim().toLowerCase() === "none") {
		return null;
	}
	for (const name of parseToolNames(tools)) {
		if (KNOWN_TOOL_NAMES.has(name)) continue;
		const suggestion = findLikelyBuiltinTypo(name);
		if (suggestion) {
			return {
				name,
				suggestion,
				message:
					`Warning: tool ${JSON.stringify(name)} in tools: may be a typo of built-in "${suggestion}". ` +
					`Pi silently drops unknown tool names, so if this is a typo the child runs without it. ` +
					`If ${JSON.stringify(name)} is an intentional custom/extension tool, ignore this warning and make sure the extension that registers it is loaded.`,
			};
		}
	}
	return null;
}

export function getBackgroundAutoExitWarning(
	agentDefs: AgentDefaults | null,
	usesBackgroundLaunch: boolean,
): SubagentToolsWarning | null {
	if (!usesBackgroundLaunch || agentDefs?.autoExit !== false) return null;
	return {
		name: "auto-exit",
		suggestion: "true",
		message: "Warning: background launches always use auto-exit: true; auto-exit: false is ignored.",
	};
}

/**
 * D22: a definition with `allow-model-override: false` ignores the model and
 * thinking of a launch or resume call; the reply says so.
 */
export function getIgnoredModelOverrideWarning(
	agentName: string | undefined,
	allowModelOverride: boolean | undefined,
	call: { model?: string; thinking?: string },
): string | null {
	if (allowModelOverride !== false) return null;
	const ignored = [
		call.model ? `model '${call.model}'` : undefined,
		call.thinking ? `thinking '${call.thinking}'` : undefined,
	].filter(Boolean);
	if (ignored.length === 0) return null;
	return (
		`Warning: agent '${agentName ?? "subagent"}' sets allow-model-override: false; ` +
		`${ignored.join(" and ")} from the call ignored. The child runs on the agent's own model.`
	);
}

/** Every launch warning for one child, joined for the tool reply ("" when none). */
export function getChildLaunchWarning(
	child: Pick<SubagentParamsInput, "agent" | "model" | "thinking">,
	agentDefs: AgentDefaults | null,
	usesBackgroundLaunch: boolean,
): string {
	return [
		getIgnoredModelOverrideWarning(child.agent, agentDefs?.allowModelOverride, child),
		(getSubagentToolsWarning(agentDefs?.tools) ?? getBackgroundAutoExitWarning(agentDefs, usesBackgroundLaunch))
			?.message,
	]
		.filter(Boolean)
		.join("\n\n");
}

export function applySynchronousLaunchPolicy(
	params: SubagentParamsInput,
	agentDefs: AgentDefaults | null,
	usesBackgroundLaunch: boolean,
	forceSynchronousLaunch: boolean,
): true | undefined {
	if (forceSynchronousLaunch) {
		params.async = false;
		params.blocking = true;
		markSubagentBatchBlocking();
	}
	return (usesBackgroundLaunch || forceSynchronousLaunch) && agentDefs?.autoExit !== true ? true : undefined;
}

function normalizeToolMode(tools?: string): "default" | "all" | "none" | "list" {
	if (!tools) return "default";
	const normalized = tools.trim().toLowerCase();
	if (normalized === "all") return "all";
	if (normalized === "none") return "none";
	return "list";
}

function getChildProtocolToolNames(deniedTools: Set<string>, spawningAllowed: boolean): string[] {
	const protocolTools = [];
	if (!deniedTools.has(CALLER_PING_TOOL_NAME)) {
		protocolTools.push(CALLER_PING_TOOL_NAME);
	}
	if (!deniedTools.has(SUBAGENT_DONE_TOOL_NAME)) {
		protocolTools.push(SUBAGENT_DONE_TOOL_NAME);
	}
	if (isSetTabTitleToolEnabled() && !deniedTools.has(SET_TAB_TITLE_TOOL_NAME)) {
		protocolTools.push(SET_TAB_TITLE_TOOL_NAME);
	}
	// `spawning:` is the switch that grants subagent tools; `tools:` narrows the
	// child's work tools. A narrowed `tools:` list must not silently revoke a
	// grant the agent file made, so the spawning tools ride along like the other
	// pi-subagents tools and are removed only through `deny-tools`/spawn policy.
	if (spawningAllowed) {
		for (const spawningTool of SPAWNING_TOOL_NAMES) {
			if (!deniedTools.has(spawningTool)) protocolTools.push(spawningTool);
		}
	}
	return protocolTools;
}

export function getSubagentToolAllowlist(
	tools?: string,
	deniedTools = new Set<string>(),
	spawningAllowed = false,
): string[] {
	if (normalizeToolMode(tools) !== "list" || !tools) return [];
	const allowlist = parseToolNames(tools).filter(
		(tool) => tool !== SET_TAB_TITLE_TOOL_NAME || isSetTabTitleToolEnabled(),
	);
	allowlist.push(...getChildProtocolToolNames(deniedTools, spawningAllowed));
	return [...new Set(allowlist)];
}

export function addToolModeDeniedNames(deniedTools: Set<string>, tools?: string) {
	if (normalizeToolMode(tools) !== "none") return deniedTools;
	for (const tool of BUILTIN_TOOL_NAMES) deniedTools.add(tool);
	return deniedTools;
}

export function getSubagentToolLaunchArgs(
	tools?: string,
	deniedTools = new Set<string>(),
	spawningAllowed = false,
): string[] {
	const args: string[] = [];
	const toolMode = normalizeToolMode(tools);
	if (toolMode === "none") {
		args.push("--no-builtin-tools");
	} else if (toolMode === "list") {
		const allowlist = getSubagentToolAllowlist(tools, deniedTools, spawningAllowed);
		if (allowlist.length > 0) args.push("--tools", allowlist.join(","));
		else args.push("--no-tools");
	}
	if (deniedTools.size > 0) args.push("--exclude-tools", [...deniedTools].join(","));
	return args;
}
