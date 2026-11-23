import { registerOutstandingWorkReporting } from "./runtime/work-reporting.ts";
import { registerContextFold } from "./runtime/context-fold.ts";
import { pendingRunEndCount, registerDeliveryQueue } from "./runtime/delivery-queue.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import type { AgentListEntry } from "./agents/agent-list.ts";
import { getAgentListEntries as getAgentListEntriesFromDefinitions } from "./agents/agent-list.ts";
import {
	applyAgentIndexSection,
	INDEX_MORE_TOOLS,
	type IndexLaunchPolicy,
	indexFallbackMessages,
	renderAgentIndexSection,
	selectIndexTargets,
} from "./agents/index-section.ts";
import type { AgentDefaults } from "./agents/definitions.ts";
import {
	formatMalformedAgentNotice,
	loadAgentCatalog,
	loadAgentDefaults as loadAgentDefaultsFromDefinitions,
} from "./agents/definitions.ts";
import {
	getSubagentAgentOverrideError,
	getSubagentAgentRequirementError,
	resolveSubagentBlocking,
} from "./launch/policy.ts";
import { resolveSubagentCwd } from "./launch/runtime-paths.ts";
import { resolveChildSessionKind } from "./launch/seed-child-session.ts";
import { initializeSpawnWidthForSession } from "./runtime/spawn-width.ts";
import { publishRunningSubagentCount } from "./runtime/nested-lifecycle.ts";
import { parseSpawnEnv } from "./spawn/policy.ts";

export { resolveSubagentConfigDir } from "./launch/runtime-paths.ts";
export { buildSkillLaunchPlan as buildSkillLaunchPlanForTest } from "./launch/skills.ts";

import { isMuxAvailable, lastMuxDetection, muxSetupHint } from "./mux.ts";
import {
	formatElapsed,
	getLaunchedSubagentResult,
	getShellReadyDelayMs,
	getWatcherSignal,
	launchBackgroundSubagent,
	launchSubagent,
	moduleAbortController,
	runningSubagents,
	shutdownSubagentsForParentExit,
	startWidgetRefresh,
	stopRunningSubagent,
	watchBackgroundSubagent,
	watchSubagent,
	widgetManager,
	wireSubagentSteerBack,
} from "./runtime/wiring.ts";
import {
	resolveEffectiveSessionMode as resolveEffectiveSessionModeFromSessionFiles,
	type SubagentSessionMode,
} from "./session/session-files.ts";
import { setResultStorageNotice } from "./runtime/result-files.ts";
import type { SubagentParamsInput } from "./types.ts";

export {
	getCompletedSubagentResultForTest,
	getLaunchedSubagentResultForTest,
	getPiInvocationForTest,
	getShellReadyDelayMs,
	getStartedSubagentDetailsForTest,
	getSubagentChildProcessEnvForTest,
	renderSubagentWidgetForTest,
	resetSubagentStateForTest,
	routeDetachedSubagentCompletionForTest,
	setRunningSubagentForTest,
	shutdownSubagentsForTest,
	waitForSubagentForTest,
} from "./runtime/wiring.ts";

import { traceSubagentLaunch } from "./launch/trace.ts";
import { classifyAssistantMessageForMixedBatch, getLaunchCallChildren } from "./runtime/batch-classifier.ts";
import {
	markSubagentBatchBlocking,
	requestSubagentBatchStop,
	resetSubagentBatchStopRequest,
	stopAfterCurrentSubagentBatch,
} from "./runtime/state.ts";
import { registerSubagentMessageRenderers } from "./tools/message-renderers.ts";
import { selectLaunchableAgents } from "./agents/launchable-agents.ts";
import { registerSubagentAgentsTool } from "./tools/agents-tool.ts";
import { registerSubagentKillTool } from "./tools/kill-tool.ts";
import { registerSubagentWaitTool } from "./tools/wait-tool.ts";
import { createManagementToolExposure } from "./tools/tool-exposure.ts";
import { registerSubagentResumeTool } from "./tools/resume-tool.ts";
import {
	markInitialPromptLaunchComplete,
	registerSubagentCoreTools,
	shouldForceSynchronousLaunch,
} from "./tools/subagent-tools.ts";
import { isToolCallable } from "./tools/policy.ts";
import { registerSubagentsView } from "./tools/subagents-view.ts";
import { SUBAGENT_TOOL_NAME } from "./tools/tool-names.ts";
import { adoptVerifiedRuns } from "./vf/run/adopt.ts";

