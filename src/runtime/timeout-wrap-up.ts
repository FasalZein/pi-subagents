import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getArtifactStorageRoot } from "../artifact-storage.ts";
import { buildAppendSystemInheritancePlan } from "../launch/append-system.ts";
import { getPiInvocation, getSubagentChildProcessEnv } from "../launch/child-command.ts";
import { resolveDenyEnvPatterns } from "../launch/child-env.ts";
import { CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT } from "../launch/context-boundary.ts";
import { parseEnvString } from "../launch/env.ts";
import { getExtensionLaunchArgs, getPersistedPromptLaunchArgs, getPersistedSessionParityArgs } from "../launch/prep.ts";
import { writeResumeTaskArtifact } from "../launch/prompt-artifacts.ts";
import { buildResumePiArgs, getResumeCwd } from "../launch/resume.ts";
import { buildInteractiveShellCommand } from "../launch/shell-command.ts";
import { getSkillVisibilitySpec, PI_SUBAGENT_SKILL_VISIBILITY } from "../launch/skill-visibility.ts";
import { closeSurfaceAsync } from "../mux/io.ts";
import { createSurface, currentMuxAdapter, sendShellCommand } from "../mux.ts";
import { clearSubagentExitSidecar } from "../session/exit-sidecar.ts";
import { getEntryCount } from "../session/session.ts";
import { buildPiPromptArgs, getDoneSentinelFile } from "../session/session-files.ts";
import { PI_SUBAGENT_CONTEXT_WARN_STEP, PI_SUBAGENT_CONTEXT_WARN_THRESHOLD } from "../tools/context-reminders.ts";
import {
	formatTimeoutWarning,
	PI_SUBAGENT_IDLE_TIMEOUT,
	PI_SUBAGENT_TIMEOUT,
	PI_SUBAGENT_TIMEOUT_STARTED_AT,
	PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD,
	PI_SUBAGENT_TIMEOUT_WRAP_UP,
} from "../tools/timeout-reminders.ts";
import { SPAWNING_TOOL_NAMES } from "../tools/tool-names.ts";
import type { RunningSubagent } from "../types.ts";
import { timeoutWrapUpOf } from "./run-phase.ts";
import { addResultWarning } from "./run-result.ts";

interface TimeoutWrapUpRuntime {
	getShellReadyDelayMs(): number;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error("Timeout wrap-up restart aborted.");
}

function waitForDelay(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) {
		throwIfAborted(signal);
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason instanceof Error ? signal.reason : new Error("Timeout wrap-up restart aborted."));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function rememberTail(current: string | undefined, chunk: Buffer | string): string {
	return `${current ?? ""}${chunk.toString()}`.slice(-4000);
}

function getWrapUpPrompt(running: RunningSubagent): string {
	const wrapUp = timeoutWrapUpOf(running);
	if (!wrapUp) throw new Error("Cannot restart timeout wrap-up before a soft deadline is recorded.");
	const baseline = wrapUp.kind === "timeout" ? running.startTime : (running.lastProgressAt ?? running.startTime);
	const spentSeconds = Math.max(0, Math.round((Date.now() - baseline) / 1000));
	return (
		`${formatTimeoutWarning(wrapUp.kind, wrapUp.seconds, spentSeconds)}\n\n` +
		"The parent runtime interrupted your previous active operation at the warning threshold so the remaining time is reserved for this report. " +
		"Do not retry the interrupted tool, call any tool, or begin new work. " +
		"Summarize only the committed work visible in this session and report what remains unfinished."
	);
}

