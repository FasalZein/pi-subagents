import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { traceSubagentLaunch } from "../launch/trace.ts";
import type { PollResult } from "../mux/poll.ts";
import type { MuxBackendAdapter } from "../mux/backend.ts";
import { consumeSubagentExitSignal, currentMuxAdapter, pollForExit } from "../mux.ts";
import { hasSubagentExitSidecar } from "../session/exit-sidecar.ts";
import { getInteractiveProcessFile, isProcessGone } from "../session/interactive-process.ts";
import { findLastSubagentOutputWithSource, getEntryCount, getNewEntries } from "../session/session.ts";
import { writeSubagentTimeoutSidecar } from "../session/timeout-sidecar.ts";
import type { RunningSubagent, SubagentResult, SubagentSummarySource } from "../types.ts";
import { resolveFinalContextUsage } from "./final-context-usage.ts";
import {
	CANCELLED_SUMMARY,
	isDeadlineEnforceable,
	isStopRequested,
	keepsCompletionOverWrapUp,
	publishedResultFields,
	publishRunResult,
	STOPPED_REASON,
	withRuntimeEnd,
} from "./run-result.ts";
import {
	checkSubagentTimeout,
	checkSubagentTimeoutWrapUp,
	type ExpiredTimeoutBudget,
	getSubagentNextDeadlineAt,
	hasChildProgress,
	observeSubagentProgress,
	TIMEOUT_KILL_ESCALATION_MS,
} from "./timeout-budget.ts";
import { startTimeoutWrapUpWithinDeadline } from "./timeout-restart.ts";

export interface InteractiveWatchRuntime {
	cleanupNoSessionSessionFile(running: RunningSubagent): void;
	closeRunningSurface(running: RunningSubagent): Promise<void>;
	restartForTimeoutWrapUp?(running: RunningSubagent, signal: AbortSignal): Promise<void>;
	pollForExit?: typeof pollForExit;
}

type InteractiveGenerationOutcome = { kind: "restart" } | { kind: "result"; result: SubagentResult };

/**
 * Kill a pane child by closing the surface that owns it.
 *
 * A pane child has no pid here, so this is the only lever, and a close that
 * fails silently would leave the runaway alive while the parent is told it was
 * killed. Retrying and recording the failure is the closest equivalent to the
 * background path's SIGTERM/SIGKILL escalation.
 */
async function closeTimedOutSurface(
	running: RunningSubagent,
	runtime: InteractiveWatchRuntime,
	abortOnFailure: boolean,
): Promise<boolean> {
	const targetSurface = running.surface;
	if (!targetSurface) return true;
	const backoffMs = [0, 250, 1000];
	for (let attempt = 0; attempt < backoffMs.length; attempt++) {
		if (backoffMs[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]));
		if (running.surface !== targetSurface) return true;
		try {
			await runtime.closeRunningSurface(running);
			running.timeoutKillFailed = false;
			return true;
		} catch (error) {
			traceSubagentLaunch("interactive.timeout.closeFailed", {
				name: running.name,
				surface: targetSurface,
				attempt: attempt + 1,
				errorMessage: error instanceof Error ? error.message : String(error),
			});
		}
	}
	// Every attempt failed, so the pane may still be alive. The parent must not
	// be handed a flat "was killed" for a child that might still be running, and
	// the watcher must not keep polling a surface that will not die.
	running.timeoutKillFailed = true;
	if (abortOnFailure) running.abortController?.abort();
	return false;
}

function buildInteractiveRestartTimeoutResult(
	running: RunningSubagent,
	expiry: ExpiredTimeoutBudget,
): SubagentResult {
	const { summary, summarySource } = getSummary(running, { reason: "error", exitCode: 1 });
	const timeoutFields = recordTimeoutOutcome(running);
	const timedOut = { kind: "timed_out", budget: expiry.kind, seconds: expiry.seconds, wrapUp: false } as const;
	return withRuntimeEnd(running, {
		name: running.name,
		task: running.task,
		summary,
		summarySource,
		sessionFile: running.noSession ? undefined : running.sessionFile,
		exitCode: 1,
		elapsed: Math.floor((Date.now() - running.startTime) / 1000),
		outputTokens: 0,
		...timeoutFields,
		...(timeoutFields.timedOut
			? {}
			: {
					timedOut: expiry.kind,
					timedOutAfter: expiry.seconds,
				}),
		...(running.timeoutWrapUp ? { timeoutWrapUp: running.timeoutWrapUp } : {}),
	}, timedOut);
}

