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

const FORCED_WAIT_LINE = "Every launch here waits for its result.";

const DESCRIPTION_CHARS = 100;

const FIXED_LINES = [
	"Helpers: launch with subagent (a children list). A result arrives as a message; subagent_wait joins now or looks up a run id. A helper sees only its task text unless marked [fork].",
	"Do not do delegated work yourself. A script that launches waits in the same script with a time limit and returns the pending ids.",
	"More tools: subagent_wait, subagent_resume, subagent_kill, subagent_agents (search, full detail).",
] as const;

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
export function selectIndexTargets(
	entries: readonly AgentListEntry[],
	spawnEnv: ParsedSpawnEnv,
): AgentListEntry[] {
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
	const description = (entry.description ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, DESCRIPTION_CHARS)
		.trimEnd();
	return [`- ${entry.name}: ${description}`, ...getFlags(entry, policy)].join(" ");
}

function renderCountLine(rest: number): string {
	return `+${rest} more: subagent_agents with a query`;
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
): string | undefined {
	const described = entries.filter((entry) => entry.description?.trim());
	if (described.length === 0) return undefined;
	const lines = [...described].sort(compareIndexOrder).map((entry) => renderAgentLine(entry, policy));
	const fixed = [...FIXED_LINES, ...(policy.forcesWait ? [FORCED_WAIT_LINE] : [])].join("\n");
	// Length with the first k agent lines: each line adds itself and one newline.
	const lengthWith = (k: number, prefix: number) =>
		WRAPPER_CHARS +
		fixed.length +
		prefix +
		(k < lines.length ? 1 + renderCountLine(lines.length - k).length : 0);
	// The fixed lines and a count line alone fit, so zero agent lines always fit.
	let shown = 0;
	let prefix = 0;
	for (let k = 1; k <= lines.length; k++) {
		prefix += 1 + lines[k - 1].length;
		if (lengthWith(k, prefix) <= AGENT_INDEX_MAX_CHARS) shown = k;
	}
	const rest = lines.length - shown;
	return [
		fixed,
		...lines.slice(0, shown),
		...(rest > 0 ? [renderCountLine(rest)] : []),
	].join("\n");
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
 * and returned. A later whole-prompt handler renders the prompt with the
 * section, so it keeps the index too.
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
