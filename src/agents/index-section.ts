import { type ParsedSpawnEnv, resolveSpawnPolicy } from "../spawn/policy.ts";
import type { AgentListEntry } from "./agent-list.ts";
import { buildModelRef, parseAllowedModels } from "./model-refs.ts";

/**
 * Name of the system-prompt section that holds the agent index (D19). The tags
 * count against the limit, so a short name leaves room for agent lines.
 */
export const AGENT_INDEX_SECTION_NAME = "index";

/**
 * Upper bound of the section as Pi renders it into the request, tags included (D19).
 * Derivation (owner 2026-11-21): the owner's 10 agents with their model lines
 * render at most 3,867 characters (UI session before the first launch, the
 * longest fixed lines); 533 characters of headroom hold about one more agent
 * with its model lines (the largest of the 10 takes about 400).
 */
export const AGENT_INDEX_MAX_CHARS = 4_400;

/** The section as Pi renders it into the request. */
export function renderAgentIndexRequestText(section: string): string {
	return `<${AGENT_INDEX_SECTION_NAME}>\n${section}\n</${AGENT_INDEX_SECTION_NAME}>`;
}

const WRAPPER_CHARS = renderAgentIndexRequestText("").length;

/** How a solo launch from this session runs, which decides the flags of a line. */
export interface IndexLaunchPolicy {
	/**
	 * Whether a non-background agent opens a pane: false without a UI, and in a
	 * UI session the multiplexer detection of an earlier launch. "unknown" when
	 * no launch has detected one yet: a prompt start does not probe (D06).
	 */
	paneAvailable: boolean | "unknown";
	/** Every launch waits for the helper and closes it (print, headless or startup-prompt run). */
	forcesWait: boolean;
}

// Kept short: in a startup-prompt session with a pane the line costs what the
// dropped [manual] flags saved, and every fixture row must still fit (D19).
const FORCED_WAIT_LINE = "Launches wait.";

// Before the first launch has detected a multiplexer the pane flags are
// conditional: without one, launch/policy.ts runs the child headless and
// tools/policy.ts makes it close itself (D06).
const UNKNOWN_PANE_LINE =
	"[pane] and [manual] need a multiplexer; without one a helper runs headless and closes itself.";

const DESCRIPTION_CHARS = 100;

function renderLaunchLine(tools: IndexToolAccess): string {
	const wait = tools.callable.has("subagent_wait") ? "; subagent_wait joins now or looks up a run id" : "";
	return `Helpers: launch with subagent (a children list). A result arrives as a message${wait}. A helper sees only its task text unless marked [fork].`;
}

// The routing rules of the v2.9.2 launch tool and roster (cf6dbf4
// src/tools/subagent-tools.ts promptSnippet, src/agents/agent-list.ts rules),
// shortened to fit the section (D06).
const RULES_LINE =
	"Do tiny work yourself. Use each named helper once, no substitutes. Do not redo delegated work. Ask when ownership is unclear.";

/** The management tools the index names, in index order. */
export const INDEX_MORE_TOOLS = ["subagent_wait", "subagent_resume", "subagent_kill", "subagent_agents"] as const;
type IndexMoreTool = (typeof INDEX_MORE_TOOLS)[number];

/** The management tools this session may call, so the index names only usable tools (D06). */
type IndexToolAccess = { callable: ReadonlySet<IndexMoreTool> };

const ALL_TOOLS: IndexToolAccess = { callable: new Set(INDEX_MORE_TOOLS) };

function getFlags(entry: AgentListEntry, policy: IndexLaunchPolicy): string[] {
	// The common case is a headless, fresh, self-closing helper whose launch
	// returns at once; only a difference from it gets a flag. The flags follow
	// the solo launch policy (shouldUseBackgroundLaunch, applySynchronousLaunchPolicy):
	// a headless or forced-wait launch always closes itself, and a forced wait
	// is stated once for the session instead of on every line.
	const pane = policy.paneAvailable !== false && entry.mode !== "background" && entry.llmAsVerifier !== true;
	const manual = pane && !policy.forcesWait && entry.autoExit !== true;
	return [
		pane ? "[pane]" : undefined,
		entry.sessionMode === "fork" ? "[fork]" : undefined,
		manual ? "[manual]" : undefined,
		!policy.forcesWait && entry.async === false ? "[waits]" : undefined,
	].filter((flag): flag is string => flag !== undefined);
}