/**
 * Choose which signal describes the finished child. The poll result is the
 * authoritative exit record, so it must never be dropped just because it
 * carries no context counts.
 */
export function pickFinalUsageSource(
	pollResult: PollResult,
	exitSignal: PollResult | null | undefined,
): PollResult | null | undefined {
	return pollResult.contextTokens === undefined ? (exitSignal ?? pollResult) : pollResult;
}

/**
 * Record a timeout kill and return the fields the result carries, or nothing
 * when no budget was spent.
 *
 * Only a ping outranks the kill here. Closing the pane makes the child's Pi
 * process publish an ordinary `done` on its way out, so treating that as the
 * child's own verdict would erase every timeout the runtime just enforced.
 */
function recordTimeoutOutcome(
	running: RunningSubagent,
	pollResult?: PollResult,
): Pick<SubagentResult, "timedOut" | "timedOutAfter" | "timeoutBlocksResume" | "timeoutKillFailed"> {
	const expiry = running.timeoutExpiry;
	if (!expiry) return {};
	if (pollResult?.reason === "ping") return {};
	if (!running.noSession) {
		writeSubagentTimeoutSidecar(running.sessionFile, {
			kind: expiry.kind,
			blocksResume: running.timeoutBlocksResume === true,
			...(running.timeoutBudget ? { budget: running.timeoutBudget } : {}),
		});
	}
	return {
		timedOut: expiry.kind,
		timedOutAfter: expiry.seconds,
		...(running.timeoutBlocksResume === true ? { timeoutBlocksResume: true } : {}),
		...(running.timeoutKillFailed === true ? { timeoutKillFailed: true } : {}),
	};
}

export async function watchSubagent(
	running: RunningSubagent,
	runtime: InteractiveWatchRuntime,
	signal: AbortSignal,
): Promise<SubagentResult> {
	try {
		while (true) {
			const outcome = await watchInteractiveGeneration(running, runtime, signal);
			if (outcome.kind === "result") return outcome.result;
			if (signal.aborted) return buildInteractiveCancellationResult(running);
			try {
				if (!runtime.restartForTimeoutWrapUp) {
					throw new Error("Timeout wrap-up restart is unavailable.");
				}
				const restart = await startTimeoutWrapUpWithinDeadline(running, signal, {
					restart: runtime.restartForTimeoutWrapUp,
					stopStarted: async (current) => {
						try {
							await runtime.closeRunningSurface(current);
						} catch {
							current.timeoutKillFailed = true;
						}
					},
				});
				if (restart.kind === "cancelled") return buildInteractiveCancellationResult(running);
				if (restart.kind === "timedOut") {
					return buildInteractiveRestartTimeoutResult(running, restart.expiry);
				}
				running.phase = "wrapping-up";
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return withRuntimeEnd(running, {
					name: running.name,
					task: running.task,
					summary: `The system interrupted this sub-agent for its time-limit wrap-up, but the wrap-up continuation failed to start: ${message}`,
					summarySource: "runtime",
					sessionFile: running.noSession ? undefined : running.sessionFile,
					exitCode: 1,
					elapsed: Math.floor((Date.now() - running.startTime) / 1000),
					error: message,
					...(running.timeoutWrapUp ? { timeoutWrapUp: running.timeoutWrapUp } : {}),
				}, { kind: "failed", error: message });
			}
		}
	} finally {
		// D13: Pi appends by pathname, also in its shutdown handler after the done sidecar, so the
		// temporary session file goes only after the pane launcher (which outlives Pi) has exited.
		if (running.noSession) await waitForPaneLauncherExit(running);
		runtime.cleanupNoSessionSessionFile(running);
	}
}

const PANE_EXIT_POLL_MS = 50;

