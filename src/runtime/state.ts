import { outstandingWork } from "./outstanding-work.ts";
import { resetDeliveryQueue } from "./delivery-queue.ts";
import { resetRunEndHolds, runDeliveryState } from "./wait-holds.ts";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { getSubagentTerminalStopReason } from "../session/session.ts";
import type { CompletedSubagentResult, RunningSubagent, SubagentCompletionStatus, SubagentResult } from "../types.ts";
import { releaseSpawnWidthSlot, resetSpawnWidthForTest } from "./spawn-width.ts";
import { SubagentWidgetManager } from "./widget.ts";

export const runningSubagents = outstandingWork.running;
export const completedSubagentResults = new Map<string, CompletedSubagentResult>();

function getSubagentCompletionStatus(
	result: SubagentResult,
	running?: Pick<RunningSubagent, "mode" | "autoExit">,
): SubagentCompletionStatus {
	// D14: a published record decided the end once; the exit facts below are only for runs without one.
	if (result.resultOutcome) {
		if (result.resultOutcome === "cancelled") return "cancelled";
		return result.resultOutcome === "done" || result.resultOutcome === "partial" ? "completed" : "failed";
	}
	if (result.error === "cancelled") return "cancelled";
	// A runaway the runtime had to kill is never a completion, whatever it
	// managed to print before the signal. Without this an interactive child with
	// `auto-exit: false` and real output falls through to the operator-close
	// branch below and is filed as a success.
	if (result.timedOut) return "failed";
	// Provider/network errors may set errorMessage with exitCode 0
	// (Pi exits cleanly even when model calls fail after retry exhaustion).
	if (result.errorMessage) return "failed";
	if (getSubagentTerminalStopReason(result.summary)) return "failed";
	if (result.exitCode === 0) return "completed";
	// Manual interactive children (auto-exit: false) complete when the operator
	// closes the pane. A forced mux/pane close can leave the shell EXIT-trap with a
	// non-zero status; if the child already produced a real final assistant message
	// and the watcher did not hit an error path, that close is a successful operator
	// close rather than a crash.
	if (running?.mode === "interactive" && running.autoExit === false && !result.error && hasRealSubagentOutput(result)) {
		return "completed";
	}
	return "failed";
}

/** True when the summary came from the child rather than runtime diagnostics. */
export function hasRealSubagentOutput(result: Pick<SubagentResult, "summary" | "summarySource">): boolean {
	return result.summarySource !== "runtime" && result.summary.trim() !== "";
}

export function buildCompletedSubagentResult(
	running: RunningSubagent,
	result: SubagentResult,
): CompletedSubagentResult {
	return {
		...result,
		id: running.id,
		agent: running.agent,
		mode: running.mode,
		status: getSubagentCompletionStatus(result, running),
		deliveryState: runDeliveryState(running),
		parentClosePolicy: running.parentClosePolicy,
		async: running.async !== false,
		autoExit: running.autoExit,
		reportContextUsage: running.reportContextUsage,
		deliveredTo: null,
		modelRef: running.modelRef,
	};
}

export function cacheCompletedSubagentResult(
	running: RunningSubagent,
	result: SubagentResult,
): CompletedSubagentResult {
	const cached = buildCompletedSubagentResult(running, result);
	completedSubagentResults.set(running.id, cached);
	return cached;
}

/**
 * A recovery publish replaces the run's last revision (M10-A): a completion already cached for the
 * run takes the new result, so a wait never pairs the old text with the new record. Delivery
 * ownership stays; a run with no cached completion gets none.
 */
export function replaceCachedCompletion(running: RunningSubagent, result: SubagentResult): void {
	const previous = completedSubagentResults.get(running.id);
	if (!previous) return;
	completedSubagentResults.set(running.id, {
		...buildCompletedSubagentResult(running, result),
		deliveryState: previous.deliveryState,
		deliveredTo: previous.deliveredTo,
	});
}

export function clearSubagentShutdownTimer(running: RunningSubagent): void {
	if (!running.shutdownTimer) return;
	clearTimeout(running.shutdownTimer);
	running.shutdownTimer = undefined;
}

