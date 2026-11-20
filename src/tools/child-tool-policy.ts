import { SUBAGENT_DONE_TOOL_NAME } from "./tool-names.ts";

// Child-side tool policy as in cf6dbf4 (T72, D01 revert): which tools the child removes from its
// active set and whether subagent_done registers.

/**
 * The names PI_DENY_TOOLS lists, plus subagent_done for an auto-exit child: an auto-exit child ends
 * after its answer, so it has no completion tool (cf6dbf4).
 */
export function getDeniedToolNames(autoExit: boolean, deniedEnv = process.env.PI_DENY_TOOLS ?? ""): string[] {
	const denied = deniedEnv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (autoExit && !denied.includes(SUBAGENT_DONE_TOOL_NAME)) denied.push(SUBAGENT_DONE_TOOL_NAME);
	return denied;
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
 * cf6dbf4: only a headless child without auto-exit registers the zero-argument subagent_done. An
 * auto-exit child ends after its answer; a manual pane child ends when the person closes it (T69).
 */
export function shouldRegisterSubagentDone(deniedTools: readonly string[], lifecycle: ChildLifecycle): boolean {
	if (deniedTools.includes(SUBAGENT_DONE_TOOL_NAME)) return false;
	return !lifecycle.autoExit && !lifecycle.pane;
}