async function waitForPaneLauncherExit(running: RunningSubagent): Promise<void> {
	const pid = running.paneLauncherPid;
	if (pid === undefined) return;
	// The pane is closed by now; a launcher that outlives the kill escalation bound is not waited for.
	const deadline = Date.now() + TIMEOUT_KILL_ESCALATION_MS;
	while (!isProcessGone(pid) && Date.now() < deadline) await delay(PANE_EXIT_POLL_MS);
}

async function watchInteractiveGeneration(
	running: RunningSubagent,
	runtime: InteractiveWatchRuntime,
	signal: AbortSignal,
): Promise<InteractiveGenerationOutcome> {
	const { name, task, startTime, sessionFile } = running;
	const surface = running.surface;
	if (!surface) throw new Error("watchSubagent called on a background agent (no surface)");
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

	const updateStats = () => {
		const now = Date.now();
		try {
			if (existsSync(sessionFile)) {
				const stat = statSync(sessionFile);
				const previousEntries = running.entries ?? 0;
				const entries = getEntryCount(sessionFile);
				// Only the child's own output restarts the idle clock; a prompt the
				// runtime wrote into the session is not child progress.
				const produced =
					entries > previousEntries ? hasChildProgress(getNewEntries(sessionFile, previousEntries)) : false;
				observeSubagentProgress(running, stat.size, now, produced);
				running.entries = entries;
			}
		} catch {}
		// D7: a stop that came first decides the end, also while the surface closes asynchronously.
		if (!isDeadlineEnforceable(signal)) return;
		const expired = checkSubagentTimeout(running, now);
		if (expired) {
			// A child that already published its own outcome finished on its own
			// terms; the deadline it crossed while exiting is not a runaway.
			if (hasSubagentExitSidecar(running.sessionFile)) return;
			running.timeoutExpiry = expired;
			running.phase = "stopping";
			void closeTimedOutSurface(running, runtime, true);
			armDeadlineTimer();
			return;
		}
		const wrapUp = checkSubagentTimeoutWrapUp(running, now);
		if (wrapUp && running.phase === "running" && !hasSubagentExitSidecar(running.sessionFile)) {
			running.timeoutWrapUp = wrapUp;
			running.phase = "soft-limit";
			const baseline =
				wrapUp.kind === "timeout" ? running.startTime : (running.lastProgressAt ?? running.startTime);
			running.timeoutWrapUpDeadlineAt = baseline + wrapUp.seconds * 1000;
			void closeTimedOutSurface(running, runtime, false);
		}
		armDeadlineTimer();
	};

	const armDeadlineTimer = () => {
		if (deadlineTimer) clearTimeout(deadlineTimer);
		const deadlineAt = getSubagentNextDeadlineAt(running);
		if (deadlineAt === undefined) {
			deadlineTimer = undefined;
			return;
		}
		deadlineTimer = setTimeout(() => {
			deadlineTimer = undefined;
			updateStats();
		}, Math.max(1, deadlineAt - Date.now()));
		deadlineTimer.unref?.();
	};
	armDeadlineTimer();

	try {
		traceSubagentLaunch("interactive.watch.start", {
			name,
			surface,
			sessionFile,
			signalAborted: signal.aborted,
		});
		const adapter = currentMuxAdapter();
		const pollResult = adapter?.checkExit
			? await pollForProgramSurfaceExit(running, adapter, signal, updateStats)
				: await (runtime.pollForExit ?? pollForExit)(surface, signal, {
						interval: 1000,
						sessionFile,
						doneSentinelFile: running.doneSentinelFile,
						onTick: updateStats,
					});

		traceSubagentLaunch("interactive.watch.pollResult", {
			name,
			surface,
			sessionFile,
			pollResult,
		});
		const lateExitSignal = pollResult.outputTokens === undefined ? consumeSubagentExitSignal(sessionFile) : undefined;
		// One outcome for storage and both carriers: the child's own exit record outranks the shell's
		// exit status, so a late error record never becomes a success because the shell reported 0.
		const end = lateExitSignal && pollResult.reason === "sentinel" ? lateExitSignal : pollResult;
		const exitSignal = end === lateExitSignal ? undefined : lateExitSignal;
		// The child has exited: no later deadline tick may change how this end is decided.
		if (deadlineTimer) clearTimeout(deadlineTimer);
		if (
			running.phase === "soft-limit" &&
			!signal.aborted &&
			end.reason !== "ping" &&
			exitSignal?.reason !== "ping" &&
			!keepsCompletionOverWrapUp(running, end, exitSignal)
		) {
			cleanupDoneSentinel(running);
			try {
				await runtime.closeRunningSurface(running);
			} catch {}
			return { kind: "restart" };
		}
		const elapsed = Math.floor((Date.now() - startTime) / 1000);
		const errorMessage = end.reason === "error" ? end.errorMessage : undefined;
		const finalContextUsage = resolveFinalContextUsage(running, pickFinalUsageSource(end, exitSignal));
		// D7: a stop decides the outcome, whatever the dying child wrote.
		const stopped = isStopRequested(running, signal);
		const timeoutFields = recordTimeoutOutcome(running, end);
		// D14: every watched pane end gets the same assembled, published and rendered result as a
		// headless child. The end is the exit record when the watcher consumed one.
		const ping = stopped ? undefined : (end.ping ?? exitSignal?.ping);
		const published = publishRunResult(running, {
			exitCode: end.exitCode,
			operatorClosed: running.autoExit === false && end.reason === "sentinel",
			stopped,
			timedOut: timeoutFields.timedOut
				? { kind: timeoutFields.timedOut, seconds: timeoutFields.timedOutAfter ?? 0 }
				: undefined,
			ping: ping ?? (!stopped && end.reason === "ping" ? { message: "" } : undefined),
			errorMessage,
			exitSignal: end.acceptedCall ? end : exitSignal,
			contextUsage: finalContextUsage,
		});
		// The published record already read this run's transcript; only an unpublished end reads it here.
		const { summary, summarySource } =
			published ?? (stopped ? { summary: CANCELLED_SUMMARY, summarySource: "runtime" as const } : getSummary(running, end));
		cleanupDoneSentinel(running);
		try {
			await runtime.closeRunningSurface(running);
		} catch {}
		return {
			kind: "result",
			result: {
				name,
				task,
				summary,
				summarySource,
				sessionFile: running.noSession ? undefined : sessionFile,
				// A pane closed by the runtime still reports a clean exit; a killed
				// runaway must never be filed as a success.
				exitCode: timeoutFields.timedOut ? end.exitCode || 1 : end.exitCode,
				elapsed,
				outputTokens: end.outputTokens ?? exitSignal?.outputTokens,
				...finalContextUsage,
				...timeoutFields,
				...(running.timeoutWrapUp ? { timeoutWrapUp: running.timeoutWrapUp } : {}),
				ping,
				errorMessage,
				...(stopped ? { error: "cancelled" } : {}),
				...publishedResultFields(published),
			},
		};
	} catch (err: unknown) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		traceSubagentLaunch("interactive.watch.error", {
			name,
			surface,
			sessionFile,
			errorMessage,
			signalAborted: signal.aborted,
		});
		cleanupDoneSentinel(running);
		try {
			await runtime.closeRunningSurface(running);
		} catch {}
		if (running.phase === "soft-limit" && !signal.aborted) {
			return { kind: "restart" };
		}

		// A spent budget explains the failed poll: the watcher closed the surface
		// out from under it. Reporting "cancelled" or a raw surface error here
		// would hide the only fact the parent needs.
		const timeoutFields = recordTimeoutOutcome(running);
		if (timeoutFields.timedOut) {
			const { summary, summarySource } = getSummary(running, { reason: "error", exitCode: 1 });
			const expiry = running.timeoutExpiry!;
			return {
				kind: "result",
				result: withRuntimeEnd(running, {
					name,
					task,
					summary,
					summarySource,
					sessionFile: running.noSession ? undefined : sessionFile,
					exitCode: 1,
					elapsed: Math.floor((Date.now() - startTime) / 1000),
					outputTokens: 0,
					...timeoutFields,
					...(running.timeoutWrapUp ? { timeoutWrapUp: running.timeoutWrapUp } : {}),
				}, { kind: "timed_out", budget: expiry.kind, seconds: expiry.seconds, wrapUp: false }),
			};
		}

		if (signal.aborted) {
			return { kind: "result", result: buildInteractiveCancellationResult(running) };
		}
		return {
			kind: "result",
			result: withRuntimeEnd(running, {
				name,
				task,
				summary: `Subagent error: ${errorMessage}`,
				summarySource: "runtime",
				sessionFile: running.noSession ? undefined : sessionFile,
				exitCode: 1,
				elapsed: Math.floor((Date.now() - startTime) / 1000),
				outputTokens: 0,
				error: errorMessage,
				...(running.timeoutWrapUp ? { timeoutWrapUp: running.timeoutWrapUp } : {}),
			}, { kind: "failed", error: errorMessage }),
		};
	} finally {
		if (deadlineTimer) clearTimeout(deadlineTimer);
	}
}