export { classifyAssistantMessageForMixedBatch as classifyAssistantMessageForMixedBatchForTest } from "./runtime/batch-classifier.ts";
export { shouldAwaitSubagentLaunch as shouldAwaitSubagentLaunchForTest } from "./runtime/running-registry.ts";
export {
	getSubagentBatchStopMetadata as getSubagentBatchStopMetadataForTest,
	markSubagentBatchBlocking as markSubagentBatchBlockingForTest,
	requestSubagentBatchStop as requestSubagentBatchStopForTest,
} from "./runtime/state.ts";
export * from "./testing/test-helpers.ts";

export function loadAgentDefaults(
	agentName: string,
	cwdHint?: string | null,
	baseCwd = process.cwd(),
): AgentDefaults | null {
	return loadAgentDefaultsFromDefinitions(agentName, cwdHint, baseCwd, resolveSubagentCwd);
}

/**
 * Agent defaults for a hook that only classifies a call. A malformed agent is
 * not launchable here, so one bad target cannot stop the classification of its
 * siblings; the launch itself reports the parse error (D24).
 */
/** The definition the launch tool resolves: from the session cwd, as the executor does. */
function loadLaunchableAgentDefaults(agentName: string, sessionCwd: string): AgentDefaults | null {
	try {
		return loadAgentDefaults(agentName, undefined, sessionCwd);
	} catch {
		return null;
	}
}

/** How a solo launch from this session runs; the index flags and the agent detail both follow it. */
function getSoloLaunchPolicy(hasUI: boolean): IndexLaunchPolicy {
	return { paneAvailable: hasUI && isMuxAvailable(), forcesWait: shouldForceSynchronousLaunch(hasUI) };
}

function getAgentListEntries(baseCwd = process.cwd()): AgentListEntry[] {
	const callerEnv = parseSpawnEnv(process.env);
	return getAgentListEntriesFromDefinitions(baseCwd, resolveChildSessionKind, {
		callerAgent: callerEnv.callerAgent,
		callerSpawnable: callerEnv.callerSpawnable,
	});
}

function resolveEffectiveSessionMode(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
): SubagentSessionMode {
	return resolveEffectiveSessionModeFromSessionFiles(params, agentDefs);
}


// Pi reloads extension modules without a cache, so module state does not
// survive /reload. The session that saw the malformed-agent notice is kept on
// globalThis, so a reload of that session shows no second notice (D24).
const MALFORMED_AGENT_NOTICE_SESSION_KEY = Symbol.for("pi-subagents/malformed-agent-notice-session");

