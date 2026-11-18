import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getSessionResultsDir } from "../artifact-storage.ts";
import { endedUnderContextPressure } from "../session/completion-reason.ts";
import { readSubagentTimeoutSidecar } from "../session/timeout-sidecar.ts";
import { isRenderedResult, launchWarningLines } from "../runtime/run-result.ts";
import { type ResumeServiceRuntime, resumeSubagentSession } from "../runtime/resume-service.ts";
import { shouldAwaitSubagentLaunch } from "../runtime/running-registry.ts";
import { getSubagentBatchStopMetadata, markSubagentBatchBlocking, requestSubagentBatchStop } from "../runtime/state.ts";
import { readSubagentLaunchMetadata } from "../session/session-files.ts";
import type { RunningSubagent, SubagentResult } from "../types.ts";
import { formatTaskPreview, renderSubagentCompletionText } from "./message-renderers.ts";
import { getIgnoredModelOverrideWarning } from "./policy.ts";
import { shouldForceSynchronousLaunch } from "./subagent-tools.ts";
import { SUBAGENT_RESUME_TOOL_NAME } from "./tool-names.ts";
import { formatLaunchGrantRefusal, type ManagementToolGrant } from "./tool-exposure.ts";

export interface ResumeToolRuntime extends ResumeServiceRuntime {
	wireSubagentSteerBack(pi: ExtensionAPI, running: RunningSubagent, promise: Promise<SubagentResult>): void;
	getLaunchedSubagentResult(running: RunningSubagent, signal?: AbortSignal): Promise<AgentToolResult<unknown>>;
}

function assertResumeAllowed(sessionFile: string): void {
	// The child ended on instruction from its context-warning policy, so its
	// window is spent. Resuming buys no room and only repeats the wrap-up.
	// Operators can still resume it deliberately from the /subagents overlay.
	if (endedUnderContextPressure(sessionFile)) {
		throw new Error(
			"This sub-agent stopped early as instructed by its context-warning policy, and its context window is spent. " +
				"Resuming gives it no room to work. Launch a fresh sub-agent with the remaining work instead.",
		);
	}

	// A budget kill is recoverable by default — a resume re-arms the same
	// budget, so it cannot run away again. Only an agent that opted into
	// `on-timeout: block-resume` refuses, because a second partial run of a
	// non-idempotent child is not safe to attempt.
	const timedOut = readSubagentTimeoutSidecar(sessionFile);
	if (!timedOut?.blocksResume) return;
	const limitDescription = timedOut.kind === "idle-timeout" ? "limit for time without output" : "time limit";
	throw new Error(
		`The system stopped this sub-agent because it went past its ${limitDescription}. ` +
			"Its agent file does not allow a resume after that. Start a new sub-agent with a smaller task instead.",
	);
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
	grant: ManagementToolGrant,
): void {
	if (!shouldRegister(SUBAGENT_RESUME_TOOL_NAME)) return;
	pi.registerTool({
		name: SUBAGENT_RESUME_TOOL_NAME,
		label: "Resume Subagent",
		description: "Continue an earlier child session from its session file, optionally with a follow-up task.",
		exposure: grant.exposure,
		parameters: Type.Object({
			sessionFile: Type.String({
				description: "Path to the session .jsonl file to resume",
			}),
			name: Type.Optional(
				Type.String({
					description: "Display name for the terminal tab. Default: 'Resume'",
				}),
			),
			task: Type.Optional(
				Type.String({
					description: "Optional follow-up task to send after resuming",
				}),
			),
			agent: Type.Optional(
				Type.String({
					description: "Agent name for display. Use the original agent name from the session being resumed.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Model for this resume as provider/model[:thinking]; unset keeps the launch model, and allow-model-override: false ignores it.",
				}),
			),
			thinking: Type.Optional(
				Type.String({
					description:
						"Thinking level for this resume; unset keeps the launch level, and allow-model-override: false ignores it.",
				}),
			),
			mode: Type.Optional(
				Type.Union([Type.Literal("background"), Type.Literal("interactive")], {
					description:
						"Fallback resume mode used only when launch metadata cannot be inferred. Persisted metadata always wins when present; an explicit mode here cannot override it.",
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
			if (details?.status === "completed" || details?.status === "failed" || details?.status === "cancelled") {
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
			if (!grant.mayLaunch()) throw new Error(formatLaunchGrantRefusal(SUBAGENT_RESUME_TOOL_NAME));
			const sessionFile = params.sessionFile;
			if (!sessionFile) throw new Error("Session file is required.");
			assertResumeAllowed(sessionFile);
			const launchMetadata = readSubagentLaunchMetadata(sessionFile);
			const warning =
				getIgnoredModelOverrideWarning(launchMetadata?.agent, launchMetadata?.allowModelOverride, params) ?? "";

			const running = await resumeSubagentSession(
				{
					sessionFile,
					resultsDir: getSessionResultsDir(ctx.cwd, ctx.sessionManager.getSessionId()),
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
				if (!warning || isRenderedResult(result)) return result;
				return {
					...result,
					content: [{ type: "text" as const, text: warning }, ...result.content],
				};
			}

			requestSubagentBatchStop();
			return {
				content: [
					{
						type: "text" as const,
						text: warning ? `${warning}\n\nSession "${running.name}" resumed.` : `Session "${running.name}" resumed.`,
					},
				],
				details: {
					id: running.id,
					name: running.name,
					sessionFile: running.sessionFile,
					status: "started" as const,
					deliveryState: "detached" as const,
					async: running.async,
				},
				...getSubagentBatchStopMetadata(),
			};
		},
	});
}
