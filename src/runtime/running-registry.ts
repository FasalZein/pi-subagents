import { deliverRunEnd } from "./delivery-queue.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CompletedSubagentResult, RunningSubagent, StartedSubagentToolDetails, SubagentResult } from "../types.ts";
import { deliverCompletedSubagentResult, endRun, routeSubagentOutcome } from "./result-router.ts";
import { renderLookup } from "./run-lookup.ts";
import { withRuntimeEnd } from "./run-result.ts";
import { resultTextOf } from "./unpublished-result.ts";
import {
	clearSubagentShutdownTimer,
	completedSubagentResults,
	getSubagentBatchStopMetadata,
	isSubagentBatchBlocking,
	requestSubagentBatchStop,
	runningSubagents,
} from "./state.ts";
import { releaseSpawnWidthSlot } from "./spawn-width.ts";
import { isRunEndHeld, runDeliveryState } from "./wait-holds.ts";

interface RunningRegistryRuntime {
	updateWidget(): void;
	waitForSubagentResult(params: { id: string }, signal?: AbortSignal): Promise<unknown>;
	stopRunningSubagent(running: RunningSubagent): Promise<void>;
	asSubagentToolResult(result: unknown): any;
}

export function findRunningSubagent(query: string): {
	running?: RunningSubagent;
	error?: string;
} {
	const byId = runningSubagents.get(query);
	if (byId) return { running: byId };

	const exactNameMatches = [...runningSubagents.values()].filter((agent) => agent.name === query);
	if (exactNameMatches.length === 1) return { running: exactNameMatches[0] };
	if (exactNameMatches.length > 1) {
		return {
			error: `Multiple subagents named "${query}". Use the id instead.`,
		};
	}

	const normalizedQuery = query.toLowerCase();
	const ciMatches = [...runningSubagents.values()].filter((agent) => agent.name.toLowerCase() === normalizedQuery);
	if (ciMatches.length === 1) return { running: ciMatches[0] };
	if (ciMatches.length > 1) {
		return {
			error: `Multiple subagents named "${query}". Use the id instead.`,
		};
	}

	return { error: `No running subagent matches "${query}".` };
}

export function findTrackedSubagent(query: string): {
	id?: string;
	running?: RunningSubagent;
	cached?: CompletedSubagentResult;
	error?: string;
} {
	const cachedById = completedSubagentResults.get(query);
	if (cachedById) return { id: cachedById.id, cached: cachedById };
	const runningById = runningSubagents.get(query);
	if (runningById) return { id: runningById.id, running: runningById };

	const exactCachedMatches = [...completedSubagentResults.values()].filter((agent) => agent.name === query);
	if (exactCachedMatches.length === 1) {
		return { id: exactCachedMatches[0].id, cached: exactCachedMatches[0] };
	}
	if (exactCachedMatches.length > 1) {
		return {
			error: `Multiple completed subagents match "${query}". Use the id instead.`,
		};
	}

	const exactRunningMatches = [...runningSubagents.values()].filter((agent) => agent.name === query);
	if (exactRunningMatches.length === 1) {
		return { id: exactRunningMatches[0].id, running: exactRunningMatches[0] };
	}
	if (exactRunningMatches.length > 1) {
		return {
			error: `Multiple running subagents match "${query}". Use the id instead.`,
		};
	}

	const normalizedQuery = query.toLowerCase();
	const ciCachedMatches = [...completedSubagentResults.values()].filter(
		(agent) => agent.name.toLowerCase() === normalizedQuery,
	);
	if (ciCachedMatches.length === 1) {
		return { id: ciCachedMatches[0].id, cached: ciCachedMatches[0] };
	}
	if (ciCachedMatches.length > 1) {
		return {
			error: `Multiple completed subagents match "${query}". Use the id instead.`,
		};
	}

	const ciRunningMatches = [...runningSubagents.values()].filter(
		(agent) => agent.name.toLowerCase() === normalizedQuery,
	);
	if (ciRunningMatches.length === 1) {
		return { id: ciRunningMatches[0].id, running: ciRunningMatches[0] };
	}
	if (ciRunningMatches.length > 1) {
		return {
			error: `Multiple running subagents match "${query}". Use the id instead.`,
		};
	}

	return { error: `No subagent matches "${query}".` };
}

