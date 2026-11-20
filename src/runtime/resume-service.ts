import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentDefaults as loadAgentDefaultsFromDefinitions } from "../agents/definitions.ts";
import { assertModelAllowed } from "../agents/model-refs.ts";
import { getArtifactStorageRoot } from "../artifact-storage.ts";
import { buildAppendSystemInheritancePlan } from "../launch/append-system.ts";
import {
	type AgentModelConfig,
	resolveCallModelRef,
	resolveImplicitModelGrant,
	splitModelRefThinking,
} from "../launch/child-launch-plan.ts";
import { CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT } from "../launch/context-boundary.ts";
import { parseEnvString } from "../launch/env.ts";
import { type LaunchUndo, withLaunchUndo } from "../launch/launch-undo.ts";
import { resolveSubagentTimeoutState } from "../launch/policy.ts";
import {
	getExtensionLaunchArgs,
	getPersistedPromptLaunchArgs,
	getPersistedSessionParityArgs,
	normalizeModelRef,
	resolveAvailableModelRef,
} from "../launch/prep.ts";
import { getResumeCwd, resolveResumeLaunchMetadata } from "../launch/resume.ts";
import { resolveSubagentCwd } from "../launch/runtime-paths.ts";
import { getSkillVisibilitySpec, PI_SUBAGENT_SKILL_VISIBILITY } from "../launch/skill-visibility.ts";
import { expandSubagentTask } from "../launch/task-expansion.ts";
import { muxSetupHint } from "../mux.ts";
import { getEntryCount, readSessionHeaderCwd } from "../session/session.ts";
import {
	isResumeMode,
	type PersistedSubagentLaunchMetadata,
	readSubagentExtensionEntry,
	readSubagentLaunchMetadataEntries,
	writeSubagentLaunchMetadataEntry,
	writeSubagentModelStateEntries,
} from "../session/session-files.ts";
import { readSubagentTimeoutSidecar } from "../session/timeout-sidecar.ts";
import { buildResumeSpawnEnv, narrowSpawnBudget, parseSpawnEnv, resolveSpawnPolicy } from "../spawn/policy.ts";
import { PI_SUBAGENT_CONTEXT_WARN_STEP, PI_SUBAGENT_CONTEXT_WARN_THRESHOLD } from "../tools/context-reminders.ts";
import { DATA_SCHEMA_ENV } from "../tools/data-schema.ts";
import {
	PI_SUBAGENT_IDLE_TIMEOUT,
	PI_SUBAGENT_TIMEOUT,
	PI_SUBAGENT_TIMEOUT_STARTED_AT,
	PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD,
} from "../tools/timeout-reminders.ts";
import type { ResultParent, RunningSubagent, SubagentResult } from "../types.ts";
import { sessionResultStore } from "./result-files.ts";
import { assertResumeAllowed, reserveResumeSession, settleVerdictAfterRun } from "./resume-guards.ts";
import { setAsidePreviousExitRecord, startResumedChild } from "./resume-start.ts";
import {
	claimSpawnWidthSlot,
	getLiveSlotCount,
	getSpawnWidthLimit,
	releaseSpawnWidthSlot,
	releaseSpawnWidthSlotOnCompletion,
	tryAcquireSlots,
} from "./spawn-width.ts";

