import { formatTimeoutSeconds } from "../runtime/timeout-budget.ts";
import type { ParsedSpawnEnv } from "../spawn/policy.ts";
import { type AgentListEntry, describeVerifiedFanOut, getCompletion, getContextWarnPercent } from "./agent-list.ts";
import type { AgentCatalog, MalformedAgentFile } from "./definitions.ts";
import { selectIndexTargets } from "./index-section.ts";
import { buildModelRef, formatRefsByProvider, parseAllowedModels } from "./model-refs.ts";

/** One agent the caller may launch: a parsed definition, or a file that failed to parse (D24). */
export type LaunchableAgent =
	| { kind: "agent"; entry: AgentListEntry }
	| { kind: "malformed"; file: MalformedAgentFile };

/** What one call asks for (D20). */
export type AgentsRequest =
	| { kind: "count" }
	| { kind: "name"; name: string }
	| { kind: "query"; query: string; limit: number };

export const DEFAULT_QUERY_LIMIT = 5;
const SUGGESTION_COUNT = 3;
// Same routing length as an index line (D19).
const DESCRIPTION_CHARS = 100;

function nameOf(agent: LaunchableAgent): string {
	return agent.kind === "agent" ? agent.entry.name : agent.file.name;
}

/**
 * The agents this caller may launch, sorted by name: the definitions the
 * launch policy allows (the index selection), and each effective malformed
 * file whose name the caller's grant includes. A malformed file has no
 * readable visible-to or spawn fields, so only the grant decides for it.
 */
export function selectLaunchableAgents(
	entries: readonly AgentListEntry[],
	catalog: Pick<AgentCatalog, "malformedFiles" | "lookup">,
	spawnEnv: ParsedSpawnEnv,
): LaunchableAgent[] {
	const budgetLeft = spawnEnv.callerBudget === null || spawnEnv.callerBudget > 0;
	const granted = (name: string) =>
		budgetLeft &&
		name !== spawnEnv.callerAgent &&
		(spawnEnv.callerSpawnable === true || spawnEnv.callerSpawnable.includes(name));
	// Only the effective file of a name counts: a project file shadows a global one.
	const malformed = catalog.malformedFiles.filter((file) => {
		const effective = catalog.lookup(file.name);
		return effective?.kind === "malformed" && effective.file === file && granted(file.name);
	});
	return [
		...selectIndexTargets(entries, spawnEnv).map((entry): LaunchableAgent => ({ kind: "agent", entry })),
		...malformed.map((file): LaunchableAgent => ({ kind: "malformed", file })),
	].sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0));
}

function shortDescription(entry: AgentListEntry): string {
	return (entry.description ?? "").replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_CHARS).trimEnd();
}

function renderParseError(file: MalformedAgentFile): string {
	return `Agent '${file.name}' is malformed in ${file.path}: ${file.error}`;
}

function renderModels(entry: AgentListEntry): string {
	if (entry.allowModelOverride === false) return "models: the default only (overrides are ignored)";
	const allowed = parseAllowedModels(entry.allowedModels);
	if (allowed.length === 0) return "models: any model ref";
	const defaultRef = buildModelRef(entry.model, entry.thinking);
	const accepted = [...new Set([defaultRef, ...allowed].filter((ref): ref is string => !!ref))];
	return `models: ${formatRefsByProvider(accepted)}`;
}

const SESSION_MODES = {
	standalone: "fresh chat, needs a full brief",
	"lineage-only": "fresh chat linked to this session, needs a full brief",
	fork: "copy of this chat",
} as const satisfies Record<AgentListEntry["sessionMode"], string>;

function renderChild(entry: AgentListEntry): string {
	const verified = describeVerifiedFanOut(entry);
	return [
		`child: ${entry.mode === "background" ? "headless" : "pane when a multiplexer is available"}`,
		getCompletion(entry) === "exits_automatically" ? "closes itself" : "stays open until a human or the agent finishes",
		entry.async === false ? "launch waits for the result" : "launch returns at once",
		...(verified ? [`verified fan-out (${verified})`] : []),
	].join(", ");
}

function renderLimits(entry: AgentListEntry): string {
	const contextWarn = getContextWarnPercent(entry);
	const limits = [
		entry.timeout !== undefined ? `timeout ${formatTimeoutSeconds(entry.timeout)}` : undefined,
		entry.idleTimeout !== undefined ? `idle-timeout ${formatTimeoutSeconds(entry.idleTimeout)}` : undefined,
		contextWarn !== undefined ? `context-warn ${contextWarn}%` : undefined,
		entry.reportContextUsage === false ? "token counts hidden" : undefined,
	].filter((limit): limit is string => limit !== undefined);
	return `limits: ${limits.length > 0 ? limits.join(", ") : "none"}`;
}

