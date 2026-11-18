import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { IndexLaunchPolicy } from "../agents/index-section.ts";
import {
	type AgentsRequest,
	answerAgentsRequest,
	DEFAULT_QUERY_LIMIT,
	type LaunchableAgent,
} from "../agents/launchable-agents.ts";
import { asSubagentToolResult } from "../runtime/state.ts";
import type { ParsedSpawnEnv } from "../spawn/policy.ts";
import { SUBAGENT_AGENTS_TOOL_NAME } from "./tool-names.ts";
import type { ManagementToolGrant } from "./tool-exposure.ts";

/** Parse the tool parameters into one request; name and query together are refused. */
function parseAgentsRequest(params: { name?: string; query?: string; limit?: number }): AgentsRequest | string {
	const name = params.name?.trim();
	const query = params.query?.trim();
	if (name && query) return "Pass name or query, not both.";
	if (name) return { kind: "name", name };
	if (query) return { kind: "query", query, limit: params.limit ?? DEFAULT_QUERY_LIMIT };
	return { kind: "count" };
}

interface AgentsToolRuntime {
	spawnEnv(): ParsedSpawnEnv;
	/** The agents this session may launch, read from the current files. */
	listLaunchableAgents(cwd: string, spawnEnv: ParsedSpawnEnv): LaunchableAgent[];
	/** How a solo launch from this session runs, as for the index flags. */
	launchPolicy(hasUI: boolean): IndexLaunchPolicy;
}

const LAUNCH_DENIED = "This session may not launch agents, so it has none to look up.";

export function registerSubagentAgentsTool(
	pi: ExtensionAPI,
	shouldRegister: (name: string) => boolean,
	runtime: AgentsToolRuntime,
	grant: ManagementToolGrant,
): void {
	if (!shouldRegister(SUBAGENT_AGENTS_TOOL_NAME)) return;
	pi.registerTool({
		name: SUBAGENT_AGENTS_TOOL_NAME,
		label: "Subagent Agents",
		description:
			"Look up the agents you may launch: one full definition by name, the best matches for a query, or the count.",
		exposure: grant.exposure,
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Exact agent name for its full definition." })),
			query: Type.Optional(Type.String({ description: "Words to match against agent names and descriptions." })),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 50, description: "Most matches for a query (default 5)." }),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const request = grant.mayLaunch() ? parseAgentsRequest(params) : LAUNCH_DENIED;
			const spawnEnv = runtime.spawnEnv();
			const text =
				typeof request === "string"
					? request
					: answerAgentsRequest(request, runtime.listLaunchableAgents(ctx.cwd, spawnEnv), {
							spawnEnv,
							launch: runtime.launchPolicy(ctx.hasUI),
							parentModel: {
								registry: ctx.modelRegistry,
								ref: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
								thinking: pi.getThinkingLevel(),
							},
						});
			return asSubagentToolResult({
				content: [{ type: "text" as const, text }],
				details: typeof request === "string" ? { error: request } : { request: request.kind },
			});
		},
	});
}