function buildInteractiveCancellationResult(running: RunningSubagent): SubagentResult {
	return withRuntimeEnd(running, {
		name: running.name,
		task: running.task,
		summary: CANCELLED_SUMMARY,
		summarySource: "runtime",
		sessionFile: running.noSession ? undefined : running.sessionFile,
		exitCode: 1,
		elapsed: Math.floor((Date.now() - running.startTime) / 1000),
		outputTokens: 0,
		error: "cancelled",
		...(running.timeoutWrapUp ? { timeoutWrapUp: running.timeoutWrapUp } : {}),
	}, { kind: "cancelled", reason: STOPPED_REASON });
}

function getSummary(
	running: RunningSubagent,
	pollResult: PollResult,
): { summary: string; summarySource: SubagentSummarySource } {
	if (existsSync(running.sessionFile)) {
		const output = findLastSubagentOutputWithSource(getNewEntries(running.sessionFile, running.launchEntryCount ?? 0));
		if (output) return output;
	}
	return {
		summary:
			pollResult.exitCode !== 0
				? `Sub-agent exited with code ${pollResult.exitCode}`
				: "Sub-agent exited without output",
		summarySource: "runtime",
	};
}

/** Polls the completion files and the backend's own exit check of a direct-program surface. */
async function pollForProgramSurfaceExit(
	running: RunningSubagent,
	adapter: MuxBackendAdapter,
	signal: AbortSignal,
	onTick: () => void,
): Promise<PollResult> {
	while (!signal.aborted) {
		const completion = readProgramCompletion(running);
		if (completion) return completion;
		if (running.zellijTarget && running.surface) {
			const exited = await adapter.checkExit?.(running.surface, running.zellijTarget);
			// The child can write its completion and exit while the liveness query runs: a pane found
			// gone is a watcher error only when no completion record or shell status exists by then.
			if (exited) return readProgramCompletion(running) ?? exited;
		}
		onTick();
		await waitForPoll(1000, signal);
	}
	throw new Error("Aborted while waiting for subagent to finish");
}

/** The child's exit record, else the shell's exit status from the done sentinel, else null. */
function readProgramCompletion(running: RunningSubagent): PollResult | null {
	const exit = consumeSubagentExitSignal(running.sessionFile);
	if (exit) return exit;
	if (running.doneSentinelFile && existsSync(running.doneSentinelFile)) {
		const match = readFileSync(running.doneSentinelFile, "utf8").match(/__SUBAGENT_DONE_(\d+)__/);
		if (match) return { reason: "sentinel", exitCode: Number(match[1]) };
	}
	return null;
}

function waitForPoll(interval: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			reject(new Error("Aborted"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, interval);
		signal.addEventListener("abort", abort, { once: true });
	});
}

function cleanupDoneSentinel(running: RunningSubagent): void {
	if (!running.doneSentinelFile) return;
	try {
		const pid = Number(readFileSync(getInteractiveProcessFile(running.doneSentinelFile), "utf8").trim());
		if (Number.isInteger(pid) && pid > 0) running.paneLauncherPid = pid;
	} catch {}
	try {
		rmSync(running.doneSentinelFile, { force: true });
		rmSync(getInteractiveProcessFile(running.doneSentinelFile), { force: true });
	} catch {}
}
