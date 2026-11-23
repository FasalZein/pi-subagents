import { resolve } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getSessionResultsDir } from "../artifact-storage.ts";
import { reportedRunIds, settleWaitReply } from "../runtime/delivery-queue.ts";
import { sessionResultStore } from "../runtime/result-files.ts";
import { CALL_OUTCOMES, parseRunId, type ResultRecord, type RunId } from "../runtime/result-record.ts";
import { type ResumeServiceRuntime, resumeSubagentSession } from "../runtime/resume-service.ts";
import { isFinishedStatus } from "../runtime/run-end-message.ts";
import {
	CONTEXT_PRESSURE_RESUME_REASON,
	isRenderedResult,
	launchWarningLines,
	TIME_LIMIT_RESUME_REASON,
} from "../runtime/run-result.ts";
import { shouldAwaitSubagentLaunch } from "../runtime/running-registry.ts";
import { getSubagentBatchStopMetadata, markSubagentBatchBlocking, requestSubagentBatchStop } from "../runtime/state.ts";
import { readSubagentLaunchMetadata } from "../session/session-files.ts";
import type { RunningSubagent, SubagentResult } from "../types.ts";
import { type ChildDelivery, renderLaunchReply } from "./launch-reply.ts";
import { asStructuredContent, launchedChildData, SubagentLaunchOutput } from "./launch-structured.ts";
import { formatTaskPreview, renderSubagentCompletionText } from "./message-renderers.ts";
import { getIgnoredModelOverrideWarning } from "./policy.ts";
import { shouldForceSynchronousLaunch } from "./subagent-tools.ts";
import { SUBAGENT_RESUME_TOOL_NAME } from "./tool-names.ts";

interface ResumeToolRuntime extends ResumeServiceRuntime {
	wireSubagentSteerBack(pi: ExtensionAPI, running: RunningSubagent, promise: Promise<SubagentResult>): void;
	getLaunchedSubagentResult(running: RunningSubagent, signal?: AbortSignal): Promise<AgentToolResult<unknown>>;
}

/**
 * Record reasons that a later run of the same session can supersede (the timeout verdict, the
 * context-pressure end). Other reasons (no session file, a verified fan-out attempt) never change.
 */
const SESSION_VERDICT_REASONS: ReadonlySet<string> = new Set([
	TIME_LIMIT_RESUME_REASON,
	CONTEXT_PRESSURE_RESUME_REASON,
]);

const blocksBySessionVerdict = (record: ResultRecord): boolean =>
	!record.resume.resumable && SESSION_VERDICT_REASONS.has(record.resume.reason);

/**
 * Parity D14: a session verdict in a record stops counting only when a later run of the same
 * session ended with a published done, partial or blocked result, after every record of that
 * session that carries such a verdict. A cancelled override, a failed run or a lost timeout
 * sidecar supersedes nothing, so the record keeps refusing; the live guards still run afterwards.
 */
function isSessionVerdictSuperseded(record: ResultRecord, records: readonly ResultRecord[]): boolean {
	if (!record.sessionFile) return false;
	const sessionFile = resolve(record.sessionFile);
	const sameSession = records.filter((other) => other.sessionFile && resolve(other.sessionFile) === sessionFile);
	const lastVerdictEnd = Math.max(
		record.endedAt,
		...sameSession.filter(blocksBySessionVerdict).map((other) => other.endedAt),
	);
	return sameSession.some(
		(other) => other.endedAt > lastVerdictEnd && (CALL_OUTCOMES as readonly string[]).includes(other.outcome),
	);
}

/**
 * D8: a resume names a run id or a session file. A run id resolves through the parent session's
 * result record. A record that says the run is not resumable refuses with its own reason, unless
 * a later successful run of the session superseded its session verdict (parity D14).
 */
function resolveResumeSessionFile(params: { runId?: string; sessionFile?: string }, resultsDir: string): string {
	if (params.runId && params.sessionFile) throw new Error("Give a run id or a session file, not both.");
	if (params.sessionFile) return params.sessionFile;
	if (!params.runId) throw new Error("A run id or a session file is required.");
	let runId: RunId;
	try {
		runId = parseRunId(params.runId);
	} catch {
		throw new Error(`No result with run id "${params.runId}" in this session.`);
	}
	const store = sessionResultStore(resultsDir);
	const record = store.read(runId);
	if (!record) throw new Error(`No result with run id "${params.runId}" in this session.`);
	if (!record.resume.resumable && !(blocksBySessionVerdict(record) && isSessionVerdictSuperseded(record, store.list())))
		throw new Error(`Run ${runId} cannot be resumed: ${record.resume.reason}`);
	if (!record.sessionFile) throw new Error(`Run ${runId} cannot be resumed: its record names no session file.`);
	return record.sessionFile;
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n\n");
}

function forceSynchronousResumeIfNeeded(running: RunningSubagent, hasUI: boolean): void {
	// Same rule as a fresh launch: a print/prompt-style parent has no durable
	// turn for a later steer, so a detached resume would end the turn and
	// leave the resumed child reporting to a parent that has already exited.
	if (!shouldForceSynchronousLaunch(hasUI)) return;
	running.async = false;
	running.blocking = true;
	markSubagentBatchBlocking();
}