function renderMayLaunch(entry: AgentListEntry): string {
	const { spawning } = entry;
	if (spawning === false || (Array.isArray(spawning) && spawning.length === 0)) return "may launch: none";
	const bounds = [
		entry.spawnDepth !== undefined ? `depth ${entry.spawnDepth}` : undefined,
		entry.spawnWidth !== undefined ? `width ${entry.spawnWidth}` : undefined,
	].filter((bound): bound is string => bound !== undefined);
	const names = spawning === true ? "any agent" : spawning.join(", ");
	return `may launch: ${names}${bounds.length > 0 ? ` (${bounds.join(", ")})` : ""}`;
}

/** The full definition view of one agent (D20). */
export function renderAgentDetail(entry: AgentListEntry): string {
	return [
		`${entry.name} (${entry.source}): ${(entry.description ?? "").trim()}`,
		`default model: ${buildModelRef(entry.model, entry.thinking) ?? "the parent's model"}`,
		renderModels(entry),
		renderChild(entry),
		`session: ${SESSION_MODES[entry.sessionMode]}`,
		renderLimits(entry),
		renderMayLaunch(entry),
	].join("\n");
}

function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		previous = current;
	}
	return previous[b.length];
}

/** The closest launchable names to a name that matched none (D23). */
function closestAgentNames(name: string, names: readonly string[], count = SUGGESTION_COUNT): string[] {
	const wanted = name.toLowerCase();
	return names
		.map((candidate) => ({ candidate, distance: editDistance(wanted, candidate.toLowerCase()) }))
		.sort((a, b) => a.distance - b.distance || (a.candidate < b.candidate ? -1 : 1))
		.slice(0, count)
		.map(({ candidate }) => candidate);
}

function renderByName(name: string, agents: readonly LaunchableAgent[]): string {
	const agent = agents.find((candidate) => nameOf(candidate) === name);
	if (agent?.kind === "agent") return renderAgentDetail(agent.entry);
	if (agent?.kind === "malformed") return renderParseError(agent.file);
	const closest = closestAgentNames(name, agents.map(nameOf));
	return `No agent '${name}' that you may launch.${closest.length > 0 ? ` Closest: ${closest.join(", ")}.` : ""}`;
}

function scoreMatch(agent: LaunchableAgent, terms: readonly string[]): number {
	const name = nameOf(agent).toLowerCase();
	const text = agent.kind === "agent" ? (agent.entry.description ?? "").toLowerCase() : agent.file.error.toLowerCase();
	// A name hit ranks above a description hit; every term adds its own weight.
	return terms.reduce((score, term) => score + (name.includes(term) ? 3 : 0) + (text.includes(term) ? 1 : 0), 0);
}

function renderMatchLine(agent: LaunchableAgent): string {
	return agent.kind === "agent"
		? `- ${agent.entry.name}: ${shortDescription(agent.entry)}`
		: `- ${agent.file.name}: malformed, ${agent.file.error.replace(/\s+/g, " ").slice(0, DESCRIPTION_CHARS)}`;
}

function renderByQuery(query: string, limit: number, agents: readonly LaunchableAgent[]): string {
	const terms = query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
	const matches = agents
		.map((agent) => ({ agent, score: scoreMatch(agent, terms) }))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
	if (matches.length === 0) return `No agent matches '${query}'. ${agents.length} agents in total.`;
	return matches.map(({ agent }) => renderMatchLine(agent)).join("\n");
}

function renderCount(agents: readonly LaunchableAgent[]): string {
	if (agents.length === 0) return "No agents that you may launch.";
	const malformed = agents.filter((agent) => agent.kind === "malformed").length;
	return (
		`${agents.length} agents that you may launch${malformed > 0 ? ` (${malformed} malformed)` : ""}. ` +
		"Call subagent_agents with query for the best matches or name for one full definition."
	);
}

export function answerAgentsRequest(request: AgentsRequest, agents: readonly LaunchableAgent[]): string {
	switch (request.kind) {
		case "count":
			return renderCount(agents);
		case "name":
			return renderByName(request.name, agents);
		case "query":
			return renderByQuery(request.query, request.limit, agents);
		default: {
			const _exhaustive: never = request;
			return _exhaustive;
		}
	}
}
