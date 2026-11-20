import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { optionalRequire } from "./optional-dependency.ts";
import { SUBAGENT_DONE_TOOL_NAME } from "./tool-names.ts";

/**
 * D12: session entry that holds one accepted completion call by tool call id. Since T72 the child
 * writes it only for a caller_ping in a taken-over pane, which writes no exit record; the parent
 * still reads it, and the typed subagent_done entries of older sessions.
 */
export const SUBAGENT_ACCEPTED_CALL_ENTRY = "pi-subagent-accepted-call";

interface AcceptedCallEntry {
	toolCallId: string;
	tool: string;
	args: Record<string, unknown>;
	/** True when no person had taken over: the call ends the run. */
	autonomous: boolean;
}

/**
 * Best effort (C39): a failed append must not skip the caller's shutdown or exit record. Returns
 * whether the entry was written.
 */
export function recordAcceptedCall(pi: Pick<ExtensionAPI, "appendEntry">, entry: AcceptedCallEntry): boolean {
	try {
		pi.appendEntry<AcceptedCallEntry>(SUBAGENT_ACCEPTED_CALL_ENTRY, entry);
		return true;
	} catch {
		return false;
	}
}

/** T64: the subagent_done fields an older typed call may hold as a JSON string; the parent parses them. */
export const COMPLETION_JSON_FIELDS = ["artifacts", "data"] as const;

interface SubagentDoneDeps {
	/** D11: a person took over; the call ends the turn but writes no exit record and closes nothing. */
	isTakenOver(): boolean;
	writeExitSignal: (payload: object, opts?: { supersede?: boolean }) => unknown;
	requestShutdown: (ctx: { shutdown: () => void }) => void;
	getOutputTokens: () => number;
}

/**
 * cf6dbf4: the zero-argument subagent_done of a headless child without auto-exit. The last
 * assistant message before the call is the result; the call itself carries nothing.
 */
export function registerSubagentDoneTool(pi: Pick<ExtensionAPI, "registerTool">, deps: SubagentDoneDeps) {
	const typebox = optionalRequire("typebox") as typeof import("typebox") | null;
	const doneParams = typebox?.Type?.Object
		? typebox.Type.Object({})
		: { type: "object", properties: {}, additionalProperties: false };
	pi.registerTool({
		name: SUBAGENT_DONE_TOOL_NAME,
		label: "Subagent Done",
		description:
			"Call this tool when you have completed your task. " +
			"It will close this session and return your results to the main session. " +
			"Your LAST assistant message before calling this becomes the summary returned to the caller.",
		parameters: doneParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (deps.isTakenOver()) {
				return {
					terminate: true,
					content: [{ type: "text", text: "A person took over this session, so it stays open until they close it." }],
					details: {},
				};
			}
			deps.writeExitSignal({ type: "done", outputTokens: deps.getOutputTokens() }, { supersede: true });
			deps.requestShutdown(ctx);
			// Kept from D12: end the agent loop here. Print mode installs no shutdown handler, so another
			// model turn would replace the last message, which the description promises as the result.
			return {
				terminate: true,
				content: [{ type: "text", text: "Shutting down subagent session." }],
				details: {},
			};
		},
	});
}
