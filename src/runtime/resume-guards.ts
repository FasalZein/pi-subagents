import { resolve } from "node:path";
import { endedUnderContextPressure } from "../session/completion-reason.ts";
import { clearSubagentTimeoutSidecar, readSubagentTimeoutSidecar } from "../session/timeout-sidecar.ts";
import type { RunningSubagent, SubagentResult } from "../types.ts";

/**
 * D8: the two resume guards. They run inside the resume itself, so the tool, the overlay and any
 * later caller get them. Only the overlay's explicit operator override skips them, and only for
 * the one attempt that received it.
 */
export function assertResumeAllowed(sessionFile: string): void {
	// The child ended on instruction from its context-warning policy, so its
	// window is spent. Resuming buys no room and only repeats the wrap-up.
	if (endedUnderContextPressure(sessionFile)) {
		throw new Error(
			"This sub-agent stopped early as instructed by its context-warning policy, and its context window is spent. " +
				"Resuming gives it no room to work. Launch a fresh sub-agent with the remaining work instead.",
		);
	}

	// A budget kill is recoverable by default: a resume re-arms the same
	// budget, so it cannot run away again. Only an agent that opted into
	// `on-timeout: block-resume` refuses, because a second partial run of a
	// non-idempotent child is not safe to attempt.
	const timedOut = readSubagentTimeoutSidecar(sessionFile);
	if (!timedOut?.blocksResume) return;
	const limitDescription = timedOut.kind === "idle-timeout" ? "limit for time without output" : "time limit";
	throw new Error(
		`The system stopped this sub-agent because it went past its ${limitDescription}. ` +
			"Its agent file does not allow a resume after that. Start a new sub-agent with a smaller task instead.",
	);
}

/** Sessions that a resume in this process holds, from the first synchronous step to the end of its run. */
const reservedSessions = new Set<string>();

/**
 * D8: reserves the session in this process before any asynchronous step, so a second resume of the
 * same session is refused even when both start together. Returns the release; it is idempotent.
 * Two Pi processes are not covered (spec, D8).
 */
export function reserveResumeSession(sessionFile: string, running: Iterable<RunningSubagent>): () => void {
	const key = resolve(sessionFile);
	for (const existing of running) {
		if (existing.sessionFile && resolve(existing.sessionFile) === key) {
			throw new Error(
				`Session "${existing.name}" (${existing.agent ?? "subagent"}) is already running with id ${existing.id}. ` +
					"Use subagent_kill first or wait for it to complete.",
			);
		}
	}
	if (reservedSessions.has(key)) {
		throw new Error(`Session ${sessionFile} is already being resumed. Wait for that resume to end.`);
	}
	reservedSessions.add(key);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		reservedSessions.delete(key);
	};
}

/**
 * D8: the resumed run's outcome settles the previous verdict. A clean end (exit 0, no error)
 * removes it; a new timeout has already replaced it through the watcher's atomic rename. A
 * cancellation, a failure or a killed child leaves the verdict in force, as does a parent that dies
 * before this runs, because nothing removes it then.
 */
export function settleVerdictAfterRun(sessionFile: string, result: SubagentResult): void {
	if (result.timedOut) return;
	if (result.exitCode !== 0 || result.error) return;
	clearSubagentTimeoutSidecar(sessionFile);
}
