import { type ParsedSpawnEnv, resolveSpawnPolicy } from "../spawn/policy.ts";
import type { AgentListEntry } from "./agent-list.ts";

/**
 * Name of the system-prompt section that holds the agent index (D19). The tags
 * count against the limit, so a short name leaves room for agent lines.
 */
export const AGENT_INDEX_SECTION_NAME = "index";

/** Upper bound of the section as Pi renders it into the request, tags included (D19). */
export const AGENT_INDEX_MAX_CHARS = 1_600;

/** The section as Pi renders it into the request. */
export function renderAgentIndexRequestText(section: string): string {
	return `<${AGENT_INDEX_SECTION_NAME}>\n${section}\n</${AGENT_INDEX_SECTION_NAME}>`;
}

const WRAPPER_CHARS = renderAgentIndexRequestText("").length;

/** How a solo launch from this session runs, which decides the flags of a line. */
export interface IndexLaunchPolicy {
	/** The session has a UI and a multiplexer, so a non-background agent opens a pane. */
	paneAvailable: boolean;
	/** Every launch waits for the helper and closes it (print, headless or startup-prompt run). */
	forcesWait: boolean;
}

// Kept short: in a startup-prompt session with a pane the line costs what the
// dropped [manual] flags saved, and every fixture row must still fit (D19).
const FORCED_WAIT_LINE = "Launches wait.";

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

/** What the session may call besides launch, so the index names only usable tools (D06). */
export interface IndexToolAccess {
	/** The management tools this session may call. */
	callable: ReadonlySet<IndexMoreTool>;
	/** The agent file locations, named on the count line when subagent_agents is not callable. */
	agentDirs: string;
}

const ALL_TOOLS: IndexToolAccess = { callable: new Set(INDEX_MORE_TOOLS), agentDirs: "" };

function getFlags(entry: AgentListEntry, policy: IndexLaunchPolicy): string[] {
	// The common case is a headless, fresh, self-closing helper whose launch
	// returns at once; only a difference from it gets a flag. The flags follow
	// the solo launch policy (shouldUseBackgroundLaunch, applySynchronousLaunchPolicy):
	// a headless or forced-wait launch always closes itself, and a forced wait
	// is stated once for the session instead of on every line.
	const pane = policy.paneAvailable && entry.mode !== "background" && entry.llmAsVerifier !== true;
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

function renderAgentLine(entry: AgentListEntry, policy: IndexLaunchPolicy): string {
	const description = (entry.description ?? "").replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_CHARS).trimEnd();
	return [`- ${entry.name}: ${description}`, ...getFlags(entry, policy)].join(" ");
}

function renderCountLine(rest: number, tools: IndexToolAccess): string {
	// Without the lookup tool the files themselves are the catalog (D06).
	return tools.callable.has("subagent_agents")
		? `+${rest} more: subagent_agents with a query`
		: `+${rest} more: agent files in ${tools.agentDirs}`;
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
 * group by name; agent lines are added while the rendered section, with a
 * count line for the rest, stays within AGENT_INDEX_MAX_CHARS.
 */
export function renderAgentIndexSection(
	entries: readonly AgentListEntry[],
	policy: IndexLaunchPolicy,
	tools: IndexToolAccess = ALL_TOOLS,
): string | undefined {
	const described = entries.filter((entry) => entry.description?.trim());
	if (described.length === 0) return undefined;
	const lines = [...described].sort(compareIndexOrder).map((entry) => renderAgentLine(entry, policy));
	const fixed = [
		renderLaunchLine(tools),
		RULES_LINE,
		...renderMoreToolsLine(tools),
		...(policy.forcesWait ? [FORCED_WAIT_LINE] : []),
	].join("\n");
	// Length with the first k agent lines: each line adds itself and one newline.
	const lengthWith = (k: number, prefix: number) =>
		WRAPPER_CHARS +
		fixed.length +
		prefix +
		(k < lines.length ? 1 + renderCountLine(lines.length - k, tools).length : 0);
	// The fixed lines and a count line alone fit, so zero agent lines always fit.
	let shown = 0;
	let prefix = 0;
	for (let k = 1; k <= lines.length; k++) {
		prefix += 1 + lines[k - 1].length;
		if (lengthWith(k, prefix) <= AGENT_INDEX_MAX_CHARS) shown = k;
	}
	const rest = lines.length - shown;
	return [fixed, ...lines.slice(0, shown), ...(rest > 0 ? [renderCountLine(rest, tools)] : [])].join("\n");
}

interface IndexPromptEvent {
	systemPromptOptions: {
		sections: Record<string, string>;
		forceSystemPrompt?: string;
	};
}

/**
 * Write the index into the prompt of this request as the named section. Pi
 * sends a whole prompt instead of the sections when an earlier handler, in a
 * parent or a child, already composed one, so the section text is then
 * appended to it and returned; otherwise that prompt would hide the index
 * (D06). A later whole-prompt handler renders the prompt with the section, so
 * it keeps the index too.
 */
export function applyAgentIndexSection(event: IndexPromptEvent, section: string): { systemPrompt: string } | undefined {
	event.systemPromptOptions.sections[AGENT_INDEX_SECTION_NAME] = section;
	const forced = event.systemPromptOptions.forceSystemPrompt;
	if (forced === undefined) return undefined;
	const tagged = renderAgentIndexRequestText(section);
	if (forced.includes(tagged)) return undefined;
	return { systemPrompt: `${forced}\n\n${tagged}` };
}
