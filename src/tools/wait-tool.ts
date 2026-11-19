import type { JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { getSessionResultsDir } from "../artifact-storage.ts";
import { sessionResultStore } from "../runtime/result-files.ts";
import { ResultRecordSchema, recordAsJson } from "../runtime/result-record-schema.ts";
import { type JoinOutcome, joinRuns } from "../runtime/wait-join.ts";
import { formatLaunchGrantRefusal, type ManagementToolGrant } from "./tool-exposure.ts";
import { SUBAGENT_WAIT_TOOL_NAME } from "./tool-names.ts";

const SubagentWaitParams = Type.Object({
	ids: Type.Optional(
		Type.Array(Type.String(), {
			description: "Run ids or names to wait for; default: every run of this session that is running or queued.",
		}),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("all"), Type.Literal("any")], {
			description: "all (default): return when every run ended; any: return when one ended.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({ minimum: 0, description: "Time limit in seconds; pending runs then report by message." }),
	),
});

/** D16: what a codemode script gets instead of the text: the records and the pending ids. */
export const SubagentWaitOutput = Type.Object({
	status: Type.Union([
		Type.Literal("complete"),
		Type.Literal("timeout"),
		Type.Literal("empty"),
		Type.Literal("interrupted"),
	]),
	results: Type.Array(
		Type.Object({
			id: Type.String(),
			text: Type.String(),
			/** The run's published record (D13); null when the run published none. */
			record: Type.Union([ResultRecordSchema, Type.Null()]),
		}),
	),
	pending: Type.Array(Type.String()),
	missing: Type.Array(Type.Object({ id: Type.String(), error: Type.String() })),
});
export type SubagentWaitStructured = Static<typeof SubagentWaitOutput>;

function replyText(outcome: JoinOutcome): string {
	if (outcome.status === "interrupted")
		return `The wait was interrupted. These runs keep running and report by message: ${outcome.pending.join(", ") || "none"}.`;
	const lines = outcome.results.map((result) => result.text);
	if (outcome.pending.length > 0)
		lines.push(`Still running, reports follow by message: ${outcome.pending.join(", ")}.`);
	for (const missing of outcome.missing) lines.push(missing.error);
	if (lines.length === 0) lines.push("No subagent run is running or queued.");
	return lines.join("\n\n");
}

function toStructured(outcome: JoinOutcome): SubagentWaitStructured {
	return {
		status: outcome.status,
		results: outcome.results.map((result) => ({
			id: result.id,
			text: result.text,
			record: result.record && recordAsJson(result.record),
		})),
		pending: outcome.pending,
		missing: outcome.missing,
	};
}

export function registerSubagentWaitTool(
	pi: ExtensionAPI,
	shouldRegister: (name: string) => boolean,
	grant: ManagementToolGrant,
): void {
	if (!shouldRegister(SUBAGENT_WAIT_TOOL_NAME)) return;
	pi.registerTool({
		name: SUBAGENT_WAIT_TOOL_NAME,
		label: "Wait for Subagents",
		description: "Wait for subagent runs by id (default: all running or queued) and return their results.",
		parameters: SubagentWaitParams,
		outputSchema: SubagentWaitOutput,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			if (!grant.mayLaunch()) throw new Error(formatLaunchGrantRefusal(SUBAGENT_WAIT_TOOL_NAME));
			const store = sessionResultStore(getSessionResultsDir(ctx.cwd, ctx.sessionManager.getSessionId()));
			const outcome = await joinRuns(params, signal, store);
			const structured = toStructured(outcome);
			return {
				content: [{ type: "text" as const, text: replyText(outcome) }],
				details: structured,
				// The one cast: a record's data is typed unknown but is JSON (D12 accepts only JSON data,
				// and a stored record is parsed from record.json).
				structuredContent: structured as unknown as JsonValue,
				...(outcome.status === "interrupted" ? { isError: true } : {}),
			};
		},
	});
}