/**
 * The entries this session may launch directly: the same spawn policy the
 * launch tool applies, without the caller itself.
 */
export function selectIndexTargets(entries: readonly AgentListEntry[], spawnEnv: ParsedSpawnEnv): AgentListEntry[] {
	return entries.filter(
		(entry) =>
			entry.name !== spawnEnv.callerAgent &&
			resolveSpawnPolicy({
				callerAgent: spawnEnv.callerAgent,
				targetAgent: entry.name,
				callerBudget: spawnEnv.callerBudget,
				callerSpawnable: spawnEnv.callerSpawnable,
				targetSpawning: entry.spawning,
				targetSpawnDepth: entry.spawnDepth,
				targetSpawnWidth: entry.spawnWidth,
				targetVisibleTo: entry.visibleTo,
				envDepthCeiling: spawnEnv.envDepthCeiling,
				envWidthCeiling: spawnEnv.envWidthCeiling,
			}).allowed,
	);
}

// The model lines of the v2.9.2 roster, verbatim (cf6dbf4 src/agents/agent-list.ts
// renderDefaultModelLine, renderModelsLine), so a parent can pick an allowed
// model and launch in one call (D19, owner 2026-11-21).
function renderDefaultModelLine(entry: AgentListEntry): string | undefined {
	const ref = buildModelRef(entry.model, entry.thinking);
	return ref ? `  default_model: ${ref}` : undefined;
}

function renderModelsLine(entry: AgentListEntry): string | undefined {
	if (entry.allowModelOverride === false) return undefined;
	const allowed = parseAllowedModels(entry.allowedModels);
	if (allowed.length === 0) return "  models: any model ref";
	const defaultModel = buildModelRef(entry.model, entry.thinking);
	const choices = [...new Set([defaultModel, ...allowed].filter((ref): ref is string => !!ref))];
	return `  models: ${choices.join(" | ")}`;
}

