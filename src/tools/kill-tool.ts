import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findRunningSubagent } from "../runtime/running-registry.ts";
import { asSubagentToolResult } from "../runtime/state.ts";
import type { RunningSubagent } from "../types.ts";
import { formatLaunchGrantRefusal, type ManagementToolGrant } from "./tool-exposure.ts";
import { SUBAGENT_KILL_TOOL_NAME } from "./tool-names.ts";

const SubagentKillParams = Type.Object({
	id: Type.String({
		description: "Running subagent id or display name to stop",
	}),
});

export function registerSubagentKillTool(
	pi: ExtensionAPI,
	shouldRegister: (name: string) => boolean,
	stopRunningSubagent: (running: RunningSubagent) => Promise<void>,
	grant: ManagementToolGrant,
): void {
	if (!shouldRegister(SUBAGENT_KILL_TOOL_NAME)) return;
	pi.registerTool({
		name: SUBAGENT_KILL_TOOL_NAME,
		label: "Kill Subagent",
		description: "Stop a running subagent, pane or headless, by its run id or name.",
		parameters: SubagentKillParams,
		exposure: grant.exposure,
		execute: async (_toolCallId, params) => {
			if (!grant.mayLaunch()) throw new Error(formatLaunchGrantRefusal(SUBAGENT_KILL_TOOL_NAME));
			const match = findRunningSubagent(params.id);
			if (!match.running)
				return asSubagentToolResult({
					content: [
						{
							type: "text" as const,
							text: match.error ?? "Subagent not found.",
						},
					],
					details: { error: match.error ?? "not found" },
				});
			await stopRunningSubagent(match.running);
			return asSubagentToolResult({
				content: [
					{
						type: "text" as const,
						text: `Stopping subagent "${match.running.name}" (${match.running.id}).`,
					},
				],
				details: {
					id: match.running.id,
					name: match.running.name,
					status: "stopping",
				},
			});
		},
	});
}
