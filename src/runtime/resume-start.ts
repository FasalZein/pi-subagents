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
import type { RunningSubagent } from "../types.ts";
import { resolveResumeHerdrPlacementPolicy, resolveResumeZellijPlacementPolicy } from "./resume-placement.ts";
import { addResultWarning } from "./run-result.ts";

/**
 * D6, D8: the previous run's exit record moves aside before the resumed child starts, so the new
 * child's watcher reads only the record the new child writes. A failed resume puts it back
 * unchanged. Call the returned function after the child started to drop it. The timeout verdict
 * is not touched here: it stays in force until the resumed run ends (settleVerdictAfterRun).
 */
export function setAsidePreviousExitRecord(sessionFile: string, undo: LaunchUndo): () => void {
	const path = getSubagentExitSidecarPath(sessionFile);
	if (!existsSync(path)) return () => {};
	const aside = `${path}.previous`;
	renameSync(path, aside);
	undo.add(() => renameSync(aside, path));
	return () => rmSync(aside, { force: true });
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
	/** The agent's deny-env for the resumed child (resolveResumeDenyEnv). */
	denyEnv: string | undefined;
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
	const { running } = start;
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
		env: getSubagentChildProcessEnv(invocation, start.envVars, resolveDenyEnvPatterns(start.denyEnv)),
	});
	child.unref();
	// A spawn error rejects through the undo before anything is written to the session.
	await waitForChildSpawn(child);
	// end(undefined) closes stdin without writing, as end() does.
	child.stdin?.end(start.expandedTask);
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
	const { command, launch: programLaunch, dispose } = buildInteractiveShellCommand({
		cwd: start.resumeCwd ?? undefined,
		piArgs,
		envOverrides: resumeEnvVars,
		denyEnv: start.denyEnv,
		paneIdentity: adapter?.paneIdentity,
		doneSentinelFile,
		...(programSession ? { surfaceFromEnv: programSession.surfaceFromEnv } : {}),
	});
	// Nothing consumes the capsule until the pane receives the command.
	undo.add(dispose);
	const surface =
		ordinarySurface ??
		(await programSession!.start(surfaceName, programLaunch, {
			zellij: zellijContext,
			onPlacementWarning: (warning) => addResultWarning(running, warning),
		}));
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
