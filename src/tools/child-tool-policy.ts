import { SUBAGENT_DONE_TOOL_NAME } from "./tool-names.ts";

// Child-side tool policy: which tools PI_DENY_TOOLS removes and whether subagent_done registers.

/** D12: every child keeps subagent_done unless PI_DENY_TOOLS names it, auto-exit children included. */
export function getDeniedToolNames(deniedEnv = process.env.PI_DENY_TOOLS ?? ""): string[] {
	return deniedEnv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function filterToolNames(toolNames: string[], deniedTools: string[]): string[] {
	const denied = new Set(deniedTools);
	const seen = new Set<string>();
	return toolNames.filter((name) => {
		if (!name || denied.has(name) || seen.has(name)) return false;
		seen.add(name);
		return true;
	});
}

/** D12: auto-exit, headless and manual pane children all register it; only a deny entry removes it. */
export function shouldRegisterSubagentDone(deniedTools: readonly string[]): boolean {
	return !deniedTools.includes(SUBAGENT_DONE_TOOL_NAME);
}