function muxUnavailableResult(kind: "subagents" | "tab-title" = "subagents") {
	const text =
		kind === "tab-title"
			? `Terminal multiplexer not available. ${muxSetupHint()}`
			: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`;
	return {
		content: [{ type: "text" as const, text }],
		details: { error: "mux not available" },
	};
}

export default function subagentsExtension(pi: ExtensionAPI) {
	// Register nothing when the user has no named agents. The factory re-runs
	// on every session replacement (/new, /resume, /fork) and on /reload, so
	// creating an agent file and starting a session restores the full surface.
	// A malformed file still registers the surface, so its launch is refused
	// with the parse error instead of an unknown-agent answer (D24).
	const startupCatalog = loadAgentCatalog();
	if (startupCatalog.definitions.length === 0 && startupCatalog.malformedFiles.length === 0) return;

	// A run end that waits in the delivery queue keeps an auto-exit session open like a running
	// child: Pi's own queue does not hold it while a turn runs, so hasPendingMessages() misses it.
	publishRunningSubagentCount(() => runningSubagents.size + pendingRunEndCount());
	const workReporting = registerOutstandingWorkReporting(pi);
	registerDeliveryQueue(pi);
	registerContextFold(pi);

	function attachWidgetContext(ctx: ExtensionContext) {
		widgetManager.attachContext(ctx);
	}

	function applySubagentLineage(ctx: ExtensionContext) {
		const parentSession = process.env.PI_SUBAGENT_PARENT_SESSION?.trim();
		if (!parentSession) return;
		const header = ctx.sessionManager.getHeader?.();
		if (!header || header.parentSession) return;
		header.parentSession = parentSession;
	}

	let latestContext: ExtensionContext | undefined;

	const managementToolExposure = createManagementToolExposure(pi);

	// Capture the UI context early so the widget keeps a stable slot above tasks.
	pi.on("session_start", (_event, ctx) => {
		initializeSpawnWidthForSession();
		void workReporting.start(ctx);
		latestContext = ctx;
		resetSubagentBatchStopRequest();
		applySubagentLineage(ctx);
		attachWidgetContext(ctx);
		// D13: a results-folder failure tells the person once, outside any tool result.
		setResultStorageNotice((message) => ctx.ui.notify(message, "warning"));
		// One notice per session (D24). In print mode the notice is not shown:
		// Pi has no print-mode notice channel and its fallback notify is a no-op.
		// The launch refusal still names the file and its error. Revisit if Pi
		// adds a print-mode notice channel.
		const malformedNotice = formatMalformedAgentNotice(loadAgentCatalog(ctx.cwd));
		const noticeSession = ctx.sessionManager.getSessionId?.() ?? "";
		const globalState = globalThis as Record<PropertyKey, unknown>;
		if (malformedNotice && globalState[MALFORMED_AGENT_NOTICE_SESSION_KEY] !== noticeSession) {
			globalState[MALFORMED_AGENT_NOTICE_SESSION_KEY] = noticeSession;
			ctx.ui.notify(malformedNotice, "warning");
		}
		// Verified fan-outs outlive their parent session: deliver finished
		// results exactly once to their authorized recipient and re-watch live
		// runs (detached supervisors keep candidates running across
		// quit/reload/replacement).
		const sessionFile = ctx.sessionManager.getSessionFile?.() ?? "";
		adoptVerifiedRuns(pi, ctx.cwd, {
			sessionId: ctx.sessionManager.getSessionId?.() ?? "",
			// In print mode a startup steer must not trigger a model turn: the
			// `-p` process has its own single prompt to run, and triggering a
			// second turn at session start crashes some extensions' stale
			// captured contexts.
			triggerTurn: ctx.mode !== "print",
			confirmPersisted: sessionFile
				? async (deliveryId) => {
						// The send is async in Pi; poll our own transcript until the
						// deliveryId entry lands, then the receipt may be written.
						const deadline = Date.now() + 5_000;
						while (Date.now() < deadline) {
							try {
								if (readFileSync(sessionFile, "utf8").includes(deliveryId)) return true;
							} catch {
								// not flushed yet
							}
							await new Promise((resolve) => setTimeout(resolve, 150));
						}
						return false;
					}
				: undefined,
			updateWidget: () => widgetManager.update(),
		}).catch(() => {
			// Adoption is best-effort at startup; a failure must never block
			// the session from starting.
		});
	});

	// The index is written at every prompt start from the current files, so a
	// changed agent file shows in the next request. Pi keeps the section with
	// the session and patches it only when its text changed (D19).
	// The section of the current prompt, for the fallback when another
	// extension's whole prompt replaces the sections.
	let indexSection: string | undefined;
	pi.on("before_agent_start", (event, ctx) => {
		managementToolExposure.finalize(ctx.sessionManager.getBranch());
		indexSection = undefined;
		if (!mayLaunch()) return undefined;
		const spawnEnv = parseSpawnEnv(process.env);
		// No multiplexer probe here: a prompt start without a launch stays as cheap
		// as in v2.9.2. The pane flags use the detection of an earlier launch (D06).
		indexSection = renderAgentIndexSection(
			selectIndexTargets(getAgentListEntries(ctx.cwd), spawnEnv),
			{ paneAvailable: ctx.hasUI && lastMuxDetection(), forcesWait: shouldForceSynchronousLaunch(ctx.hasUI) },
			// Pi's live tool surface after the exposure step: excluded, inactive and hidden tools are not named.
			{ callable: new Set(INDEX_MORE_TOOLS.filter((name) => isToolCallable(pi, name))) },
		);
		if (!indexSection) return undefined;
		return applyAgentIndexSection(event, indexSection, spawnEnv.callerAgent !== null);
	});

	pi.on("context", (event, ctx) => {
		if (!indexSection) return undefined;
		const messages = indexFallbackMessages(event.messages, ctx.getSystemPrompt(), indexSection);
		return messages ? { messages: messages as typeof event.messages } : undefined;
	});

	pi.on("input", () => {
		resetSubagentBatchStopRequest();
		return { action: "continue" as const };
	});

	pi.on("message_end", (event, ctx) => {
		// Mixed-batch barrier: when an assistant message contains BOTH an async
		// subagent launch (subagent or subagent_resume) AND a non-subagent tool,
		// mark the batch blocking before any tool runs. The shared
		// shouldAwaitSubagentLaunch predicate then routes both subagent and
		// subagent_resume launches through the await path so the parent's
		// next turn sees completed results instead of racing the children.
		// Gated by PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN to share a kill
		// switch with the existing coordinator-only-turn behavior.
		const message = event?.message;
		if (!message) return;
		classifyAssistantMessageForMixedBatch(message, (agent) =>
			agent ? loadLaunchableAgentDefaults(agent, ctx.cwd) : null,
		);
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== SUBAGENT_TOOL_NAME) return {};
		// Classify every child of this call before any launch of the message runs:
		// a blocking child here makes async children in sibling calls wait too.
		const blocking = getLaunchCallChildren(event.input).map((child) => {
			const input = child as Partial<SubagentParamsInput>;
			const agentDefs = typeof input.agent === "string" ? loadLaunchableAgentDefaults(input.agent, ctx.cwd) : null;
			if (!agentDefs) return null;
			if (getSubagentAgentRequirementError(input, agentDefs) || getSubagentAgentOverrideError(input, agentDefs)) {
				return null;
			}
			return resolveSubagentBlocking(input, agentDefs);
		});
		// The tool refuses the whole call when one child is invalid, so such a call launches nothing.
		if (blocking.length === 0 || blocking.includes(null)) return {};
		if (blocking.includes(true)) markSubagentBatchBlocking();
		else requestSubagentBatchStop();
		return {};
	});

	pi.on("turn_start", () => {
		resetSubagentBatchStopRequest();
	});

	pi.on("agent_end", () => {
		resetSubagentBatchStopRequest();
		markInitialPromptLaunchComplete();
	});

	// Clean up on real session shutdown. Pi also emits this event for the
	// coordinator-only turn stop after async launches; that must not kill the
	// children that the stop was created to leave running.
	pi.on("session_shutdown", async (event, ctx) => {
		traceSubagentLaunch("session.shutdown", {
			coordinatorOnlyTurnStop: stopAfterCurrentSubagentBatch,
			eventKeys: Object.keys((event ?? {}) as unknown as Record<string, unknown>),
			running: runningSubagents.size,
		});
		if (stopAfterCurrentSubagentBatch && !event.reason) {
			resetSubagentBatchStopRequest();
			return;
		}
		await workReporting.stop();

		moduleAbortController.abort();
		widgetManager.reset();
		resetSubagentBatchStopRequest();
		await shutdownSubagentsForParentExit();
		if (ctx.hasUI) {
			ctx.ui.setWidget("subagent-status", undefined);
		}
	});

	// Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
	const deniedTools = new Set(
		(process.env.PI_DENY_TOOLS ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);

	const shouldRegister = (name: string) => !deniedTools.has(name);
	// The index and subagent_agents describe only what this session may launch.
	const mayLaunch = () => shouldRegister(SUBAGENT_TOOL_NAME) && isToolCallable(pi, SUBAGENT_TOOL_NAME);

	registerSubagentCoreTools(pi, shouldRegister, {
		listLaunchableAgents: (cwd) =>
			selectLaunchableAgents(loadAgentCatalog(cwd), resolveChildSessionKind, parseSpawnEnv(process.env)),
		loadAgentDefaults: (agentName, cwd) => (agentName ? loadAgentDefaults(agentName, undefined, cwd) : null),
		resolveEffectiveSessionMode,
		resolveTaskSessionMode: resolveChildSessionKind,
		launchBackgroundSubagent,
		launchSubagent,
		watchBackgroundSubagent,
		watchSubagent,
		getWatcherSignal,
		wireSubagentSteerBack,
		startWidgetRefresh,
		getLaunchedSubagentResult,
		muxUnavailableResult: () => muxUnavailableResult("tab-title"),
	});

	// D21: the management tools register direct now; the first before_agent_start
	// defers them when codemode or tool search is active.
	const grant = { mayLaunch };
	const managementTools = managementToolExposure.recordingApi;
	registerSubagentKillTool(managementTools, shouldRegister, stopRunningSubagent);
	registerSubagentWaitTool(managementTools, shouldRegister, grant);
	registerSubagentResumeTool(
		managementTools,
		shouldRegister,
		{
			getShellReadyDelayMs,
			isMuxAvailable,
			watchBackgroundSubagent,
			watchSubagent,
			getWatcherSignal,
			wireSubagentSteerBack,
			startWidgetRefresh,
			getLaunchedSubagentResult,
			runningSubagents,
			getContextWindow: (modelRef) => widgetManager.resolveModelContextWindow(modelRef),
			modelRegistry: {
				getAvailable: () => latestContext?.modelRegistry.getAvailable() ?? [],
			},
		},
	);

	registerSubagentAgentsTool(
		managementTools,
		shouldRegister,
		{
			spawnEnv: () => parseSpawnEnv(process.env),
			listLaunchableAgents: (cwd, spawnEnv) =>
				selectLaunchableAgents(loadAgentCatalog(cwd), resolveChildSessionKind, spawnEnv),
			launchPolicy: getSoloLaunchPolicy,
		},
		grant,
	);

	registerSubagentMessageRenderers(pi, formatElapsed);

	registerSubagentsView(
		pi,
		{
			getShellReadyDelayMs,
			isMuxAvailable,
			watchBackgroundSubagent,
			watchSubagent,
			getWatcherSignal,
			startWidgetRefresh,
			getContextWindow: (modelRef: string) => widgetManager.resolveModelContextWindow(modelRef),
			runningSubagents,
			pi,
			wireSubagentSteerBack,
		},
	);
}