async function getWrapUpLaunchParts(
	running: RunningSubagent,
	signal?: AbortSignal,
): Promise<{
	args: string[];
	env: Record<string, string>;
	cwd: string | undefined;
	prompt: string;
}> {
	const metadata = running.launchMetadata;
	if (!metadata) throw new Error("The original launch metadata is unavailable.");
	const subagentDonePath = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "subagent-done.ts");
	// D08: replay the invocation ref of the launch or resume metadata, never the display ref of running.modelRef.
	const extensionArgs = getExtensionLaunchArgs(metadata.extensions, subagentDonePath, false);
	const parityArgs = [
		...getPersistedPromptLaunchArgs(metadata),
		...(await getPersistedSessionParityArgs(metadata, running.mode, false)),
	].filter((arg) => arg !== "--no-session");
	throwIfAborted(signal);
	const env: Record<string, string> = {};
	if (metadata.env) Object.assign(env, parseEnvString(metadata.env));
	Object.assign(
		env,
		buildAppendSystemInheritancePlan({
			inheritAppendSystem: metadata.inheritAppendSystem === true,
			systemPromptMode: metadata.systemPromptMode,
			systemPrompt: metadata.systemPrompt,
			boundarySystemPrompt: metadata.boundarySystemPrompt ? CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT : undefined,
		}).env,
	);
	if (metadata.agentConfigDir) env.PI_CODING_AGENT_DIR = metadata.agentConfigDir;
	if (metadata.extensions !== undefined) {
		env.PI_SUBAGENT_EXTENSIONS = metadata.extensions.join(",");
	}
	env[PI_SUBAGENT_SKILL_VISIBILITY] = getSkillVisibilitySpec(metadata.skills);
	const deniedTools = new Set(metadata.denyTools);
	for (const toolName of SPAWNING_TOOL_NAMES) deniedTools.add(toolName);
	if (deniedTools.size > 0) env.PI_DENY_TOOLS = [...deniedTools].join(",");
	env[PI_SUBAGENT_CONTEXT_WARN_THRESHOLD] = "";
	env[PI_SUBAGENT_CONTEXT_WARN_STEP] = "";
	env[PI_SUBAGENT_TIMEOUT] = running.timeoutBudget?.timeoutSeconds ? String(running.timeoutBudget.timeoutSeconds) : "";
	env[PI_SUBAGENT_IDLE_TIMEOUT] = running.timeoutBudget?.idleTimeoutSeconds
		? String(running.timeoutBudget.idleTimeoutSeconds)
		: "";
	env[PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD] = running.timeoutWarnThreshold ? String(running.timeoutWarnThreshold) : "";
	env[PI_SUBAGENT_TIMEOUT_STARTED_AT] = String(running.startTime);
	env[PI_SUBAGENT_TIMEOUT_WRAP_UP] = "1";
	env.PI_SUBAGENT_NAME = running.name;
	env.PI_SUBAGENT_AGENT = running.agent ?? "";
	env.PI_SUBAGENT_SESSION = running.sessionFile;
	env.PI_SUBAGENT_AUTO_EXIT = "1";
	env.PI_SUBAGENT_SPAWN_BUDGET = "0";
	env.PI_SUBAGENT_SPAWNABLE = "";
	env.PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE = "";
	env.PI_PACKAGE_DIR = "";
	env.PI_ARTIFACT_PROJECT_ROOT = getArtifactStorageRoot();
	return {
		args: [...extensionArgs, ...parityArgs],
		env,
		cwd: getResumeCwd(metadata),
		prompt: getWrapUpPrompt(running),
	};
}

