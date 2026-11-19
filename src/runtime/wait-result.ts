import { randomUUID } from "node:crypto";
import type { CompletedSubagentResult, DeliveryState, RunningSubagent, SubagentResult, WaitParams } from "../types.ts";
import { queuedRunEnd } from "./delivery-queue.ts";
import type { WaitRuntime } from "./wait.ts";
import { getTimeoutResultDetails } from "./timeout-budget.ts";
import { resultTextOf } from "./unpublished-result.ts";

function getSubagentWaitPingResult(running: RunningSubagent, result: SubagentResult, deliveryState: DeliveryState) {
	return {
		content: [
			{
				type: "text",
				// D14: a ping carries the same rendering as the message path.
				text: resultTextOf({ ...result, id: running.id, agent: running.agent }),
			},
		],
		details: {
			id: running.id,
			name: running.name,
			agent: running.agent,
			status: "pinged" as const,
			deliveryState,
			async: running.async !== false,
			elapsed: result.elapsed,
			outputTokens: result.outputTokens,
			sessionFile: result.sessionFile,
			message: result.ping?.message,
			...(result.resultRunId ? { runId: result.resultRunId } : {}),
			...(result.resultOutcome ? { outcome: result.resultOutcome } : {}),
			...(result.reportFile ? { reportFile: result.reportFile } : {}),
		},
	};
}

export function getSubagentWaitSuccessResult(cached: CompletedSubagentResult) {
	// D14: the same rendering the message path shows.
	const text = resultTextOf(cached);
	return {
		content: [{ type: "text", text }],
		details: {
			id: cached.id,
			name: cached.name,
			agent: cached.agent,
			status: cached.status,
			mode: cached.mode,
			parentClosePolicy: cached.parentClosePolicy,
			deliveryState: "awaited" as const,
			async: cached.async,
			autoExit: cached.autoExit,
			exitCode: cached.exitCode,
			elapsed: cached.elapsed,
			outputTokens: cached.outputTokens,
			contextTokens: cached.contextTokens,
			contextWindow: cached.contextWindow,
			summary: cached.summary,
			sessionFile: cached.sessionFile,
			...(cached.resultRunId ? { runId: cached.resultRunId } : {}),
			...(cached.resultOutcome ? { outcome: cached.resultOutcome } : {}),
			...(cached.reportFile ? { reportFile: cached.reportFile } : {}),
			...(cached.deliveryId ? { deliveryId: cached.deliveryId } : {}),
			...getTimeoutResultDetails(cached),
			...(cached.timeoutWrapUp ? { timeoutWrapUp: cached.timeoutWrapUp } : {}),
			...(cached.errorMessage ? { errorMessage: cached.errorMessage } : {}),
		},
	};
}

function getSubagentWaitErrorResult(message: string, error: string, extra: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text", text: message }],
		details: { error, ...extra },
	};
}

function releaseSubagentWaitOwnership(runtime: WaitRuntime, running: RunningSubagent, ownerId: string): void {
	if (runtime.runningSubagents.get(running.id) !== running) return;
	if (running.resultOwner?.kind !== "wait") return;
	if (running.resultOwner.ownerId !== ownerId) return;
	running.resultOwner = undefined;
	running.allowSteerDelivery = true;
	running.deliveryState = "detached";
	runtime.updateWidget();
}