export async function stopRunningSubagent(
	running: RunningSubagent,
	closeSurface: (running: RunningSubagent) => Promise<void>,
): Promise<void> {
	clearSubagentShutdownTimer(running);
	running.phase = "stopping";
	running.abortController?.abort();

	// Always kill the child process/surface regardless of abortController.
	// abortController only stops the watcher polling loop; the child would
	// otherwise keep running and deliver stale results via steer.
	if (running.childProcess?.pid) {
		try {
			process.kill(-running.childProcess.pid, "SIGTERM");
		} catch {
			running.childProcess.kill("SIGTERM");
		}
	}
	try {
		await closeSurface(running);
	} catch {}
	releaseSpawnWidthSlot(running);
}

export function getStartedSubagentDetails(
	running: RunningSubagent,
): StartedSubagentToolDetails & Record<string, unknown> {
	return {
		id: running.id,
		name: running.name,
		title: running.title,
		task: running.task,
		agent: running.agent,
		sessionFile: running.noSession ? undefined : running.sessionFile,
		noSession: running.noSession,
		status: "started" as const,
		mode: running.mode,
		deliveryState: runDeliveryState(running),
		parentClosePolicy: running.parentClosePolicy,
		async: running.async !== false,
		autoExit: running.autoExit,
	};
}

function getStartedSubagentResult(running: RunningSubagent) {
	const isAsync = running.async ?? !(running.blocking ?? false);
	if (isAsync) requestSubagentBatchStop();
	return {
		content: [
			{
				type: "text" as const,
				text:
					`Sub-agent "${running.name}" launched ${isAsync ? "async" : "sync"} with id ${running.id}. ` +
					(isAsync
						? `Results will be delivered automatically as a steer message when it finishes. `
						: `The parent is waiting for this result before continuing. `) +
					`Use this exact id if you need to resume or stop this child.`,
			},
		],
		details: getStartedSubagentDetails(running),
		...getSubagentBatchStopMetadata(),
	};
}

export async function getLaunchedSubagentResult(
	running: RunningSubagent,
	runtime: RunningRegistryRuntime,
	signal?: AbortSignal,
) {
	const parentShouldWait = shouldAwaitSubagentLaunch(running);
	if (!parentShouldWait) return getStartedSubagentResult(running);
	const waited = (await runtime.waitForSubagentResult({ id: running.id }, signal)) as { details?: { error?: string } };
	// D04a: as v2.9.2 (cf6dbf4), Esc during the wait of a launch or resume stops the child. subagent_wait
	// keeps its own Esc, which stops only the wait.
	if (waited.details?.error === "interrupted" && runningSubagents.get(running.id) === running) {
		await runtime.stopRunningSubagent(running);
	}
	const result = waited.details?.error === "not_found" ? (lookUpEnded(running) ?? waited) : waited;
	// The parent waited, so the report is already in this tool result. The
	// coordinator-only turn stop exists for detached launches only; a stop mark
	// here would end the turn before the model reads the report.
	return runtime.asSubagentToolResult(result);
}

/**
 * D16: the run already ended and another wait took its end (a ping leaves no cached result), so
 * the launch wait finds it neither running nor cached. Its published record still answers, as a
 * lookup copy that settles nothing again.
 */
function lookUpEnded(running: RunningSubagent) {
	const target = running.resultTarget;
	const record = target?.store.read(target.reservation.runId);
	if (!target || !record) return undefined;
	const status =
		record.outcome === "cancelled"
			? "cancelled"
			: record.outcome === "failed" || record.outcome === "timed_out"
				? "failed"
				: "completed";
	return {
		content: [{ type: "text", text: renderLookup(target.store, record, target.parentCwd) }],
		details: {
			id: running.id,
			name: running.name,
			agent: running.agent,
			status,
			outcome: record.outcome,
			endedBy: record.endedBy,
			runId: record.runId,
			sessionFile: record.sessionFile,
			lookup: true,
		},
	};
}

