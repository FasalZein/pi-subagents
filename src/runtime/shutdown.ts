import { readFileSync } from "node:fs";
import { markSessionFileForDeletionOnExit } from "../session/delete-on-exit.ts";
import { getInteractiveProcessFile, isProcessGone } from "../session/interactive-process.ts";
import type { CompletedSubagentResult, ParentClosePolicy, ParentShutdownAction, RunningSubagent } from "../types.ts";
import { clearSubagentShutdownTimer } from "./state.ts";

export type ShutdownSubagentsOptions = {
	escalationMs?: number;
};

export interface ShutdownRuntime {
	runningSubagents: Map<string, RunningSubagent>;
	completedSubagentResults: Map<string, CompletedSubagentResult>;
	parentCloseEscalationMs: number;
	updateWidget(): void;
	closeRunningSurface(running: RunningSubagent): Promise<void>;
	cleanupNoSessionSessionFile(running: RunningSubagent): void;
}

export function terminateBackgroundChildProcess(running: RunningSubagent, signal: NodeJS.Signals): void {
	if (!running.childProcess?.pid) return;
	try {
		process.kill(-running.childProcess.pid, signal);
	} catch {
		running.childProcess.kill(signal);
	}
}

function abortBackgroundSubagent(running: RunningSubagent, escalationMs: number): void {
	if (running.abortController) {
		running.abortController.abort();
		return;
	}

	terminateBackgroundChildProcess(running, "SIGTERM");
	if (!running.childProcess?.pid) return;
	clearSubagentShutdownTimer(running);
	running.shutdownTimer = setTimeout(() => {
		running.shutdownTimer = undefined;
		terminateBackgroundChildProcess(running, "SIGKILL");
	}, escalationMs);
	running.shutdownTimer.unref?.();
}

/** True once the child process that writes this run's session file has exited, as far as the parent can see. */
function hasChildExited(running: RunningSubagent): boolean {
	if (running.mode !== "interactive") {
		const child = running.childProcess;
		return !child || child.exitCode !== null || child.signalCode !== null;
	}
	if (!running.doneSentinelFile) return true;
	try {
		const pid = Number(readFileSync(getInteractiveProcessFile(running.doneSentinelFile), "utf8").trim());
		return !(Number.isInteger(pid) && pid > 0) || isProcessGone(pid);
	} catch {
		return true;
	}
}

/**
 * D13, continue detach: the child keeps running and appending, so the parent hands the last
 * deletion to the child's own exit path and deletes now only a file whose writer is already gone.
 * The marker goes first, so a child that exits in between still finds it.
 */
function detachNoSessionChild(running: RunningSubagent, runtime: ShutdownRuntime): void {
	running.resultTarget = undefined;
	try {
		markSessionFileForDeletionOnExit(running.sessionFile);
	} catch {}
	if (hasChildExited(running)) runtime.cleanupNoSessionSessionFile(running);
}

/**
 * D13, terminate: the parent process may exit as soon as shutdown returns, so a no-session child's
 * watcher must have seen the child exit and deleted its file first. Bounded by the escalation
 * delay; a headless child still alive then gets SIGKILL, so no write follows the deletion.
 */
async function awaitNoSessionCleanup(
	running: RunningSubagent,
	runtime: ShutdownRuntime,
	escalationMs: number,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const watched = running.completionPromise?.then(
		() => true,
		() => true,
	);
	const settled = await Promise.race([
		watched ?? Promise.resolve(false),
		new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), escalationMs);
		}),
	]);
	clearTimeout(timer);
	if (!settled && running.mode !== "interactive") terminateBackgroundChildProcess(running, "SIGKILL");
	runtime.cleanupNoSessionSessionFile(running);
}

async function terminateInteractiveSubagent(running: RunningSubagent, runtime: ShutdownRuntime): Promise<void> {
	running.abortController?.abort();
	try {
		await runtime.closeRunningSurface(running);
	} catch {}
}

export async function shutdownSubagentsForParentExit(
	runtime: ShutdownRuntime,
	options: ShutdownSubagentsOptions = {},
): Promise<
	Array<{
		id: string;
		policy: ParentClosePolicy;
		action: ParentShutdownAction;
	}>
> {
	const escalationMs = options.escalationMs ?? runtime.parentCloseEscalationMs;
	const actions: Array<{
		id: string;
		policy: ParentClosePolicy;
		action: ParentShutdownAction;
	}> = [];
	const cleanups: Promise<void>[] = [];

	for (const agent of runtime.runningSubagents.values()) {
		clearSubagentShutdownTimer(agent);
		agent.allowSteerDelivery = false;
		agent.resultOwner = undefined;
		agent.deliveryState = "detached";

		if (agent.parentClosePolicy === "continue") {
			// D13, orderly detach: a no-session child gets no result; its file goes after it exits.
			if (agent.noSession) detachNoSessionChild(agent, runtime);
			actions.push({
				id: agent.id,
				policy: agent.parentClosePolicy,
				action: "continue",
			});
			continue;
		}

		actions.push({
			id: agent.id,
			policy: agent.parentClosePolicy,
			action: "terminate",
		});
		if (agent.mode === "interactive") {
			await terminateInteractiveSubagent(agent, runtime);
		} else {
			abortBackgroundSubagent(agent, escalationMs);
		}
		if (agent.noSession) cleanups.push(awaitNoSessionCleanup(agent, runtime, escalationMs));
	}
	await Promise.all(cleanups);

	runtime.runningSubagents.clear();
	runtime.completedSubagentResults.clear();
	runtime.updateWidget();
	return actions;
}
