import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSubagentDisplayTitle } from "../agents/titles.ts";
import { getSessionResultsDir } from "../artifact-storage.ts";
import { sessionResultStore } from "../runtime/result-files.ts";
import { clearSubagentExitSidecar } from "../session/exit-sidecar.ts";
import { buildPiPromptArgs } from "../session/session-files.ts";
import { getSubagentToolLaunchArgs } from "../tools/policy.ts";
import type { RunningSubagent, SubagentParamsInput } from "../types.ts";
import { buildAppendSystemInheritancePlan } from "./append-system.ts";
import { getPiInvocation, getSubagentChildProcessEnv } from "./child-command.ts";
import { resolveDenyEnvPatterns } from "./child-env.ts";
import { waitForChildSpawn } from "./child-spawn.ts";
import { CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT } from "./context-boundary.ts";
import { coordinateSubagentLaunch } from "./launch-coordinator.ts";
import { LaunchUndo, withLaunchUndo } from "./launch-undo.ts";
import { PI_SUBAGENT_TIMEOUT_STARTED_AT } from "../tools/timeout-reminders.ts";
import {
	resolveSubagentNoContextFiles,
	resolveSubagentParentClosePolicy,
	resolveSubagentReportContextUsage,
	resolveSubagentTimeoutState,
} from "./policy.ts";
import {
	getApprovalLaunchArgs,
	getFlagsLaunchArgs,
	getPreparedExtensionLaunchArgs,
	getPreparedModel,
	getPreparedRoleBlock,
	getPreparedSessionLaunchArgs,
	getPreparedSkillInjection,
	getPreparedSkillLaunchArgs,
	getPreparedSkillList,
	isPreparedChildSpawningAllowed,
	type SubagentLaunchContext,
} from "./prep.ts";
import { writeTaskArtifact } from "./prompt-artifacts.ts";
import { expandSubagentTask } from "./task-expansion.ts";

export interface BackgroundLaunchRuntime {
	getContextWindow(modelRef: string | undefined): number | undefined;
}

interface BackgroundLaunchPlan {
	launch: Awaited<ReturnType<typeof coordinateSubagentLaunch>>;
	/** Complete child argv after the executable. */
	args: string[];
	/** The composed prompt text (role block + task); the verifier `problem`. */
	fullTask: string;
	/** The `@<artifact>` prompt arg that carries fullTask. */
	taskArg: string;
	invocation: ReturnType<typeof getPiInvocation>;
	denyPatterns: string[];
}

/**
 * Resolve one background launch up to (but not including) the spawn. The
 * verified fan-out driver reuses this to build N launches: with a
 * frozen `taskArg` the task is not re-expanded and no new artifact is
 * written, so every candidate receives byte-identical prompt bytes.
 */
export async function buildBackgroundLaunchPlan(
	params: SubagentParamsInput,
	ctx: SubagentLaunchContext,
	// Without an undo (verified fan-out), the plan's files are left to the caller, as before D6.
	options: { frozenTaskArg?: string; frozenFullTask?: string; spawningDenied?: boolean; undo?: LaunchUndo } = {},
): Promise<BackgroundLaunchPlan> {
	const launch = await coordinateSubagentLaunch(
		params,
		{ ...ctx, autoExit: true },
		{ mode: "background", undo: options.undo ?? new LaunchUndo() },
	);
	const { prepared, directTask } = launch;
	const subagentDonePath = join(dirname(dirname(fileURLToPath(import.meta.url))), "tools", "subagent-done.ts");
	let fullTask: string;
	if (options.frozenFullTask !== undefined) {
		// Byte-identical fan-out candidates: skip expansion entirely and reuse
		// the frozen text from candidate 1.
		fullTask = options.frozenFullTask;
	} else {
		const roleBlock = getPreparedRoleBlock(prepared);
		const modeHint = prepared.agentDefs?.autoExit
			? "Complete your task autonomously."
			: "Manual lifecycle: do not stop after your final text. After completing the task, you MUST call the subagent_done tool unless you intentionally need the human operator to terminate this session. If operator close is required, say exactly `MANUAL CLOSE REQUIRED:` followed by the reason and wait.";
		const summaryInstruction = prepared.agentDefs?.autoExit
			? "Your FINAL assistant message should summarize what you accomplished."
			: "Your FINAL assistant message before calling subagent_done, or before asking for manual close, should summarize what you accomplished. After that final message, immediately call subagent_done.";
		const expandedTask = await expandSubagentTask(params.task, {
			enabled: prepared.agentDefs?.taskExpansion === "shell",
			cwd: prepared.runtimePaths.effectiveCwd ?? ctx.cwd,
		});
		fullTask = directTask ? expandedTask : `${roleBlock}\n\n${modeHint}\n\n${expandedTask}\n\n${summaryInstruction}`;
		const skillInjection = getPreparedSkillInjection(prepared);
		if (skillInjection) fullTask = `${skillInjection}\n\n${fullTask}`;
	}

	const args: string[] = [
		"-p",
		...getPreparedSessionLaunchArgs(prepared),
		...getPreparedExtensionLaunchArgs(prepared, subagentDonePath),
	];
	const model = getPreparedModel(prepared);
	if (model) args.push("--model", model);
	if (resolveSubagentNoContextFiles(prepared.agentDefs)) args.push("--no-context-files");

	const appendSystemPlan = buildAppendSystemInheritancePlan({
		inheritAppendSystem: launch.launchMetadata.inheritAppendSystem === true,
		systemPromptMode: launch.launchMetadata.systemPromptMode,
		systemPrompt: launch.launchMetadata.systemPrompt,
		boundarySystemPrompt: launch.boundarySystemPrompt ? CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT : undefined,
	});
	args.push(...appendSystemPlan.promptArgs);
	args.push(...getApprovalLaunchArgs(prepared.agentDefs, "background"));
	args.push(
		...getSubagentToolLaunchArgs(
			prepared.effectiveTools,
			prepared.denySet,
			options.spawningDenied ? false : isPreparedChildSpawningAllowed(prepared),
		),
	);
	args.push(...getPreparedSkillLaunchArgs(prepared));
	args.push(...getFlagsLaunchArgs(prepared.agentDefs?.flags));

	const taskArg = options.frozenTaskArg ?? `@${writeTaskArtifact(params.name, fullTask, ctx)}`;
	for (const promptArg of buildPiPromptArgs(getPreparedSkillList(prepared), taskArg, directTask)) {
		args.push(promptArg);
	}

	return {
		launch,
		args,
		fullTask,
		taskArg,
		invocation: getPiInvocation(args),
		denyPatterns: resolveDenyEnvPatterns(prepared.agentDefs?.denyEnv),
	};
}

