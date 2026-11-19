import { outstandingWork } from "./outstanding-work.ts";
import type { CompletedSubagentResult, RunningSubagent, SubagentPingMessageDetails, SubagentResult } from "../types.ts";
import { releaseSpawnWidthSlot } from "./spawn-width.ts";
import {
	buildCompletedSubagentResult,
	cacheCompletedSubagentResult,
	clearSubagentShutdownTimer,
	runningSubagents,
	stopAfterCurrentSubagentBatch,
} from "./state.ts";
import { getTimeoutResultDetails } from "./timeout-budget.ts";
import { resultTextOf } from "./unpublished-result.ts";

interface ParentMessageSink {
	sendMessage(message: unknown, options: unknown): void;
}

export interface RouteSubagentOutcomeOptions {
	pi: ParentMessageSink;
	running: RunningSubagent;
	result: SubagentResult;
	formatElapsed(elapsed: number): string;
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

export function routeSubagentOutcome(options: RouteSubagentOutcomeOptions): RoutedSubagentOutcome {
	const { pi, running, result, formatElapsed, updateWidget } = options;
	clearSubagentShutdownTimer(running);
	if (result.ping) {
		runningSubagents.delete(running.id);
		updateWidget();
		if (running.allowSteerDelivery === false) {
			return { kind: "ping", delivered: false };
		}
		deliverSubagentPing(pi, running, result, formatElapsed);
		return { kind: "ping", delivered: true };
	}
	const completed =
		running.allowSteerDelivery === false && !running.resultOwner
			? buildCompletedSubagentResult(running, result)
			: cacheCompletedSubagentResult(running, result);
	releaseSpawnWidthSlot(running);
	runningSubagents.delete(running.id);
	updateWidget();
	if (running.allowSteerDelivery === false) {
		return { kind: "completion", completed };
	}
	return {
		kind: "completion",
		completed: deliverCompletedSubagentResult(pi, completed, formatElapsed),
	};
}

export function deliverCompletedSubagentResult(
	pi: ParentMessageSink,
	completed: CompletedSubagentResult,
	formatElapsed: (elapsed: number) => string,
): CompletedSubagentResult {
	if (completed.deliveryState !== "detached" || completed.deliveredTo) {
		return completed;
	}

	const deliverAs = getCompletedResultDeliveryMode();
	completed.deliveredTo = "steer";
	outstandingWork.delivery(completed.id, () => pi.sendMessage(
		{
			customType: "subagent_result",
			content: resultTextOf(completed),
			display: true,
			details: getCompletedResultDetails(completed),
		},
		{ triggerTurn: true, deliverAs },
	), deliverAs === "nextTurn");
	return completed;
}

function getCompletedResultDeliveryMode(): "nextTurn" | "steer" {
	// A result that lands while the parent is still unwinding its async-launch
	// batch waits for the next human prompt, so the chat does not stay in the
	// Working state and swallow the operator's next input as a steer. An
	// auto-exit session never gets that prompt: the loop ends, the running
	// count is already zero, and a `nextTurn` message is not pending, so the
	// session would close with the report unread. Pi still drains queued steers
	// after a terminating batch, so steer is the delivery that guarantees the
	// model reads it there.
	return stopAfterCurrentSubagentBatch && !isAutoExitSession() ? "nextTurn" : "steer";
}

function isAutoExitSession(): boolean {
	return process.env.PI_SUBAGENT_AUTO_EXIT === "1";
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
	formatElapsed: (elapsed: number) => string,
): void {
	const ping = result.ping;
	if (!ping) return;
	// D14: a ping is a blocked record and carries the same rendering as every other end.
	const content = resultTextOf({ ...result, id: running.id, agent: running.agent });
	outstandingWork.delivery(running.id, () => pi.sendMessage(
		{
			customType: "subagent_ping",
			content,
			display: true,
			details: {
				id: running.id,
				name: ping.name,
				task: running.task,
				agent: running.agent,
				mode: running.mode,
				deliveryState: running.deliveryState,
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
		{ triggerTurn: true, deliverAs: "steer" },
	));
}
