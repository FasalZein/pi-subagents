import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_DONE_TOOL_NAME } from "./tool-names.ts";

// Child-side tool policy: which tools PI_DENY_TOOLS removes and whether subagent_done registers.

export function getDeniedToolNames(autoExit: boolean, deniedEnv = process.env.PI_DENY_TOOLS ?? ""): string[] {
	const denied = deniedEnv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (autoExit && !denied.includes(SUBAGENT_DONE_TOOL_NAME)) {
		denied.push(SUBAGENT_DONE_TOOL_NAME);
	}
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

export function shouldRegisterSubagentDone(autoExit: boolean, deniedTools: string[], isInteractive = false): boolean {
	if (deniedTools.includes(SUBAGENT_DONE_TOOL_NAME)) return false;
	if (autoExit) return false;
	if (isInteractive) return false;
	return true;
}

type ToolControlAPI = Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools" | "registerTool">;

export function installDeniedToolGuards(
	pi: ToolControlAPI,
	autoExit: boolean,
	onChange?: (activeTools: string[], deniedTools: string[]) => void,
) {
	const originalRegisterTool = pi.registerTool.bind(pi);
	const originalSetActiveTools = pi.setActiveTools.bind(pi);

	const notify = (activeTools: string[], deniedTools: string[]) => {
		onChange?.([...activeTools].sort(), [...deniedTools]);
	};

	const applyDeniedTools = (): string[] => {
		const deniedTools = getDeniedToolNames(autoExit);
		const allowedTools = filterToolNames(pi.getActiveTools(), deniedTools);
		originalSetActiveTools(allowedTools);
		notify(allowedTools, deniedTools);
		return allowedTools;
	};

	pi.setActiveTools = (toolNames: string[]) => {
		const deniedTools = getDeniedToolNames(autoExit);
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