/** D04a: as v2.9.2 (cf6dbf4), Esc does not reach the wait of an explicitly synchronous launch (async: false). */
export function launchWaitSignal(running: RunningSubagent, signal: AbortSignal | undefined): AbortSignal | undefined {
	return running.async === false ? undefined : signal;
}

/**
 * Whether the parent should await this subagent launch synchronously instead
 * of returning a started result. True when the agent is blocking
 * (`async: false` in frontmatter or via launch param) OR when the current
 * tool batch was marked blocking by the message_end mixed-batch classifier.
 *
 * Shared between the subagent and subagent_resume tools so both paths agree
 * on the await decision and inherit the same mixed-batch sync semantics.
 */
export function shouldAwaitSubagentLaunch(running: Pick<RunningSubagent, "blocking" | "async">): boolean {
	return (running.blocking ?? false) || isSubagentBatchBlocking();
}

export function deliverCompletedSubagentResultViaSteer(
	pi: Pick<ExtensionAPI, "sendMessage">,
	cached: CompletedSubagentResult,
): CompletedSubagentResult {
	return deliverCompletedSubagentResult(pi, cached);
}

export function routeDetachedSubagentCompletion(
	pi: ExtensionAPI,
	running: RunningSubagent,
	result: SubagentResult,
	updateWidget: () => void,
): CompletedSubagentResult {
	const routed = routeSubagentOutcome({
		pi,
		running,
		result,
		updateWidget,
	});
	if (routed.kind !== "completion") {
		throw new Error("routeDetachedSubagentCompletion received a child ping result");
	}
	return routed.completed;
}

function handleDetachedSubagentOutcome(
	pi: ExtensionAPI,
	running: RunningSubagent,
	result: SubagentResult,
	updateWidget: () => void,
): void {
	routeSubagentOutcome({
		pi,
		running,
		result,
		updateWidget,
	});
}

export function wireSubagentSteerBack(
	pi: ExtensionAPI,
	running: RunningSubagent,
	watchPromise: Promise<SubagentResult>,
	updateWidget: () => void,
): void {
	watchPromise
		.then((result) => {
			handleDetachedSubagentOutcome(pi, running, result, updateWidget);
		})
		.catch((err) => {
			const parentOpen = endRun(running);
			releaseSpawnWidthSlot(running);
			runningSubagents.delete(running.id);
			updateWidget();
			// D14 and R2: a watcher error is a failed end, published to the run's files before the
			// hand-over and rendered by the one renderer.
			const error = `watcher error: ${err?.message ?? String(err)}`;
			const failed = withRuntimeEnd(
				running,
				{
					name: running.name,
					task: running.task,
					summary: "",
					summarySource: "runtime",
					sessionFile: running.noSession ? undefined : running.sessionFile,
					exitCode: 1,
					elapsed: (Date.now() - running.startTime) / 1000,
					errorMessage: error,
				},
				{ kind: "failed", error },
			);
			// The record is in the run's files either way; a closed parent gets no message unless a wait holds the end.
			const heldByWait = isRunEndHeld(running.id);
			if (!parentOpen && !heldByWait) return;
			deliverRunEnd(pi, running.id, {
				customType: "subagent_result",
				content: resultTextOf({ ...failed, id: running.id, agent: running.agent }),
				display: true,
				details: {
					id: running.id,
					name: running.name,
					task: running.task,
					agent: running.agent,
					status: "failed",
					outcome: failed.resultOutcome ?? "failed",
					...(failed.resultEndedBy ? { endedBy: failed.resultEndedBy } : {}),
					exitCode: failed.exitCode,
					elapsed: failed.elapsed,
					// The durable session target only; an ephemeral session is never exposed.
					sessionFile: failed.sessionFile,
					deliveryState: runDeliveryState(running),
					parentClosePolicy: running.parentClosePolicy,
					errorMessage: error,
					error: err?.message,
					...(failed.resultRunId ? { runId: failed.resultRunId } : {}),
					...(failed.reportFile ? { reportFile: failed.reportFile } : {}),
				},
			}, { heldByWait });
		});
}
