import { SUBAGENT_DONE_TOOL_NAME } from "./tool-names.ts";

// Child-side tool policy: which tools PI_DENY_TOOLS removes and whether subagent_done registers.

/** The names PI_DENY_TOOLS lists; the child removes these tools from its active set. */
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

/** How this child process runs: from PI_SUBAGENT_AUTO_EXIT and PI_SUBAGENT_SURFACE. */
export interface ChildLifecycle {
	autoExit: boolean;
	/** The child runs in a pane (PI_SUBAGENT_SURFACE is set). */
	pane: boolean;
}

export function readChildLifecycle(env: NodeJS.ProcessEnv = process.env): ChildLifecycle {
	return { autoExit: env.PI_SUBAGENT_AUTO_EXIT === "1", pane: !!env.PI_SUBAGENT_SURFACE };
}

/**
 * D12: auto-exit pane and headless children register it unless a deny entry removes it. A manual
 * pane child never does (T69, as v2.9.2): only the person at the pane closes it, launch or resume.
 */
export function shouldRegisterSubagentDone(deniedTools: readonly string[], lifecycle: ChildLifecycle): boolean {
	if (lifecycle.pane && !lifecycle.autoExit) return false;
	return !deniedTools.includes(SUBAGENT_DONE_TOOL_NAME);
}