export async function waitForSubagentResult(params: WaitParams, runtime: WaitRuntime, signal?: AbortSignal) {
	const match = runtime.findTrackedSubagent(params.id);
	// A run end that is queued without a cached result (an early ping) is taken like any other.
	const queued = !match.cached && !match.running ? queuedRunEnd(params.id) : undefined;
	if (queued) {
		if (signal?.aborted) {
			return getSubagentWaitErrorResult(`Waiting for sub-agent "${params.id}" was interrupted.`, "interrupted", {
				id: params.id,
			});
		}
		const status = queued.customType === "subagent_ping" ? "pinged" : queued.details.status;
		return {
			content: [{ type: "text", text: queued.content }],
			details: { ...queued.details, status, deliveryState: "awaited" as const },
		};
	}
	if (match.error || (!match.cached && !match.running)) {
		return getSubagentWaitErrorResult(match.error ?? `No subagent matches "${params.id}".`, "not_found", {
			id: params.id,
		});
	}

	const cached = match.cached;
	if (cached && signal?.aborted) {
		// R4: an aborted wait takes nothing; a queued result stays in the queue.
		return getSubagentWaitErrorResult(`Waiting for sub-agent "${cached.name}" was interrupted.`, "interrupted", {
			id: cached.id,
		});
	}
	if (cached) {
		if (cached.deliveryState !== "detached" && !cached.deliveredTo) {
			return getSubagentWaitErrorResult(
				`Sub-agent "${cached.name}" is already owned by another synchronization call.`,
				"already_owned",
				{ id: cached.id },
			);
		}
		cached.deliveryState = "awaited";
		cached.deliveredTo = "wait";
		return getSubagentWaitSuccessResult(cached);
	}

	const running = match.running!;
	if (running.resultOwner) {
		return getSubagentWaitErrorResult(
			`Sub-agent "${running.name}" is already owned by another synchronization call.`,
			"already_owned",
			{ id: running.id },
		);
	}
	if (!running.completionPromise) {
		return getSubagentWaitErrorResult(`Sub-agent "${running.name}" is missing completion tracking.`, "not_found", {
			id: running.id,
		});
	}

	// R4 and D16: a wait that starts aborted takes nothing and stops nothing; the run keeps running
	// and its end goes out as a message.
	if (signal?.aborted) {
		return getSubagentWaitErrorResult(`Waiting for sub-agent "${running.name}" was interrupted.`, "interrupted", {
			id: running.id,
		});
	}

	const ownerId = `wait:${randomUUID()}`;
	running.resultOwner = { kind: "wait", ownerId };
	running.allowSteerDelivery = false;
	running.deliveryState = "awaited";
	runtime.updateWidget();

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let abortCleanup = () => {};
	try {
		const completionPromise = running.completionPromise.then((result) => ({
			kind: "completed" as const,
			result,
		}));
		const races: Array<
			Promise<{ kind: "completed"; result: SubagentResult } | { kind: "timeout" } | { kind: "interrupted" }>
		> = [completionPromise];

		if (params.timeout && params.timeout > 0) {
			races.push(
				new Promise((resolve) => {
					timeoutHandle = setTimeout(() => resolve({ kind: "timeout" as const }), params.timeout! * 1000);
				}),
			);
		}

		if (signal) {
			races.push(
				new Promise((resolve) => {
					const onAbort = () => resolve({ kind: "interrupted" as const });
					signal.addEventListener("abort", onAbort, { once: true });
					abortCleanup = () => signal.removeEventListener("abort", onAbort);
				}),
			);
		}

		const outcome = await Promise.race(races);
		if (outcome.kind === "completed") {
			if (outcome.result.ping) {
				return getSubagentWaitPingResult(running, outcome.result, "awaited");
			}
			const completed =
				runtime.completedSubagentResults.get(running.id) ??
				runtime.cacheCompletedSubagentResult(running, outcome.result);
			if (completed.deliveredTo && completed.deliveredTo !== "wait" && completed.deliveredTo !== "steer") {
				return getSubagentWaitErrorResult(
					`Sub-agent result for "${running.id}" was already delivered via ${completed.deliveredTo}.`,
					"already_delivered",
					{ id: running.id },
				);
			}
			completed.deliveryState = "awaited";
			completed.deliveredTo = "wait";
			return getSubagentWaitSuccessResult(completed);
		}

		releaseSubagentWaitOwnership(runtime, running, ownerId);
		if (outcome.kind === "interrupted") {
			// D16: Esc stops only the wait. The run keeps running and reports by message, for
			// subagent_wait and for a launch that waits alike.
			return getSubagentWaitErrorResult(`Waiting for sub-agent "${running.name}" was interrupted.`, "interrupted", {
				id: running.id,
			});
		}
		if (params.onTimeout === "return_pending" || params.onTimeout === "detach" || params.onTimeout === "return") {
			return {
				content: [
					{
						type: "text",
						text: `Sub-agent "${running.name}" is still running.`,
					},
				],
				details: {
					id: running.id,
					status: "pending" as const,
					deliveryState: "detached" as const,
					timeout: params.timeout,
				},
			};
		}
		return getSubagentWaitErrorResult(`Timed out waiting for sub-agent "${running.name}".`, "timeout", {
			id: running.id,
			timeout: params.timeout,
		});
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		abortCleanup();
	}
}