export const widgetManager = new SubagentWidgetManager(() => runningSubagents.values());

const WIDGET_MANAGER_KEY = Symbol.for("pi-subagents/widget-manager");
const MODULE_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

function initializeModuleReloadState(): AbortController {
	const previousWidgetManager = (globalThis as Record<PropertyKey, unknown>)[WIDGET_MANAGER_KEY] as
		| SubagentWidgetManager
		| undefined;
	previousWidgetManager?.reset();

	const previousAbortController = (globalThis as Record<PropertyKey, unknown>)[MODULE_ABORT_KEY] as
		| AbortController
		| undefined;
	previousAbortController?.abort();

	const controller = new AbortController();
	(globalThis as Record<PropertyKey, unknown>)[WIDGET_MANAGER_KEY] = widgetManager;
	(globalThis as Record<PropertyKey, unknown>)[MODULE_ABORT_KEY] = controller;
	return controller;
}

type SubagentToolResult = AgentToolResult<unknown> & {
	terminate?: true;
};

export function asSubagentToolResult(result: unknown): SubagentToolResult {
	return result as SubagentToolResult;
}

export let moduleAbortController = initializeModuleReloadState();
/**
 * The launch state of the current tool batch (one model turn). "blocking" absorbs a later stop request:
 * every launch of the batch waits and no reply ends the turn. `stopRequested` keeps that a stop was asked,
 * because the session_shutdown skip and its trace read it (subagents.ts).
 */
type SubagentBatchState = { kind: "open" } | { kind: "blocking"; stopRequested: boolean } | { kind: "stopAfter" };

let subagentBatch: SubagentBatchState = { kind: "open" };

export function resetSubagentBatchStopRequest(): void {
	subagentBatch = { kind: "open" };
}

export function markSubagentBatchBlocking(): void {
	if (subagentBatch.kind === "blocking") return;
	subagentBatch = { kind: "blocking", stopRequested: subagentBatch.kind === "stopAfter" };
}

export function isSubagentBatchBlocking(): boolean {
	return subagentBatch.kind === "blocking";
}

/** True when a stop was asked in this batch, also when the batch is blocking. */
export function isSubagentBatchStopRequested(): boolean {
	return subagentBatch.kind === "stopAfter" || (subagentBatch.kind === "blocking" && subagentBatch.stopRequested);
}

function isCoordinatorOnlyTurnDisabled(): boolean {
	return process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN === "1";
}

export function requestSubagentBatchStop(): void {
	if (isCoordinatorOnlyTurnDisabled()) return;
	// A stop request never downgrades a blocking batch.
	subagentBatch = subagentBatch.kind === "blocking" ? { kind: "blocking", stopRequested: true } : { kind: "stopAfter" };
}

/** The one launch-reply line that says how the reports of detached children return (D23). */
export function getLaunchReturnLine(): string {
	if (isCoordinatorOnlyTurnDisabled()) {
		return "Each report arrives later; until then do only work that does not overlap, and do not poll, redo the delegated work or claim its results.";
	}
	return "Each report arrives later, and this turn may stop after this call so the reports can arrive; do not poll, redo the delegated work or claim its results.";
}

export function getSubagentBatchStopMetadata(): { terminate?: true } {
	return subagentBatch.kind === "stopAfter" ? { terminate: true } : {};
}

export function getWatcherSignal(_running: RunningSubagent, watcherAbort: AbortController): AbortSignal {
	return watcherAbort.signal;
}

export function resetRuntimeStateForTest(resetAmbient: () => void): void {
	resetAmbient();
	// A test may abort the module controller; the next test needs a live one.
	moduleAbortController = initializeModuleReloadState();
	for (const agent of runningSubagents.values()) {
		clearSubagentShutdownTimer(agent);
		agent.abortController?.abort();
		releaseSpawnWidthSlot(agent);
	}
	runningSubagents.clear();
	outstandingWork.reset();
	resetDeliveryQueue();
	resetRunEndHolds();
	completedSubagentResults.clear();
	resetSpawnWidthForTest();
	resetSubagentBatchStopRequest();
	widgetManager.reset();
}
