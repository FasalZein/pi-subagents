import { spawn } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { getPiInvocation, getSubagentChildProcessEnv } from "../launch/child-command.ts";
import { resolveDenyEnvPatterns } from "../launch/child-env.ts";
import { waitForChildSpawn } from "../launch/child-spawn.ts";
import type { LaunchUndo } from "../launch/launch-undo.ts";
import { writeResumeTaskArtifact } from "../launch/prompt-artifacts.ts";
import { buildResumePiArgs } from "../launch/resume.ts";
import { buildInteractiveShellCommand } from "../launch/shell-command.ts";
import { closeSurface, createSurface, currentMuxAdapter, sendShellCommand } from "../mux.ts";
import { getSubagentExitSidecarPath } from "../session/exit-sidecar.ts";
import { getDoneSentinelFile, type PersistedSubagentLaunchMetadata } from "../session/session-files.ts";
import { getSubagentTimeoutSidecarPath } from "../session/timeout-sidecar.ts";
import type { RunningSubagent } from "../types.ts";
import { resolveResumeHerdrPlacementPolicy, resolveResumeZellijPlacementPolicy } from "./resume-placement.ts";

/**
 * D6: the previous run's exit and timeout verdicts move aside until the resumed child has
 * started, so the new child's watcher never reads them as its own. A failed resume puts them
 * back unchanged. Call the returned function after the child started to drop them.
 */
export function setAsidePreviousVerdicts(sessionFile: string, undo: LaunchUndo): () => void {
	const asidePaths: string[] = [];
	for (const path of [getSubagentExitSidecarPath(sessionFile), getSubagentTimeoutSidecarPath(sessionFile)]) {
		if (!existsSync(path)) continue;
		const aside = `${path}.previous`;
		renameSync(path, aside);
		asidePaths.push(aside);
		undo.add(() => renameSync(aside, path));
	}
	return () => {
		for (const aside of asidePaths) rmSync(aside, { force: true });
	};
}

export interface ResumedChildStart {
	running: RunningSubagent;
	sessionFile: string;
	mode: "interactive" | "background";
	extensionArgs: string[];
	parityArgs: string[];
	resumeCwd: string | undefined | null;
	expandedTask: string | undefined;
	envVars: Record<string, string>;
	invocationMetadata: PersistedSubagentLaunchMetadata | undefined;
	surfaceName: string;
	taskName: string;
	shellReadyDelayMs: number;
	undo: LaunchUndo;
}

/** Starts the resumed child; it resolves only once the child process or pane command has started. */
export async function startResumedChild(start: ResumedChildStart): Promise<void> {
	if (start.mode === "background") await startBackgroundChild(start);
	else await startInteractiveChild(start);
}

async function startBackgroundChild(start: ResumedChildStart): Promise<void> {
	const { running, invocationMetadata } = start;
	const invocation = getPiInvocation([
		...buildResumePiArgs(start.sessionFile, "background"),
		...start.extensionArgs,
		...start.parityArgs,
	]);
	const child = spawn(invocation.command, invocation.args, {
		...(start.resumeCwd ? { cwd: start.resumeCwd } : {}),
		detached: true,
		stdio:
			running.parentClosePolicy === "continue"
				? (["pipe", "ignore", "ignore"] as const)
				: (["pipe", "pipe", "pipe"] as const),
		env: getSubagentChildProcessEnv(invocation, start.envVars, resolveDenyEnvPatterns(invocationMetadata?.denyEnv)),
	});
	child.unref();
	// A spawn error rejects through the undo before anything is written to the session.
	await waitForChildSpawn(child);
	if (start.expandedTask !== undefined) {
		child.stdin?.end(start.expandedTask);
	} else {
		child.stdin?.end();
	}
	running.childProcess = child;
	child.stdout?.on("data", (chunk: Buffer) => {
		running.stdoutTail = rememberTail(running.stdoutTail, chunk);
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		running.stderrTail = rememberTail(running.stderrTail, chunk);
	});
}

async function startInteractiveChild(start: ResumedChildStart): Promise<void> {
	const { running, invocationMetadata, sessionFile, undo, surfaceName } = start;
	const resumeEnvVars = start.envVars;
	const adapter = currentMuxAdapter();
	const herdrContext = adapter?.resolveHerdrPlacementPolicy
		? { policy: resolveResumeHerdrPlacementPolicy(invocationMetadata, process.env.PI_SUBAGENT_HERDR_PLACEMENT) }
		: undefined;
	const parentPaneId = Number(process.env.ZELLIJ_PANE_ID);
	const configuredZellijPolicy = resolveResumeZellijPlacementPolicy(
		invocationMetadata,
		process.env.PI_SUBAGENT_ZELLIJ_PLACEMENT,
	);
	const zellijContext =
		invocationMetadata?.zellijPlacementGroupKey && Number.isInteger(parentPaneId)
			? {
					groupKey: invocationMetadata.zellijPlacementGroupKey,
					parentPaneId,
					policy: configuredZellijPolicy,
				}
			: undefined;
	const programSession = await adapter?.openProgramSession?.();
	const ordinarySurface = programSession
		? undefined
		: await createSurface(surfaceName, {
				herdr: herdrContext,
				zellij: zellijContext,
			});
	if (ordinarySurface) undo.add(() => closeSurface(ordinarySurface));
	const doneSentinelFile = getDoneSentinelFile(sessionFile, running.id);
	const piArgs = buildResumePiArgs(sessionFile, "interactive");
	piArgs.push(...start.extensionArgs, ...start.parityArgs);
	if (start.expandedTask !== undefined) {
		const taskPath = writeResumeTaskArtifact(
			start.taskName,
			start.expandedTask,
			sessionFile,
			start.resumeCwd ?? process.cwd(),
		);
		piArgs.push(`@${taskPath}`);
	}
	if (programSession) Object.assign(resumeEnvVars, programSession.childEnv);
	if (ordinarySurface) resumeEnvVars.PI_SUBAGENT_SURFACE = ordinarySurface;
	const { command, dispose } = buildInteractiveShellCommand({
		cwd: start.resumeCwd ?? undefined,
		piArgs,
		envOverrides: resumeEnvVars,
		denyEnv: invocationMetadata?.denyEnv,
		paneIdentity: adapter?.paneIdentity,
		doneSentinelFile,
		...(programSession ? { deriveZellijPaneSurface: true } : {}),
	});
	// Nothing consumes the capsule until the pane receives the command.
	undo.add(dispose);
	const surface = ordinarySurface ?? (await programSession!.start(surfaceName, command, { zellij: zellijContext }));
	if (!programSession) {
		await new Promise<void>((resolve) => setTimeout(resolve, start.shellReadyDelayMs));
		sendShellCommand(surface, command);
	}
	running.surface = surface;
	running.doneSentinelFile = doneSentinelFile;
	running.zellijTarget = programSession?.target;
}

function rememberTail(current: string | undefined, chunk: Buffer | string): string {
	return `${current ?? ""}${chunk.toString()}`.slice(-4000);
}