/** Replace the killed generation with a report-only continuation of the same session. */
export async function restartSubagentForTimeoutWrapUp(
	running: RunningSubagent,
	runtime: TimeoutWrapUpRuntime,
	signal?: AbortSignal,
): Promise<void> {
	const launch = await getWrapUpLaunchParts(running, signal);
	throwIfAborted(signal);
	clearSubagentExitSidecar(running.sessionFile);
	// D12: a nudge of the interrupted process does not mark the replacement's report.
	running.processEntryCount = getEntryCount(running.sessionFile);
	running.autoExit = true;
	running.surfaceClosePromise = undefined;
	running.timeoutKillFailed = undefined;

	if (running.mode === "background") {
		const invocation = getPiInvocation([...buildResumePiArgs(running.sessionFile, "background"), ...launch.args]);
		throwIfAborted(signal);
		const child = spawn(invocation.command, invocation.args, {
			...(launch.cwd ? { cwd: launch.cwd } : {}),
			detached: true,
			stdio:
				running.parentClosePolicy === "continue"
					? (["pipe", "ignore", "ignore"] as const)
					: (["pipe", "pipe", "pipe"] as const),
			env: getSubagentChildProcessEnv(invocation, launch.env, resolveDenyEnvPatterns(running.launchMetadata?.denyEnv)),
		});
		running.childProcess = child;
		child.stdin?.end(launch.prompt);
		child.unref();
		child.stdout?.on("data", (chunk: Buffer) => {
			running.stdoutTail = rememberTail(running.stdoutTail, chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			running.stderrTail = rememberTail(running.stderrTail, chunk);
		});
		return;
	}

	const metadata = running.launchMetadata!;
	const adapter = currentMuxAdapter();
	const programSession = await adapter?.openProgramSession?.();
	const zellijTarget = programSession?.target;
	throwIfAborted(signal);
	const parentPaneId = Number(process.env.ZELLIJ_PANE_ID);
	const zellijContext =
		metadata.zellijPlacementGroupKey && Number.isInteger(parentPaneId)
			? {
					groupKey: metadata.zellijPlacementGroupKey,
					parentPaneId,
					policy: metadata.zellijPlacementPolicy,
				}
			: undefined;
	let surface: string | undefined;
	let disposeCapsule: (() => void) | undefined;
	try {
		if (!zellijTarget) {
			surface = await createSurface(metadata.sessionTitle ?? running.title ?? running.name, {
				herdr: { policy: metadata.herdrPlacementPolicy },
				// The run's own policy (T71): a parent value set later, or an invalid one, cannot move or stop the report.
				rex: { policy: running.rexPlacementPolicy ?? metadata.rexPlacementPolicy },
				zellij: zellijContext,
			});
			running.surface = surface;
			throwIfAborted(signal);
		}
		const doneSentinelFile = getDoneSentinelFile(running.sessionFile, `${running.id}-wrap-up`);
		const piArgs = buildResumePiArgs(running.sessionFile, "interactive");
		piArgs.push(...launch.args);
		const taskPath = writeResumeTaskArtifact(
			running.name,
			launch.prompt,
			running.sessionFile,
			launch.cwd ?? process.cwd(),
		);
		piArgs.push(...buildPiPromptArgs([], `@${taskPath}`));
		if (programSession) Object.assign(launch.env, programSession.childEnv);
		if (surface) launch.env.PI_SUBAGENT_SURFACE = surface;
		const {
			command,
			launch: programLaunch,
			dispose,
		} = buildInteractiveShellCommand({
			cwd: launch.cwd ?? undefined,
			piArgs,
			envOverrides: launch.env,
			denyEnv: metadata.denyEnv,
			paneIdentity: adapter?.paneIdentity,
			doneSentinelFile,
			...(programSession ? { surfaceFromEnv: programSession.surfaceFromEnv } : {}),
		});
		disposeCapsule = dispose;
		if (programSession) {
			surface = await programSession.start(metadata.sessionTitle ?? running.title ?? running.name, programLaunch, {
				zellij: zellijContext,
				onPlacementWarning: (warning) => addResultWarning(running, warning),
			});
			running.surface = surface;
			running.zellijTarget = zellijTarget;
			throwIfAborted(signal);
		} else {
			await waitForDelay(runtime.getShellReadyDelayMs(), signal);
			throwIfAborted(signal);
			sendShellCommand(surface!, command);
		}
		running.doneSentinelFile = doneSentinelFile;
		running.zellijTarget = zellijTarget;
	} catch (error) {
		// Nothing consumed the capsule; do not leave credentials behind.
		disposeCapsule?.();
		if (surface) {
			try {
				await closeSurfaceAsync(surface, zellijTarget);
			} catch {
				running.timeoutKillFailed = true;
			}
			if (running.surface === surface) running.surface = undefined;
		}
		running.doneSentinelFile = undefined;
		running.zellijTarget = undefined;
		throw error;
	}
}
