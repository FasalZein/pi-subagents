import type { RunningSubagent } from "../types.ts";
import { checkSubagentTimeout, getSubagentHardDeadlineAt, type ExpiredTimeoutBudget } from "./timeout-budget.ts";

type TimeoutRestartOutcome =
	| { kind: "started" }
	| { kind: "cancelled" }
	| { kind: "timedOut"; expiry: ExpiredTimeoutBudget };

interface TimeoutRestartRuntime {
	restart(running: RunningSubagent, signal: AbortSignal): Promise<void>;
	stopStarted(running: RunningSubagent): Promise<void>;
}

/** Start the report continuation without allowing restart work to reset or outrun the original clock. */
export async function startTimeoutWrapUpWithinDeadline(
	running: RunningSubagent,
	parentSignal: AbortSignal,
	runtime: TimeoutRestartRuntime,
): Promise<TimeoutRestartOutcome> {
	const hardDeadlineAt = getSubagentHardDeadlineAt(running);
	const restartAbort = new AbortController();
	let deadlineReached = false;
	// D7: whichever of the parent stop and the hard deadline came first decides the end.
	let firstCause: "stop" | "deadline" | undefined;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const abortFromParent = () => {
		firstCause ??= "stop";
		restartAbort.abort(parentSignal.reason);
	};
	const reachDeadline = () => {
		firstCause ??= "deadline";
		deadlineReached = true;
		restartAbort.abort(new Error("The original sub-agent hard deadline was reached during wrap-up restart."));
	};
	parentSignal.addEventListener("abort", abortFromParent, { once: true });

	if (parentSignal.aborted) abortFromParent();
	if (hardDeadlineAt !== undefined) {
		const delay = hardDeadlineAt - Date.now();
		if (delay <= 0) {
			reachDeadline();
		} else {
			deadlineTimer = setTimeout(reachDeadline, delay);
			deadlineTimer.unref?.();
		}
	}

	const stopStarted = async () => {
		try {
			await runtime.stopStarted(running);
		} catch {}
	};
	const resolveInterruptedOutcome = async (): Promise<TimeoutRestartOutcome | null> => {
		if (firstCause === "stop") {
			await stopStarted();
			return { kind: "cancelled" };
		}
		const expiry = checkSubagentTimeout(
			running,
			deadlineReached && hardDeadlineAt !== undefined ? Math.max(Date.now(), hardDeadlineAt) : Date.now(),
		);
		if (deadlineReached || expiry) {
			const resolvedExpiry = expiry ?? checkSubagentTimeout(running, hardDeadlineAt ?? Date.now());
			if (!resolvedExpiry) return null;
			running.timeoutExpiry = resolvedExpiry;
			running.phase = "stopping";
			await stopStarted();
			return { kind: "timedOut", expiry: resolvedExpiry };
		}
		return null;
	};

	try {
		const beforeStart = await resolveInterruptedOutcome();
		if (beforeStart) return beforeStart;
		await runtime.restart(running, restartAbort.signal);
		return (await resolveInterruptedOutcome()) ?? { kind: "started" };
	} catch (error) {
		const interrupted = await resolveInterruptedOutcome();
		if (interrupted) return interrupted;
		throw error;
	} finally {
		if (deadlineTimer) clearTimeout(deadlineTimer);
		parentSignal.removeEventListener("abort", abortFromParent);
	}
}
