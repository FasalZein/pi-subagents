import type { ExtensionAPI, SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CODEMODE_TOOL_NAME, TOOL_SEARCH_TOOL_NAME } from "./tool-names.ts";

/**
 * How the management tools (wait, resume, stop, agents) are declared (D21).
 * Deferred tools cost no declaration until codemode or tool search asks for them.
 */
type ManagementToolExposure = "deferred" | "direct";

export interface ManagementToolGrant {
	/**
	 * Whether this session may launch, checked at call time: a deferred tool
	 * stays callable from codemode while it is not active (D21).
	 */
	mayLaunch(): boolean;
}

/** Deferred when codemode or tool search is active, direct otherwise. */
function selectManagementToolExposure(activeTools: readonly string[]): ManagementToolExposure {
	return activeTools.includes(CODEMODE_TOOL_NAME) || activeTools.includes(TOOL_SEARCH_TOOL_NAME)
		? "deferred"
		: "direct";
}

/** The tool names that tool_search calls on this branch loaded (its result details name them). */
function searchLoadedToolNames(branch: readonly SessionEntry[]): Set<string> {
	const loaded = new Set<string>();
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		if (entry.message.toolName !== TOOL_SEARCH_TOOL_NAME) continue;
		const names = (entry.message.details as { loaded?: unknown } | undefined)?.loaded;
		if (!Array.isArray(names)) continue;
		for (const name of names) if (typeof name === "string") loaded.add(name);
	}
	return loaded;
}

// biome-ignore lint/suspicious/noExplicitAny: tool definitions differ in their parameter schemas.
type AnyToolDefinition = ToolDefinition<any, any>;

/**
 * The management tools register direct while the extension loads, so Pi's own
 * startup decides which are active: the transcript's loadout and `--tools -name`
 * apply to them like to any tool registered at load. Built-in MCP enables
 * codemode or tool search in its session_start, after this package's handler,
 * so the exposure is final only at the first before_agent_start.
 */
export function createManagementToolExposure(pi: ExtensionAPI) {
	const definitions = new Map<string, AnyToolDefinition>();
	let finalized = false;
	/** An ExtensionAPI whose registerTool also records the definition for re-registration. */
	const recordingApi: ExtensionAPI = Object.assign(Object.create(pi) as ExtensionAPI, {
		registerTool(definition: AnyToolDefinition) {
			definitions.set(definition.name, definition);
			pi.registerTool(definition);
		},
	});
	/**
	 * With codemode or tool search active, re-register every management tool as
	 * deferred. A tool stays active only when a tool_search call on this branch
	 * loaded it; earlier automatic direct declarations are withdrawn. Pi keeps an
	 * active tool active when only its exposure changes, so a withdrawn tool is
	 * first re-registered hidden, which deactivates it. pi.setActiveTools() would
	 * also drop restored tools that are still pending, such as tools of MCP
	 * servers that are still connecting.
	 */
	function finalize(branch: readonly SessionEntry[]): void {
		if (finalized) return;
		finalized = true;
		if (selectManagementToolExposure(pi.getActiveTools()) === "direct") return;
		const loaded = searchLoadedToolNames(branch);
		for (const definition of definitions.values()) {
			if (!loaded.has(definition.name)) pi.registerTool({ ...definition, exposure: "hidden" });
			pi.registerTool({ ...definition, exposure: "deferred" });
		}
	}
	return { recordingApi, finalize };
}
