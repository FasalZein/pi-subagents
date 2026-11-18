import { CODEMODE_TOOL_NAME, TOOL_SEARCH_TOOL_NAME } from "./tool-names.ts";

/**
 * How the management tools (resume, stop, agents; T24 adds wait) are declared (D21).
 * Deferred tools cost no declaration until codemode or tool search asks for them.
 */
export type ManagementToolExposure = "deferred" | "direct";

export interface ManagementToolGrant {
	readonly exposure: ManagementToolExposure;
	/**
	 * Whether this session may launch, checked at call time: a deferred tool
	 * stays callable from codemode while it is not active (D21).
	 */
	mayLaunch(): boolean;
}

/**
 * Deferred when codemode or tool search is active, direct otherwise. Pi binds
 * the active tool list only after the extension loads, so the caller makes this
 * choice at session start.
 */
export function selectManagementToolExposure(activeTools: readonly string[]): ManagementToolExposure {
	return activeTools.includes(CODEMODE_TOOL_NAME) || activeTools.includes(TOOL_SEARCH_TOOL_NAME)
		? "deferred"
		: "direct";
}

export function formatLaunchGrantRefusal(toolName: string): string {
	return `This session may not launch agents, so it may not call ${toolName}.`;
}
