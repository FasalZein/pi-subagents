import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

type ToolControlAPI = Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools" | "registerTool">;

export function installDeniedToolGuards(
	pi: ToolControlAPI,
	onChange?: (activeTools: string[], deniedTools: string[]) => void,
) {
	const originalRegisterTool = pi.registerTool.bind(pi);
	const originalSetActiveTools = pi.setActiveTools.bind(pi);

	const notify = (activeTools: string[], deniedTools: string[]) => {
		onChange?.([...activeTools].sort(), [...deniedTools]);
	};

	const applyDeniedTools = (): string[] => {
		const deniedTools = getDeniedToolNames();
		const allowedTools = filterToolNames(pi.getActiveTools(), deniedTools);
		originalSetActiveTools(allowedTools);
		notify(allowedTools, deniedTools);
		return allowedTools;
	};

	pi.setActiveTools = (toolNames: string[]) => {
		const deniedTools = getDeniedToolNames();
		const allowedTools = filterToolNames(toolNames, deniedTools);
		originalSetActiveTools(allowedTools);
		notify(allowedTools, deniedTools);
	};

	pi.registerTool = (definition) => {
		const result = originalRegisterTool(definition);
		applyDeniedTools();
		return result;
	};

	return { applyDeniedTools };
}
