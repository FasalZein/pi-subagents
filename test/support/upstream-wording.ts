import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** The v2.9.2 baseline commit whose wording D06 restores. */
const BASELINE = "cf6dbf4";
const repoRoot = join(import.meta.dirname, "..", "..");

function showBaseline(path: string): string {
	return execFileSync("git", ["show", `${BASELINE}:${path}`], { cwd: repoRoot, encoding: "utf8" });
}

/**
 * The unknown-agent launch error exactly as cf6dbf4 renders it, read from its
 * source (src/launch/policy.ts), so a test compares against the baseline and
 * not against the code under test (D06).
 */
export function upstreamUnknownAgentError(agent: string, agentConfigDir: string): string {
	const template = /text: `(Error: agent "\$\{params\.agent\}" was not found in [^`]*)`/.exec(
		showBaseline("src/launch/policy.ts"),
	)?.[1];
	if (!template) throw new Error(`no unknown-agent error in ${BASELINE}:src/launch/policy.ts`);
	return template.replace("${params.agent}", agent).replace("${globalDir}", join(agentConfigDir, "agents"));
}