export async function launchBackgroundSubagent(
	params: SubagentParamsInput,
	ctx: SubagentLaunchContext,
	runtime: BackgroundLaunchRuntime,
): Promise<RunningSubagent> {
	return withLaunchUndo((undo) => startBackgroundSubagent(params, ctx, runtime, undo));
}

async function startBackgroundSubagent(
	params: SubagentParamsInput,
	ctx: SubagentLaunchContext,
	runtime: BackgroundLaunchRuntime,
	undo: LaunchUndo,
): Promise<RunningSubagent> {
	const store = sessionResultStore(getSessionResultsDir(ctx.cwd, ctx.sessionManager.getSessionId()));
	const reservation = store.reserve();
	undo.add(() => store.discard(reservation));
	const id = reservation.runId;
	const plan = await buildBackgroundLaunchPlan(params, ctx, { undo });
	const { launch, invocation, denyPatterns } = plan;
	const { prepared, noSession } = launch;
	store.noteLaunch(reservation, noSession ? undefined : prepared.subagentSessionFile);

	const startTime = Date.now();
	const { envVars, launchEntryCount } = launch;
	// The child receives the parent's clock so its launch contract and any
	// report-only continuation match the deadline the watcher enforces.
	if (prepared.agentDefs?.timeout || prepared.agentDefs?.idleTimeout) {
		envVars[PI_SUBAGENT_TIMEOUT_STARTED_AT] = String(startTime);
	}
	clearSubagentExitSidecar(prepared.subagentSessionFile);
	const child = spawn(invocation.command, invocation.args, {
		cwd: launch.forcedCwd ?? prepared.runtimePaths.effectiveCwd ?? ctx.cwd,
		detached: true,
		stdio:
			resolveSubagentParentClosePolicy(prepared.agentDefs) === "continue"
				? ["ignore", "ignore", "ignore"]
				: ["ignore", "pipe", "pipe"],
		env: getSubagentChildProcessEnv(invocation, envVars, denyPatterns),
	});
	child.unref();
	// A spawn error rejects through the undo: the seed and the run folder are removed.
	await waitForChildSpawn(child);
	const running: RunningSubagent = {
		id,
		name: params.name,
		task: params.task,
		title: getSubagentDisplayTitle(params),
		agent: params.agent,
		mode: "background",
		phase: "running",
		parentClosePolicy: resolveSubagentParentClosePolicy(prepared.agentDefs),
		blocking: params.blocking ?? false,
		async: params.async ?? !(params.blocking ?? false),
		autoExit: prepared.agentDefs?.autoExit ?? false,
		noSession,
		reportContextUsage: resolveSubagentReportContextUsage(prepared.agentDefs),
		...resolveSubagentTimeoutState(prepared.agentDefs),
		childProcess: child,
		startTime,
		sessionFile: prepared.subagentSessionFile,
		launchEntryCount,
		modelContextWindow: runtime.getContextWindow(prepared.effectiveModelRef),
		modelRef: prepared.effectiveModelRef,
		launchMetadata: launch.launchMetadata,
		resultTarget: { store, reservation, parentCwd: ctx.cwd, warnings: ctx.resultWarnings ?? [] },
	};
	const rememberTail = (current: string | undefined, chunk: Buffer | string) =>
		`${current ?? ""}${chunk.toString()}`.slice(-4000);
	child.stdout?.on("data", (chunk) => {
		running.stdoutTail = rememberTail(running.stdoutTail, chunk);
	});
	child.stderr?.on("data", (chunk) => {
		running.stderrTail = rememberTail(running.stderrTail, chunk);
	});
	return running;
}