/** One agent's line and its model lines: they are kept or dropped as one unit. */
function renderAgentLine(entry: AgentListEntry, policy: IndexLaunchPolicy): string {
	const description = (entry.description ?? "").replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_CHARS).trimEnd();
	return [
		[`- ${entry.name}: ${description}`, ...getFlags(entry, policy)].join(" "),
		renderDefaultModelLine(entry),
		renderModelsLine(entry),
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function renderCountLine(rest: number): string {
	return `+${rest} more: subagent_agents with a query`;
}

/** The names line of a session without subagent_agents: the only way it learns the rest (D06). */
function renderNamesLine(names: readonly string[], hidden: number): string {
	return `More agents: ${names.join(", ")}${hidden > 0 ? `, +${hidden} not shown` : ""}.`;
}

function renderMoreToolsLine(tools: IndexToolAccess): string[] {
	const names = INDEX_MORE_TOOLS.filter((name) => tools.callable.has(name)).map((name) =>
		name === "subagent_agents" ? `${name} (search, full detail)` : name,
	);
	return names.length > 0 ? [`More tools: ${names.join(", ")}.`] : [];
}

function compareIndexOrder(a: AgentListEntry, b: AgentListEntry): number {
	if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * The index section text for the agents a session may launch, or undefined
 * when it may launch none. Pinned agents come first, then the others, each
 * group by name, and the section stays within AGENT_INDEX_MAX_CHARS. With
 * subagent_agents callable, agent lines are added while they fit with a count
 * line for the rest; a descriptionless agent is left to the lookup. Without
 * it, the agents that get no line, descriptionless ones included, are named on
 * one names line, and agent lines yield to it until every name fits (D06).
 */
export function renderAgentIndexSection(
	entries: readonly AgentListEntry[],
	policy: IndexLaunchPolicy,
	tools: IndexToolAccess = ALL_TOOLS,
): string | undefined {
	const lookup = tools.callable.has("subagent_agents");
	const ordered = [...entries].sort(compareIndexOrder);
	const described = ordered.filter((entry) => entry.description?.trim());
	if ((lookup ? described : ordered).length === 0) return undefined;
	const lines = described.map((entry) => renderAgentLine(entry, policy));
	const paneUnknown = policy.paneAvailable === "unknown" && lines.some((line) => line.includes(" [pane]"));
	const fixed = [
		renderLaunchLine(tools),
		RULES_LINE,
		...renderMoreToolsLine(tools),
		...(policy.forcesWait ? [FORCED_WAIT_LINE] : []),
		...(paneUnknown ? [UNKNOWN_PANE_LINE] : []),
	].join("\n");
	// prefix[k]: the length of the first k agent lines, each with its newline.
	const prefix = [0];
	for (const line of lines) prefix.push(prefix[prefix.length - 1] + 1 + line.length);
	const fits = (k: number, tail: string | undefined) =>
		WRAPPER_CHARS + fixed.length + prefix[k] + (tail === undefined ? 0 : 1 + tail.length) <= AGENT_INDEX_MAX_CHARS;
	const render = (k: number, tail: string | undefined) =>
		[fixed, ...lines.slice(0, k), ...(tail === undefined ? [] : [tail])].join("\n");
	if (lookup) {
		// The fixed lines and a count line alone fit, so zero agent lines always fit.
		let shown = 0;
		for (let k = 1; k <= lines.length; k++)
			if (fits(k, k < lines.length ? renderCountLine(lines.length - k) : undefined)) shown = k;
		return render(shown, shown < lines.length ? renderCountLine(lines.length - shown) : undefined);
	}
	const shownNames = (k: number) => new Set(described.slice(0, k).map((entry) => entry.name));
	const restNames = (k: number) => {
		const shown = shownNames(k);
		return ordered.filter((entry) => !shown.has(entry.name)).map((entry) => entry.name);
	};
	for (let k = lines.length; k >= 0; k--) {
		const rest = restNames(k);
		const tail = rest.length > 0 ? renderNamesLine(rest, 0) : undefined;
		if (fits(k, tail)) return render(k, tail);
	}
	// Not even every name fits: name as many as fit and count the others.
	const rest = restNames(0);
	let named = 0;
	while (named < rest.length && fits(0, renderNamesLine(rest.slice(0, named + 1), rest.length - named - 1))) named++;
	return render(0, renderNamesLine(rest.slice(0, named), rest.length - named));
}

interface IndexPromptEvent {
	systemPromptOptions: {
		sections: Record<string, string>;
		forceSystemPrompt?: string;
	};
}

/**
 * Write the index into the prompt of this request. The named section is the
 * only channel in a parent (D3). A child keeps its whole-prompt returns until
 * D33, and Pi sends a whole prompt instead of the sections, so when an earlier
 * handler in a child already composed one, the section text is appended to it
 * and returned. Any other whole prompt, from an earlier parent handler or a
 * later handler, gets the index through indexFallbackMessages instead.
 */
export function applyAgentIndexSection(
	event: IndexPromptEvent,
	section: string,
	isChild: boolean,
): { systemPrompt: string } | undefined {
	event.systemPromptOptions.sections[AGENT_INDEX_SECTION_NAME] = section;
	const forced = event.systemPromptOptions.forceSystemPrompt;
	if (forced === undefined || !isChild) return undefined;
	const tagged = renderAgentIndexRequestText(section);
	if (forced.includes(tagged)) return undefined;
	return { systemPrompt: `${forced}\n\n${tagged}` };
}

/** The custom type of the per-request index message of the fallback. */
const AGENT_INDEX_MESSAGE_TYPE = "subagent-index";

interface IndexContextMessage {
	role: "custom";
	customType: string;
	content: string;
	display: boolean;
	timestamp: number;
}

/**
 * The context of one provider request with the index in front, when the
 * system prompt that Pi sends lacks it: another extension's whole prompt
 * (before_agent_start systemPrompt) replaces every section, also when its
 * handler runs after this one. The index then goes in as a leading message
 * of this request only: the parent's chosen prompt stays as it is, nothing is
 * written to the session, and a fixed timestamp keeps the request prefix
 * stable for the cache (D06). Undefined when the prompt already holds it.
 */
export function indexFallbackMessages<T>(
	messages: readonly T[],
	systemPrompt: string,
	section: string,
): Array<T | IndexContextMessage> | undefined {
	const tagged = renderAgentIndexRequestText(section);
	if (systemPrompt.includes(tagged)) return undefined;
	return [
		{ role: "custom", customType: AGENT_INDEX_MESSAGE_TYPE, content: tagged, display: false, timestamp: 0 },
		...messages,
	];
}
