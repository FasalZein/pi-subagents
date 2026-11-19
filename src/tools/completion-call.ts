import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUMMARY_MAX_CHARS } from "../runtime/result-record.ts";
import { optionalRequire } from "./optional-dependency.ts";
import { SUBAGENT_DONE_TOOL_NAME } from "./tool-names.ts";

/** The D12 limit as the child reads it in its brief and in a refusal. */
export const COMPLETION_LIMIT_TEXT = `${SUMMARY_MAX_CHARS.toLocaleString("en-US")} characters`;

/**
 * D12: the first text over the limit is refused with a tool error; a later one is accepted, and the
 * parent cuts its summary and keeps the full text in the report. One latch per tool and process.
 */
export function createOversizeRefusal(tool: string, field: string) {
	let refused = false;
	return (text: unknown) => {
		if (refused || typeof text !== "string" || text.length <= SUMMARY_MAX_CHARS) return;
		refused = true;
		throw new Error(
			`${tool} refused: ${field} has ${text.length.toLocaleString("en-US")} characters; the limit is ${COMPLETION_LIMIT_TEXT}. ` +
				`Shorten ${field} to ${COMPLETION_LIMIT_TEXT} or less and call ${tool} again. ` +
				`A second ${field} over the limit is accepted: its first ${COMPLETION_LIMIT_TEXT} become the summary and the full text goes into the report.`,
		);
	};
}

const OUTCOME_DESCRIPTION = "done, partial or blocked";
const SUMMARY_DESCRIPTION = `What you accomplished, at most ${COMPLETION_LIMIT_TEXT}`;
const ARTIFACTS_DESCRIPTION = "Paths of the files you wrote";
const DATA_DESCRIPTION = "Any JSON value for the caller";

/**
 * D12 parameters. All optional and loose: a call without a valid outcome and a non-empty summary
 * (for example the old call with no arguments) still ends the child, untyped, so the schema must
 * not refuse it.
 */
function buildSubagentDoneParams() {
	const typebox = optionalRequire("typebox") as typeof import("typebox") | null;
	if (typebox?.Type?.Object) {
		const { Type } = typebox;
		return Type.Object({
			outcome: Type.Optional(Type.String({ description: OUTCOME_DESCRIPTION })),
			summary: Type.Optional(Type.String({ description: SUMMARY_DESCRIPTION })),
			artifacts: Type.Optional(Type.Array(Type.String(), { description: ARTIFACTS_DESCRIPTION })),
			data: Type.Optional(Type.Unknown({ description: DATA_DESCRIPTION })),
		});
	}
	return {
		type: "object",
		properties: {
			outcome: { type: "string", description: OUTCOME_DESCRIPTION },
			summary: { type: "string", description: SUMMARY_DESCRIPTION },
			artifacts: { type: "array", items: { type: "string" }, description: ARTIFACTS_DESCRIPTION },
			data: { description: DATA_DESCRIPTION },
		},
	};
}

export interface SubagentDoneDeps {
	isTakenOver(): boolean;
	writeExitSignal: (payload: object, opts?: { supersede?: boolean }) => unknown;
	requestShutdown: (ctx: { shutdown: () => void }) => void;
	getOutputTokens: () => number;
}

export function registerSubagentDoneTool(pi: Pick<ExtensionAPI, "registerTool">, deps: SubagentDoneDeps) {
	const refuseOversizeSummary = createOversizeRefusal(SUBAGENT_DONE_TOOL_NAME, "summary");
	pi.registerTool({
		name: SUBAGENT_DONE_TOOL_NAME,
		label: "Subagent Done",
		description:
			"When your task is complete, close this session and return your result to the caller: outcome (done, partial or blocked), " +
			`a summary of at most ${COMPLETION_LIMIT_TEXT}, the paths of files you wrote, and optional JSON data.`,
		parameters: buildSubagentDoneParams(),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			refuseOversizeSummary((params as { summary?: unknown }).summary);
			if (deps.isTakenOver()) {
				// D11/D12: the result stays in this session; the pane closes only
				// when the person closes it.
				return {
					content: [
						{
							type: "text",
							text: "Result recorded in this session. A person took over this pane, so it stays open until they close it.",
						},
					],
					details: {},
				};
			}
			// D12: Pi omits oversize nested-call arguments from the session; the parent reads them here.
			deps.writeExitSignal(
				{ type: "done", outputTokens: deps.getOutputTokens(), acceptedCall: { toolCallId, args: params } },
				{ supersede: true },
			);
			deps.requestShutdown(ctx);
			return {
				content: [{ type: "text", text: "Shutting down subagent session." }],
				details: {},
			};
		},
	});
}
