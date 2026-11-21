import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findRunningSubagent } from "../runtime/running-registry.ts";
import { asSubagentToolResult } from "../runtime/state.ts";
import type { RunningSubagent } from "../types.ts";
import { SUBAGENT_KILL_TOOL_NAME } from "./tool-names.ts";

// T88: the key of the launch reply (children[].runId); an unknown key such as the old "id" is refused.
const SubagentKillParams = Type.Object(
	{
		runId: Type.String({
			description: "Run id or display name.",
		}),
	},
	{ additionalProperties: false },
);

export function registerSubagentKillTool(
	pi: ExtensionAPI,
	shouldRegister: (name: string) => boolean,
	stopRunningSubagent: (running: RunningSubagent) => Promise<void>,
): void {
	// D07: stop has its own grant. Only its deny-tools entry removes it; a session that may not
	// launch keeps control of the children it already has.
	if (!shouldRegister(SUBAGENT_KILL_TOOL_NAME)) return;
	pi.registerTool({
		name: SUBAGENT_KILL_TOOL_NAME,
		label: "Kill Subagent",
		description: "Stop a running subagent by run id or name.",
		parameters: SubagentKillParams,
		execute: async (_toolCallId, params) => {
			const match = findRunningSubagent(params.runId);
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
			// T83: an adopted watcher ends the run before it leaves the map; the stop would be a no-op.
			if (match.running.phase === "ended")
				return asSubagentToolResult({
					content: [
						{
							type: "text" as const,
							text: `Subagent "${match.running.name}" (${match.running.id}) already ended.`,
						},
					],
					details: { id: match.running.id, name: match.running.name, status: "ended" },
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