export interface ResumeServiceRuntime {
	getShellReadyDelayMs(): number;
	isMuxAvailable(): boolean;
	watchBackgroundSubagent(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult>;
	watchSubagent(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult>;
	getWatcherSignal(running: RunningSubagent, controller: AbortController): AbortSignal;
	startWidgetRefresh(): void;
	getContextWindow(modelRef: string | undefined): number | undefined;
	runningSubagents: Map<string, RunningSubagent>;
	modelRegistry?: {
		getAvailable(): Array<{
			provider: string;
			id: string;
			reasoning?: boolean;
			thinkingLevelMap?: Record<string, string | null | undefined>;
		}>;
	};
}

interface ResumeSessionInput {
	sessionFile: string;
	/** The parent session's results folder; the resume reserves its run id there (D13). */
	resultsDir: string;
	parent: ResultParent; // The receiving parent's cwd and the warnings its rendered result repeats (D14).
	task?: string;
	name?: string;
	agent?: string;
	mode?: "interactive" | "background";
	model?: string;
	thinking?: string;
	/** D8: the overlay operator's explicit override of the resume guards, for this attempt only. */
	operatorOverride?: boolean;
}

export function resolveResumeLaunchMetadataForInvocation(
	launchMetadata: PersistedSubagentLaunchMetadata | undefined,
	requestedModel: string | undefined,
	requestedThinking?: string,
	modelRegistry?: ResumeServiceRuntime["modelRegistry"],
): PersistedSubagentLaunchMetadata | undefined {
	if (!launchMetadata || (!requestedModel && !requestedThinking)) return launchMetadata;
	if (launchMetadata.allowModelOverride === false) {
		return {
			...launchMetadata,
			...(requestedModel ? { ignoredModelOverride: requestedModel } : {}),
			...(requestedThinking ? { ignoredThinkingOverride: requestedThinking } : {}),
		};
	}
	const baseModel =
		requestedModel ?? launchMetadata.invocationModelRef ?? launchMetadata.modelRef ?? launchMetadata.model;
	if (!baseModel) {
		throw new Error("Cannot apply thinking override without a persisted model.");
	}
	const config: AgentModelConfig = {
		definitionModel: launchMetadata.definitionModel,
		definitionThinking: launchMetadata.definitionThinking,
		allowedModels: launchMetadata.allowedModels,
		agentName: launchMetadata.agent,
	};
	const inheritedModelRef =
		!launchMetadata.definitionModel && launchMetadata.modelSource === "parent" ? launchMetadata.modelRef : undefined;
	const grantThinking = launchMetadata.definitionThinking ?? launchMetadata.thinking;
	// D08, D22: a resume with a model takes the launch path; as in v2.9.2 the prior run's level
	// is the fallback and its provider breaks a bare-id tie. A thinking-only resume keeps the
	// persisted invocation model as an exact ref.
	const { effectiveModel, effectiveThinking, effectiveModelRef } = requestedModel
		? resolveCallModelRef({
				model: requestedModel,
				thinking: requestedThinking,
				config,
				inheritedModelRef,
				fallbackThinking: launchMetadata.thinking,
				grantThinking,
				tieBreakRef: launchMetadata.modelRef,
				modelRegistry,
			})
		: resolveThinkingOnlyResume(baseModel, requestedThinking, config, inheritedModelRef, grantThinking, {
				modelRegistry,
				tieBreakRef: launchMetadata.modelRef,
			});
	return {
		...launchMetadata,
		timestamp: new Date().toISOString(),
		model: effectiveModel,
		thinking: effectiveThinking,
		modelRef: effectiveModelRef,
		// The resolved ref is also what this resume passes to Pi, so a later resume or wrap-up replays it.
		invocationModelRef: effectiveModelRef,
		modelSource: "resume-override",
		...(requestedModel ? { requestedModelOverride: requestedModel } : {}),
		...(requestedThinking ? { requestedThinkingOverride: requestedThinking } : {}),
	};
}

function resolveThinkingOnlyResume(
	baseModel: string,
	requestedThinking: string | undefined,
	config: AgentModelConfig,
	inheritedModelRef: string | undefined,
	fallbackThinking: string | undefined,
	registry: { modelRegistry: ResumeServiceRuntime["modelRegistry"]; tieBreakRef: string | undefined },
): ReturnType<typeof normalizeModelRef> {
	const { modelRegistry } = registry;
	const requested = splitModelRefThinking(baseModel, requestedThinking);
	const explicitThinking = requested.explicitThinking || requestedThinking != null;
	const resolved = resolveAvailableModelRef(
		requested.model,
		requested.thinking,
		explicitThinking,
		modelRegistry,
		registry.tieBreakRef,
	);
	const normalized = normalizeModelRef(resolved.model, resolved.thinking);
	const implicitRef = resolveImplicitModelGrant(config, modelRegistry, inheritedModelRef, fallbackThinking);
	assertModelAllowed(
		normalized.effectiveModelRef,
		config.allowedModels,
		config.agentName,
		implicitRef ? [implicitRef] : [],
	);
	return normalized;
}

function mergeResumeInvocationMetadata(
	launchMetadata: PersistedSubagentLaunchMetadata,
	laterMetadata: PersistedSubagentLaunchMetadata,
): PersistedSubagentLaunchMetadata {
	return {
		...launchMetadata,
		...laterMetadata,
		// A child can append metadata to its own session. Keep grant authority
		// anchored to the first launch entry while allowing later entries to
		// carry legitimate invocation changes such as model and thinking.
		// The invocation ref pairs with the model ref of the same entry; an entry without one replays its model ref.
		invocationModelRef:
			laterMetadata.modelRef !== undefined ? laterMetadata.invocationModelRef : launchMetadata.invocationModelRef,
		spawnBudget: launchMetadata.spawnBudget,
		spawnableAgents: launchMetadata.spawnableAgents,
		denyTools: launchMetadata.denyTools,
		// One deny-env for every process generation of the run: the resume and its wrap-up replacement.
		denyEnv: launchMetadata.denyEnv,
	};
}

/**
 * Shared resume logic used by both the LLM subagent_resume tool and the
 * /subagents TUI overlay. Handles validation, deduplication, environment
 * setup, process/pane spawning, and runtime registration.
 *
 * Callers must:
 * 1. Call wireSubagentSteerBack(pi, running, running.completionPromise!)
 * 2. Handle the result (await or return to user) as appropriate
 */
export async function resumeSubagentSession(
	requested: ResumeSessionInput,
	runtime: ResumeServiceRuntime,
): Promise<RunningSubagent> {
	// D16: a relative session file is resolved here, once, against the parent session's project (not
	// the directory this process started in), so the record, the launch note and the child name the
	// same file after a restart from another directory.
	const input = { ...requested, sessionFile: resolve(requested.parent.parentCwd, requested.sessionFile) };
	// Verified fan-out candidates are non-resumable (SPEC): their run is
	// finalized and their worktree workspace is deleted after selection, so a
	// resume would resurrect a session whose cwd no longer exists. Follow-up
	// work starts a fresh launch against the updated source tree.
	const verifiedRunDir = process.env.PI_SUBAGENT_VF_RUN_DIR;
	if (verifiedRunDir && verifiedRunDir.trim()) {
		throw new Error(
			`Session ${input.sessionFile} was one finished attempt of an llm-as-a-verifier run; ` +
				"its worktree was removed after selection, so it cannot be resumed. " +
				"Start a new launch of the agent for follow-up work.",
		);
	}
	// D8: the guards and the session reservation run before any asynchronous step.
	if (input.operatorOverride !== true) assertResumeAllowed(input.sessionFile);
	const releaseSession = reserveResumeSession(input.sessionFile, runtime.runningSubagents.values());
	const widthLimit = getSpawnWidthLimit();
	const slot = tryAcquireSlots(1, widthLimit);
	if (!slot) {
		releaseSession();
		throw new Error(
			`Spawn width limit reached (${getLiveSlotCount()}/${widthLimit} slots busy). Wait for a running subagent to finish, or use subagent_kill to free a slot. Interactive children with auto-exit: false keep their slot until the pane closes.`,
		);
	}

	let claimedRunning: RunningSubagent | undefined;
	try {
		const running = await withLaunchUndo((undo) => resumeSubagentSessionWithoutWidth(input, runtime, undo));
		claimSpawnWidthSlot(running, slot);
		claimedRunning = running;
		if (running.completionPromise) {
			const settled = running.completionPromise
				.then((result) => {
					settleVerdictAfterRun(input.sessionFile, result);
					return result;
				})
				.finally(releaseSession);
			running.completionPromise = releaseSpawnWidthSlotOnCompletion(running, settled);
		} else {
			releaseSession();
		}
		return running;
	} catch (error) {
		releaseSession();
		if (claimedRunning) releaseSpawnWidthSlot(claimedRunning);
		slot.release();
		throw error;
	}
}

/**
 * The agent's deny-env for a resume. Launch metadata holds it from before the first spawn, standalone
 * sessions included. A session without launch metadata (a standalone session launched before that) fails
 * closed: the named agent's current definition gives the policy, and with no agent named or no definition
 * found the resume is refused, because a variable denied only by the agent would reach the resumed child.
 */
function resolveResumeDenyEnv(
	launchMetadata: PersistedSubagentLaunchMetadata | undefined,
	agent: string | undefined,
	definition: { denyEnv?: string } | null,
): string | undefined {
	if (launchMetadata) return launchMetadata.denyEnv;
	if (agent && definition) return definition.denyEnv;
	throw new Error(
		agent
			? `Cannot resume: the session has no launch metadata, so its deny-env is unknown, and agent "${agent}" has no definition to take it from.`
			: "Cannot resume: the session has no launch metadata, so its deny-env is unknown. Pass the agent the session was launched with.",
	);
}

async function resumeSubagentSessionWithoutWidth(
	input: ResumeSessionInput,
	runtime: ResumeServiceRuntime,
	// The resumed session file is never registered: a failed resume keeps it unchanged (D6).
	undo: LaunchUndo,
): Promise<RunningSubagent> {
	const { sessionFile, task } = input;

	if (!existsSync(sessionFile)) {
		throw new Error(`Session file not found: ${sessionFile}`);
	}

	const explicitMode = isResumeMode(input.mode) ? input.mode : undefined;
	const metadata = resolveResumeLaunchMetadata(sessionFile, explicitMode);
	const launchMetadataEntries = readSubagentLaunchMetadataEntries(sessionFile);
	const launchMetadata = launchMetadataEntries[0];
	const latestLaunchMetadata = launchMetadataEntries[launchMetadataEntries.length - 1];
	const invocationMetadataSource =
		launchMetadata && latestLaunchMetadata && latestLaunchMetadata !== launchMetadata
			? mergeResumeInvocationMetadata(launchMetadata, latestLaunchMetadata)
			: launchMetadata;
	const invocationMetadata = resolveResumeLaunchMetadataForInvocation(
		invocationMetadataSource,
		input.model,
		input.thinking,
		runtime.modelRegistry,
	);
	const resumedAutoExit =
		metadata.mode === "background" ? true : (invocationMetadata?.autoExit ?? metadata.autoExit ?? true);
	// Without launch metadata the session header names the project, as Pi uses it on resume; the agent
	// catalog of another directory could shadow the project's agent and its deny-env.
	const targetCwd =
		launchMetadata?.cwd ?? invocationMetadataSource?.cwd ?? readSessionHeaderCwd(sessionFile) ?? input.parent.parentCwd;
	// A resume passes its saved list to Pi as saved, unresolved entries included (D10).
	const savedExtensions = invocationMetadata ? invocationMetadata.extensions : readSubagentExtensionEntry(sessionFile);
	const resumedInvocationMetadata =
		metadata.mode === "background" && invocationMetadata
			? { ...invocationMetadata, autoExit: resumedAutoExit }
			: invocationMetadata;
	const shouldPersistInvocationMetadata = invocationMetadata && invocationMetadata !== invocationMetadataSource;
	const targetAgent = launchMetadata?.agent ?? metadata.agent ?? input.agent;
	const targetDefs = targetAgent
		? loadAgentDefaultsFromDefinitions(targetAgent, undefined, targetCwd, resolveSubagentCwd)
		: null;
	const denyEnv = resolveResumeDenyEnv(launchMetadata, targetAgent, targetDefs);
	const callerEnv = parseSpawnEnv(process.env);
	const targetSpawning = launchMetadata?.spawnableAgents === true ? true : (launchMetadata?.spawnableAgents ?? false);
	const spawnPolicy = resolveSpawnPolicy({
		callerAgent: callerEnv.callerAgent,
		targetAgent: targetAgent ?? "",
		callerBudget: callerEnv.callerBudget,
		callerSpawnable: callerEnv.callerSpawnable,
		targetSpawning,
		targetSpawnDepth: launchMetadata?.spawnBudget ?? 0,
		targetSpawnWidth: targetDefs?.spawnWidth,
		targetVisibleTo: targetDefs?.visibleTo ?? ["all"],
		envDepthCeiling: callerEnv.envDepthCeiling,
		envWidthCeiling: callerEnv.envWidthCeiling,
	});
	if (!spawnPolicy.allowed) {
		throw new Error(`Error: ${spawnPolicy.reason ?? "Spawn policy denied this target."}`);
	}
	const narrowedSpawnBudget = narrowSpawnBudget(launchMetadata, callerEnv.callerBudget, callerEnv.envDepthCeiling);
	const resumeSpawnEnv = buildResumeSpawnEnv(launchMetadata, narrowedSpawnBudget, spawnPolicy.effectiveWidth);
	const name = invocationMetadata?.name ?? metadata.name ?? input.name ?? "Resume";
	const displayName = input.name ?? name;

	if (metadata.mode === "interactive" && !runtime.isMuxAvailable()) {
		throw new Error(`Subagents require a supported terminal multiplexer. ${muxSetupHint()}`);
	}

	const entryCountBefore = getEntryCount(sessionFile);
	// The previous verdict carries the budgets the killed run was under, which is the only
	// record for a session mode that never persisted launch metadata. It stays in force until
	// the resumed run ends (D8); only the previous exit record moves aside here.
	const previousTimeout = readSubagentTimeoutSidecar(sessionFile);
	const discardPreviousExitRecord = setAsidePreviousExitRecord(sessionFile, undo);
	const subagentDonePath = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "subagent-done.ts");
	const extensionArgs =
		invocationMetadata !== undefined || savedExtensions !== undefined
			? getExtensionLaunchArgs(savedExtensions, subagentDonePath, narrowedSpawnBudget > 0)
			: ["--no-extensions", "-e", subagentDonePath];
	const parityArgs = [
		...getPersistedPromptLaunchArgs(invocationMetadata),
		...(await getPersistedSessionParityArgs(invocationMetadata, metadata.mode, narrowedSpawnBudget > 0)),
		...(invocationMetadata ? [] : ["--no-approve"]),
	];
	const resumeCwd = getResumeCwd(invocationMetadata);
	const expandedTask = task
		? await expandSubagentTask(task, {
				enabled: invocationMetadata?.taskExpansion === "shell",
				cwd: resumeCwd ?? process.cwd(),
			})
		: undefined;

	const resumedAgent = invocationMetadata?.agent ?? metadata.agent ?? input.agent;

	const resumeEnvVars: Record<string, string> = {};
	// Restore user-configured env vars from the original launch FIRST,
	// so internal PI vars below can override them if needed.
	if (invocationMetadata?.env) {
		const configuredEnv = parseEnvString(invocationMetadata.env);
		// Strip internal spawn-grant vars from the persisted frontmatter env so a
		// forged or stale value cannot override the narrowed grant written below.
		for (const key of [
			"PI_SUBAGENT_SPAWN_DEPTH",
			"PI_SUBAGENT_SPAWN_WIDTH",
			"PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE",
			"PI_SUBAGENT_SPAWN_BUDGET",
			"PI_SUBAGENT_SPAWNABLE",
		]) {
			delete configuredEnv[key];
		}
		Object.assign(resumeEnvVars, configuredEnv);
	}
	Object.assign(
		resumeEnvVars,
		buildAppendSystemInheritancePlan({
			inheritAppendSystem: invocationMetadata?.inheritAppendSystem === true,
			systemPromptMode: invocationMetadata?.systemPromptMode,
			systemPrompt: invocationMetadata?.systemPrompt,
			boundarySystemPrompt: invocationMetadata?.boundarySystemPrompt ? CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT : undefined,
		}).env,
	);
	if (invocationMetadata?.agentConfigDir) {
		resumeEnvVars.PI_CODING_AGENT_DIR = invocationMetadata.agentConfigDir;
	} else if (process.env.PI_CODING_AGENT_DIR) {
		resumeEnvVars.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
	}
	const denyTools = new Set<string>();
	if (launchMetadata?.denyTools?.length) {
		for (const toolName of launchMetadata.denyTools) denyTools.add(toolName);
	} else if (process.env.PI_DENY_TOOLS) {
		for (const toolName of process.env.PI_DENY_TOOLS.split(",")
			.map((name) => name.trim())
			.filter(Boolean)) {
			denyTools.add(toolName);
		}
	}
	for (const toolName of resumeSpawnEnv.denyToolsToAdd) denyTools.add(toolName);
	if (denyTools.size > 0) resumeEnvVars.PI_DENY_TOOLS = [...denyTools].join(",");
	// These grant variables are deliberately unconditional. Unlike the deny-tools
	// fallback above, inheriting process.env here would launder the parent's grant.
	resumeEnvVars.PI_SUBAGENT_SPAWN_BUDGET = resumeSpawnEnv.PI_SUBAGENT_SPAWN_BUDGET;
	resumeEnvVars.PI_SUBAGENT_SPAWNABLE = resumeSpawnEnv.PI_SUBAGENT_SPAWNABLE;
	resumeEnvVars.PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE = resumeSpawnEnv.PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE;
	if (savedExtensions !== undefined) {
		resumeEnvVars.PI_SUBAGENT_EXTENSIONS = savedExtensions.join(",");
	} else if (process.env.PI_SUBAGENT_EXTENSIONS) {
		resumeEnvVars.PI_SUBAGENT_EXTENSIONS = process.env.PI_SUBAGENT_EXTENSIONS;
	}
	resumeEnvVars[PI_SUBAGENT_SKILL_VISIBILITY] = getSkillVisibilitySpec(invocationMetadata?.skills);
	if (process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE === "1") {
		resumeEnvVars.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = "1";
	}
	resumeEnvVars[PI_SUBAGENT_CONTEXT_WARN_THRESHOLD] = invocationMetadata?.contextWarnThreshold ?? "";
	resumeEnvVars[PI_SUBAGENT_CONTEXT_WARN_STEP] = invocationMetadata?.contextWarnStep ?? "";
	// Budget inheritance: a resumed run is bounded exactly like the launch that
	// created the session, so resuming a child that ran away cannot run away
	// unbounded.
	const resumeStartTime = Date.now();
	// Launch metadata is authoritative; the previous verdict is the fallback for
	// sessions that never persisted any.
	const resumedTimeout = invocationMetadata?.timeout ?? previousTimeout?.budget?.timeoutSeconds;
	const resumedIdleTimeout = invocationMetadata?.idleTimeout ?? previousTimeout?.budget?.idleTimeoutSeconds;
	resumeEnvVars[PI_SUBAGENT_TIMEOUT] = resumedTimeout ? String(resumedTimeout) : "";
	resumeEnvVars[PI_SUBAGENT_IDLE_TIMEOUT] = resumedIdleTimeout ? String(resumedIdleTimeout) : "";
	resumeEnvVars[PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD] = invocationMetadata?.timeoutWarnThreshold ?? "";
	if (resumedTimeout || resumedIdleTimeout) {
		resumeEnvVars[PI_SUBAGENT_TIMEOUT_STARTED_AT] = String(resumeStartTime);
	}
	resumeEnvVars.PI_SUBAGENT_NAME = invocationMetadata?.name ?? name;
	resumeEnvVars.PI_SUBAGENT_AGENT = resumedAgent ?? "";
	// D12: a resume names no schema; never pass on the resuming process's own or a frontmatter value.
	resumeEnvVars[DATA_SCHEMA_ENV] = "";
	resumeEnvVars.PI_SUBAGENT_SESSION = sessionFile;

	const resumedAsync = invocationMetadata?.async ?? metadata.async ?? true;
	resumeEnvVars.PI_SUBAGENT_AUTO_EXIT = resumedAutoExit ? "1" : "";
	resumeEnvVars.PI_PACKAGE_DIR = "";
	resumeEnvVars.PI_ARTIFACT_PROJECT_ROOT = getArtifactStorageRoot();

	const reservation = sessionResultStore(input.resultsDir).reserve();
	undo.add(() => sessionResultStore(input.resultsDir).discard(reservation));
	sessionResultStore(input.resultsDir).noteLaunch(reservation, sessionFile);
	const running: RunningSubagent = {
		id: reservation.runId,
		name,
		task: task ?? "resumed session",
		agent: resumedAgent,
		mode: metadata.mode,
		phase: "running",
		parentClosePolicy: invocationMetadata?.parentClosePolicy ?? metadata.parentClosePolicy ?? "terminate",
		async: resumedAsync,
		blocking: resumedAsync === false,
		autoExit: resumedAutoExit,
		reportContextUsage: invocationMetadata?.reportContextUsage ?? true,
		...resolveSubagentTimeoutState({
			timeout: resumedTimeout,
			idleTimeout: resumedIdleTimeout,
			timeoutWarnThreshold: invocationMetadata?.timeoutWarnThreshold,
			onTimeout: invocationMetadata?.onTimeout ?? (previousTimeout?.blocksResume ? "block-resume" : undefined),
		}),
		startTime: resumeStartTime,
		sessionFile,
		launchEntryCount: entryCountBefore,
		modelContextWindow: runtime.getContextWindow(invocationMetadata?.modelRef),
		modelRef: invocationMetadata?.modelRef,
		launchMetadata: resumedInvocationMetadata,
		resultTarget: { store: sessionResultStore(input.resultsDir), reservation, ...input.parent },
	};

	await startResumedChild({
		running,
		sessionFile,
		mode: metadata.mode,
		extensionArgs,
		parityArgs,
		resumeCwd,
		expandedTask,
		envVars: resumeEnvVars,
		invocationMetadata,
		denyEnv,
		surfaceName: invocationMetadata?.sessionTitle ?? displayName,
		taskName: name,
		shellReadyDelayMs: runtime.getShellReadyDelayMs(),
		undo,
	});
	// The child runs and owns its run folder, surface and capsule.
	undo.commit();
	discardPreviousExitRecord();

	if (shouldPersistInvocationMetadata) {
		// A live child is never rolled back: a failed write becomes a warning on its result (D6).
		try {
			if (invocationMetadata.modelSource === "resume-override") {
				writeSubagentModelStateEntries(sessionFile, invocationMetadata);
			}
			if (resumedInvocationMetadata) writeSubagentLaunchMetadataEntry(sessionFile, resumedInvocationMetadata);
		} catch (error) {
			const warning = `the resumed child runs, but its launch metadata was not saved to ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`;
			running.resultTarget = {
				...running.resultTarget!,
				warnings: [...(running.resultTarget?.warnings ?? []), warning],
			};
		}
	}
	runtime.runningSubagents.set(running.id, running);
	runtime.startWidgetRefresh();

	const watcherAbort = new AbortController();
	running.abortController = watcherAbort;
	running.completionPromise =
		metadata.mode === "background"
			? runtime.watchBackgroundSubagent(running, runtime.getWatcherSignal(running, watcherAbort))
			: runtime.watchSubagent(running, runtime.getWatcherSignal(running, watcherAbort));

	return running;
}
