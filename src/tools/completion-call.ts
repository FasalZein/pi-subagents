import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CALL_OUTCOMES, SUMMARY_MAX_CHARS } from "../runtime/result-record.ts";
import { createDataCheck, type DataSchemaParse, readLaunchDataSchema } from "./data-schema.ts";
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
				`A second ${field} over the limit is accepted: the summary is cut and marked, and the full text goes into the report.`,
		);
	};
}

/**
 * D12: session entry that holds one accepted completion call by tool call id. The child appends it
 * synchronously inside the tool, before any exit record, so the parent can type the result from it
 * when Pi has not yet persisted the tool result, or omitted the arguments of a nested call over its
 * 8 KiB limit, or a person took over the pane and no exit record exists.
 */
export const SUBAGENT_ACCEPTED_CALL_ENTRY = "pi-subagent-accepted-call";

export interface AcceptedCallEntry {
	toolCallId: string;
	tool: string;
	args: Record<string, unknown>;
	/**
	 * True when no person had taken over: the call ends the run and is final for its result (D12). Pi
	 * ends the turn only when every call of a batch terminates, so a call inside codemode or beside
	 * another tool can get an acknowledgement turn; that later text never replaces the result.
	 */
	autonomous: boolean;
	/** D12: data that failed the launch schema twice; the result is typed with this error and no data. */
	dataError?: string;
}

export function recordAcceptedCall(pi: Pick<ExtensionAPI, "appendEntry">, entry: AcceptedCallEntry): void {
	pi.appendEntry<AcceptedCallEntry>(SUBAGENT_ACCEPTED_CALL_ENTRY, entry);
}

const OUTCOME_DESCRIPTION = "done, partial or blocked";
const SUMMARY_DESCRIPTION = `What you accomplished, at most ${COMPLETION_LIMIT_TEXT}`;
const ARTIFACTS_DESCRIPTION = "Paths of the files you wrote";
const DATA_ANY_DESCRIPTION = "Any JSON value for the caller";

/**
 * D12 parameters. All optional and loose: a call without a valid outcome and a non-empty summary
 * (for example the old call with no arguments) still ends the child, untyped, so the schema must
 * not refuse it.
 */
function buildSubagentDoneParams(launchSchema: DataSchemaParse | undefined) {
	// D12: the child sees the launch schema where it writes data; the parent's context never holds it.
	const DATA_DESCRIPTION = launchSchema?.ok
		? `JSON data for the caller; it must match this JSON Schema: ${JSON.stringify(launchSchema.value.schema)}`
		: DATA_ANY_DESCRIPTION;
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

/** D12: a call is typed only with a valid outcome and a non-empty summary. */
function isTypedCall(args: Record<string, unknown>): boolean {
	return (
		CALL_OUTCOMES.some((outcome) => outcome === args.outcome) &&
		typeof args.summary === "string" &&
		args.summary.trim() !== ""
	);
}

export interface SubagentDoneDeps {
	isTakenOver(): boolean;
	writeExitSignal: (payload: object, opts?: { supersede?: boolean }) => unknown;
	requestShutdown: (ctx: { shutdown: () => void }) => void;
	getOutputTokens: () => number;
	/** D12: an accepted call; the run gets no missing-call nudge after it. */
	onAccepted(): void;
}

export function registerSubagentDoneTool(
	pi: Pick<ExtensionAPI, "registerTool" | "appendEntry">,
	deps: SubagentDoneDeps,
) {
	const refuseOversizeSummary = createOversizeRefusal(SUBAGENT_DONE_TOOL_NAME, "summary");
	const launchSchema = readLaunchDataSchema();
	const checkData = createDataCheck(SUBAGENT_DONE_TOOL_NAME, () => launchSchema);
	pi.registerTool({
		name: SUBAGENT_DONE_TOOL_NAME,
		label: "Subagent Done",
		description:
			"When your task is complete, close this session and return your result to the caller: outcome (done, partial or blocked), " +
			`a summary of at most ${COMPLETION_LIMIT_TEXT}, the paths of files you wrote, and optional JSON data.`,
		parameters: buildSubagentDoneParams(launchSchema),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			refuseOversizeSummary((params as { summary?: unknown }).summary);
			const args = params as Record<string, unknown>;
			// D12: only a typed call carries data, so only a typed call is checked.
			const verdict = isTypedCall(args) ? checkData(args.data) : undefined;
			const dataError = verdict?.kind === "data_error" ? verdict.error : undefined;
			const autonomous = !deps.isTakenOver();
			recordAcceptedCall(pi, { toolCallId, tool: SUBAGENT_DONE_TOOL_NAME, args, autonomous, dataError });
			deps.onAccepted();
			if (!autonomous) {
				// D11/D12: the result stays in this session; the pane closes only
				// when the person closes it. The model's turn still ends here.
				return {
					terminate: true,
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
				{ type: "done", outputTokens: deps.getOutputTokens(), acceptedCall: { toolCallId, args, dataError } },
				{ supersede: true },
			);
			deps.requestShutdown(ctx);
			// D12: an accepted autonomous call is final. Print mode installs no shutdown handler, so
			// end the agent loop here; another model turn would replace the typed result.
			return {
				terminate: true,
				content: [{ type: "text", text: "Shutting down subagent session." }],
				details: {},
			};
		},
	});
}
