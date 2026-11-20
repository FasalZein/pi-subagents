import { join } from "node:path";
import type { ParsedSpawnEnv } from "../spawn/policy.ts";
import { type AgentDetailContext, renderAgentDetail } from "./agent-detail.ts";
import { type AgentListEntry, type ResolveSubagentSessionMode, toAgentListEntry } from "./agent-list.ts";
import {
	type AgentCatalog,
	getAgentConfigDir,
	type MalformedAgentFile,
	malformedFileSpawnPolicy,
} from "./definitions.ts";
import { selectIndexTargets } from "./index-section.ts";

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
// Same routing length as an index line (D19).
const DESCRIPTION_CHARS = 100;

export function nameOf(agent: LaunchableAgent): string {
	return agent.kind === "agent" ? agent.entry.name : agent.file.name;
}

/**
 * The agents this caller may launch, sorted by name, from one catalog load:
 * every effective definition the launch spawn policy allows (with or without
 * a description, which only the index requires), and every effective
 * malformed file whose stated visibility and the caller's grant allow it.
 *
 * Recorded limit: a file saved while the catalog reads the folder can be read
 * in its old or new revision; the next call reads the saved state.
 */
export function selectLaunchableAgents(
	catalog: Pick<AgentCatalog, "definitions" | "malformedFiles" | "lookup">,
	resolveSessionMode: ResolveSubagentSessionMode,
	spawnEnv: ParsedSpawnEnv,
): LaunchableAgent[] {
	const entries = catalog.definitions.map((definition) => toAgentListEntry(definition, resolveSessionMode));
	// Only the effective file of a name counts: a project file shadows a global one.
	const malformed = catalog.malformedFiles.filter((file) => {
		const effective = catalog.lookup(file.name);
		return (
			effective?.kind === "malformed" &&
			effective.file === file &&
			file.name !== spawnEnv.callerAgent &&
			malformedFileSpawnPolicy(file, spawnEnv).allowed
		);
	});
	return [
		...selectIndexTargets(entries, spawnEnv).map((entry): LaunchableAgent => ({ kind: "agent", entry })),
		...malformed.map((file): LaunchableAgent => ({ kind: "malformed", file })),
	].sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0));
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_CHARS).trimEnd();
}

function renderParseError(file: MalformedAgentFile): string {
	return `Agent '${file.name}' is malformed in ${file.path}: ${file.error}`;
}

function renderByName(name: string, agents: readonly LaunchableAgent[], context: AgentDetailContext): string {
	const agent = agents.find((candidate) => nameOf(candidate) === name);
	if (agent?.kind === "agent") return renderAgentDetail(agent.entry, context);
	if (agent?.kind === "malformed") return renderParseError(agent.file);
	return `Error: ${renderUnknownAgentRefusal(name)}`;
}

/** Where agent files are searched, as the v2.9.2 unknown-agent error names them (cf6dbf4 src/launch/policy.ts). */
export function agentFileLocations(): string {
	return `.pi/agents/ or ${join(getAgentConfigDir(), "agents")}`;
}

/**
 * The refusal of a name that matched no launchable agent, worded as v2.9.2
 * after its "Error: " prefix: the requested name and the search locations, no
 * substitute names (D06). JSON quoting equals the v2.9.2 quotes for a plain
 * name and keeps a name with a line break on one line (review 8). The second
 * parameter is unused; the launch tool still passes it
 * (src/tools/subagent-tools.ts, owned by a parallel ticket).
 */
export function renderUnknownAgentRefusal(name: string, _names?: readonly string[]): string {
	return `agent ${JSON.stringify(name)} was not found in ${agentFileLocations()}.`;
}

function scoreMatch(agent: LaunchableAgent, terms: readonly string[]): number {
	const name = nameOf(agent).toLowerCase();
	const text = agent.kind === "agent" ? (agent.entry.description ?? "").toLowerCase() : agent.file.error.toLowerCase();
	// A name hit ranks above a description hit; every term adds its own weight.
	return terms.reduce((score, term) => score + (name.includes(term) ? 3 : 0) + (text.includes(term) ? 1 : 0), 0);
}

function renderMatchLine(agent: LaunchableAgent): string {
	return agent.kind === "agent"
		? `- ${agent.entry.name}: ${singleLine(agent.entry.description ?? "")}`
		: `- ${agent.file.name}: malformed, ${singleLine(agent.file.error)}`;
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
	// The query is not echoed: a reply stays one bounded line for any input.
	if (matches.length === 0) return `No agent matches the query. ${agents.length} agents in total.`;
	return matches.map(({ agent }) => renderMatchLine(agent)).join("\n");
}

function renderCount(agents: readonly LaunchableAgent[]): string {
	const malformed = agents.filter((agent) => agent.kind === "malformed").length;
	return (
		`${agents.length} agents that you may launch${malformed > 0 ? ` (${malformed} malformed)` : ""}. ` +
		"Call subagent_agents with query for the best matches or name for one full definition."
	);
}

export function answerAgentsRequest(
	request: AgentsRequest,
	agents: readonly LaunchableAgent[],
	context: Omit<AgentDetailContext, "visibleNames">,
): string {
	switch (request.kind) {
		case "count":
			return renderCount(agents);
		case "name":
			return renderByName(request.name, agents, { ...context, visibleNames: new Set(agents.map(nameOf)) });
		case "query":
			return renderByQuery(request.query, request.limit, agents);
		default: {
			const _exhaustive: never = request;
			return _exhaustive;
		}
	}
}