export function registerSubagentResumeTool(
	pi: ExtensionAPI,
	shouldRegister: (name: string) => boolean,
	runtime: ResumeToolRuntime,
): void {
	// D07: resume has its own grant. Only its deny-tools entry removes it, not a denied launch tool.
	if (!shouldRegister(SUBAGENT_RESUME_TOOL_NAME)) return;
	pi.registerTool({
		name: SUBAGENT_RESUME_TOOL_NAME,
		label: "Resume Subagent",
		description:
			"Continue an earlier child session by run id or session file, optionally with a follow-up task; a locked agent ignores model and thinking.",
		outputSchema: SubagentLaunchOutput,
		parameters: Type.Object({
			runId: Type.Optional(
				Type.String({
					description: "Run id of an earlier result.",
				}),
			),
			sessionFile: Type.Optional(
				Type.String({
					description: "Session .jsonl path; instead of runId.",
				}),
			),
			name: Type.Optional(
				Type.String({
					description: "Tab name; default Resume.",
				}),
			),
			task: Type.Optional(
				Type.String({
					description: "Follow-up task to send.",
				}),
			),
			agent: Type.Optional(
				Type.String({
					description: "Original agent of the session.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description: "provider/model[:thinking] for this resume; default: the launch model.",
				}),
			),
			thinking: Type.Optional(
				Type.String({
					description: "Thinking level for this resume; default: the launch level.",
				}),
			),
			mode: Type.Optional(
				Type.Union([Type.Literal("background"), Type.Literal("interactive")], {
					description: "Used only when the session has no launch metadata.",
				}),
			),
		}),
		renderCall(args, theme, context) {
			let name = args.name && args.name !== "Resume" ? args.name : "subagent";
			let agent = args.agent;
			if (args.sessionFile) {
				try {
					const lm = readSubagentLaunchMetadata(args.sessionFile);
					if (lm?.name) name = lm.name;
					if (lm?.agent) agent = lm.agent;
				} catch {}
			}
			const agentBadge = agent ? theme.fg("dim", ` (${agent})`) : "";
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(
				"▸ " +
					theme.fg("toolTitle", theme.bold("Resume")) +
					" " +
					theme.fg("accent", theme.bold(name)) +
					agentBadge +
					formatTaskPreview(args.task ?? "", context, theme),
			);
			return text;
		},
		renderResult(result, opts, theme, context) {
			const details = result.details as { status?: string } | undefined;
			if (details?.status === "started") return new Text("", 0, 0);
			if (isFinishedStatus(details?.status)) {
				return renderSubagentCompletionText(
					result,
					opts,
					theme,
					context.lastComponent instanceof Text ? context.lastComponent : undefined,
					true,
				);
			}
			const firstContent = result.content?.[0];
			const text = firstContent?.type === "text" ? firstContent.text : "";
			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			component.setText(theme.fg("dim", text));
			return component;
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const resultsDir = getSessionResultsDir(ctx.cwd, ctx.sessionManager.getSessionId());
			// A relative session file names a file of the parent session's project, as in Pi (D16).
			const sessionFile = resolve(ctx.cwd, resolveResumeSessionFile(params, resultsDir));
			const launchMetadata = readSubagentLaunchMetadata(sessionFile);
			const warning =
				getIgnoredModelOverrideWarning(launchMetadata?.agent, launchMetadata?.allowModelOverride, params) ?? "";

			const running = await resumeSubagentSession(
				{
					sessionFile,
					resultsDir,
					parent: { parentCwd: ctx.cwd, warnings: launchWarningLines(warning) },
					task: params.task,
					name: params.name,
					agent: params.agent,
					mode: params.mode as "interactive" | "background" | undefined,
					model: params.model,
					thinking: params.thinking,
				},
				runtime,
			);

			runtime.wireSubagentSteerBack(pi, running, running.completionPromise!);

			forceSynchronousResumeIfNeeded(running, ctx.hasUI);

			const shouldAwait = shouldAwaitSubagentLaunch(running);
			if (shouldAwait) {
				const result = await runtime.getLaunchedSubagentResult(running, signal);
				const reported = reportedRunIds([result]);
				settleWaitReply([running.id], reported, signal);
				const resultBody = textOf(result);
				// D23: the same launch facts as a launch, then the report; a published rendering holds its warnings.
				const delivery: ChildDelivery =
					reported.length > 0
						? { report: [isRenderedResult(result) ? "" : warning, resultBody].filter(Boolean).join("\n\n") }
						: { waitError: resultBody };
				return {
					...result,
					content: [{ type: "text" as const, text: renderLaunchReply([running], [delivery], []) }],
					structuredContent: asStructuredContent({
						status: "launched",
						children: [launchedChildData(running, running.agent ?? "", reported.length > 0, result.details)],
					}),
				};
			}

			requestSubagentBatchStop();
			return {
				content: [{ type: "text" as const, text: renderLaunchReply([running], [null], [warning]) }],
				details: {
					id: running.id,
					name: running.name,
					sessionFile: running.sessionFile,
					status: "started" as const,
					deliveryState: "detached" as const,
					async: running.async,
				},
				structuredContent: asStructuredContent({
					status: "launched",
					children: [launchedChildData(running, running.agent ?? "", false)],
				}),
				...getSubagentBatchStopMetadata(),
			};
		},
	});
}
