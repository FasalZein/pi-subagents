import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CompletedSubagentResult, RunningSubagent, SubagentPingMessageDetails, SubagentResult } from "../types.ts";
import { deliverRunEnd, isParentDeliveryClosed } from "./delivery-queue.ts";
import { releaseSpawnWidthSlot } from "./spawn-width.ts";
import { isRunEndHeld, runDeliveryState } from "./wait-holds.ts";
import {
	buildCompletedSubagentResult,
	cacheCompletedSubagentResult,
	clearSubagentShutdownTimer,
	runningSubagents,
} from "./state.ts";
import { getTimeoutResultDetails } from "./timeout-budget.ts";
import { resultTextOf } from "./unpublished-result.ts";

type ParentMessageSink = Pick<ExtensionAPI, "sendMessage">;

export interface RouteSubagentOutcomeOptions {
	pi: ParentMessageSink;
	running: RunningSubagent;
	result: SubagentResult;
	updateWidget(): void;
}

interface RoutedCompletionOutcome {
	kind: "completion";
	completed: CompletedSubagentResult;
}

interface RoutedPingOutcome {
	kind: "ping";
	delivered: boolean;
}

export type RoutedSubagentOutcome = RoutedCompletionOutcome | RoutedPingOutcome;

/**
 * D5: the run's one terminal transition, for a watched end, a watcher failure and a verified
 * adoption alike. Returns whether the parent may still receive the run's end (D15: a closed session
 * gets no more deliveries).
 */
export function endRun(running: RunningSubagent): boolean {
	running.phase = "ended";
	return !isParentDeliveryClosed(running);
}

export function routeSubagentOutcome(options: RouteSubagentOutcomeOptions): RoutedSubagentOutcome {
	const { pi, running, result, updateWidget } = options;
	const parentClosed = !endRun(running);
	clearSubagentShutdownTimer(running);
	// D15: a run end that a wait owns enters the queue held for that wait; the wait's reply takes it.
	const heldByWait = isRunEndHeld(running.id);
	if (result.ping) {
		runningSubagents.delete(running.id);
		updateWidget();
		if (parentClosed && !heldByWait) {
			return { kind: "ping", delivered: false };
		}
		deliverSubagentPing(pi, running, result, heldByWait);
		return { kind: "ping", delivered: true };
	}
	const completed = parentClosed
		? buildCompletedSubagentResult(running, result)
		: cacheCompletedSubagentResult(running, result);
	releaseSpawnWidthSlot(running);
	runningSubagents.delete(running.id);
	updateWidget();
	if (heldByWait) {
		queueCompletedRunEnd(pi, completed, true);
		return { kind: "completion", completed };
	}
	if (parentClosed) {
		return { kind: "completion", completed };
	}
	return {
		kind: "completion",
		completed: deliverCompletedSubagentResult(pi, completed),
	};
}

export function deliverCompletedSubagentResult(
	pi: ParentMessageSink,
	completed: CompletedSubagentResult,
): CompletedSubagentResult {
	if (completed.deliveryState !== "detached" || completed.deliveredTo) {
		return completed;
	}
	queueCompletedRunEnd(pi, completed, false);
	return completed;
}

function queueCompletedRunEnd(pi: ParentMessageSink, completed: CompletedSubagentResult, heldByWait: boolean): void {
	completed.deliveredTo = "steer";
	deliverRunEnd(
		pi,
		completed.id,
		{
			customType: "subagent_result",
			content: resultTextOf(completed),
			display: true,
			details: getCompletedResultDetails(completed),
		},
		{ heldByWait },
	);
}

function getCompletedResultDetails(completed: CompletedSubagentResult): Record<string, unknown> {
	return {
		id: completed.id,
		name: completed.name,
		task: completed.task,
		agent: completed.agent,
		mode: completed.mode,
		status: completed.status,
		deliveryState: completed.deliveryState,
		parentClosePolicy: completed.parentClosePolicy,
		blocking: completed.blocking,
		async: completed.async,
		exitCode: completed.exitCode,
		elapsed: completed.elapsed,
		outputTokens: completed.outputTokens,
		contextTokens: completed.contextTokens,
		contextWindow: completed.contextWindow,
		sessionFile: completed.sessionFile,
		...(completed.resultRunId ? { runId: completed.resultRunId } : {}),
		...(completed.resultOutcome ? { outcome: completed.resultOutcome } : {}),
		...(completed.reportFile ? { reportFile: completed.reportFile } : {}),
		...(completed.deliveryId ? { deliveryId: completed.deliveryId } : {}),
		...getTimeoutResultDetails(completed),
		...(completed.timeoutWrapUp ? { timeoutWrapUp: completed.timeoutWrapUp } : {}),
		...(completed.errorMessage ? { errorMessage: completed.errorMessage } : {}),
	};
}

function deliverSubagentPing(
	pi: ParentMessageSink,
	running: RunningSubagent,
	result: SubagentResult,
	heldByWait: boolean,
): void {
	const ping = result.ping;
	if (!ping) return;
	// D14: a ping is a blocked record and carries the same rendering as every other end.
	const content = resultTextOf({ ...result, id: running.id, agent: running.agent });
	deliverRunEnd(pi, running.id, {
		customType: "subagent_ping",
		content,
		display: true,
		details: {
			id: running.id,
			name: ping.name,
			task: running.task,
			agent: running.agent,
			mode: running.mode,
			deliveryState: runDeliveryState(running),
			parentClosePolicy: running.parentClosePolicy,
			blocking: running.blocking,
			async: running.async ?? !running.blocking,
			elapsed: result.elapsed,
			outputTokens: result.outputTokens,
			sessionFile: result.sessionFile,
			message: ping.message,
			...(result.resultRunId ? { runId: result.resultRunId } : {}),
			...(result.resultOutcome ? { outcome: result.resultOutcome } : {}),
			...(result.reportFile ? { reportFile: result.reportFile } : {}),
			} as SubagentPingMessageDetails,
		},
		{ heldByWait },
	);
}
