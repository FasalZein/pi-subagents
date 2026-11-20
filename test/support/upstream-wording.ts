import { join } from "node:path";

/**
 * The unknown-agent launch error exactly as v2.9.2 renders it, copied from
 * `git show cf6dbf4:src/launch/policy.ts` (line 30):
 *   text: `Error: agent "${params.agent}" was not found in .pi/agents/ or ${globalDir}.`
 * with globalDir = join(getAgentConfigDir(), "agents"). Pinned here, not read
 * from the code under test (D06).
 */
export function upstreamUnknownAgentError(agent: string, agentConfigDir: string): string {
	return `Error: agent "${agent}" was not found in .pi/agents/ or ${join(agentConfigDir, "agents")}.`;
}
