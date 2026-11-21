import { existsSync, type FSWatcher, readFileSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { clearSubagentExitSidecar, getSubagentExitSidecarPath, HELD_EXIT_FIELD } from "../session/exit-sidecar.ts";
import { getInteractiveProcessFile } from "../session/interactive-process.ts";
import { readScreenAsync } from "./io.ts";

export interface PollResult {
	reason: "done" | "ping" | "sentinel" | "error";
	exitCode: number;
	outputTokens?: number;
	contextTokens?: number;
	contextWindow?: number;
	/** Set when the child's exit was owned by its context-warning policy. */
	completionReason?: "context-pressure" | "context-pressure-failure";
	ping?: { name: string; message: string };
	errorMessage?: string;
	/** The completion call as the child's completion tool accepted it (RunFacts.acceptedCall, D12). */
	acceptedCall?: { toolCallId: string; args: Record<string, unknown>; dataError?: string };
	/** T70: the child's shutdown record says a person closed its pane (the child did not end itself). */
	closedByOperator?: true;
	/** T73: the final text of an in-memory child, as Pi print mode writes it to stdout (ProcessOutput.stdout). */
	output?: string;
}

/**
 * Interpret an `.exit` sidecar payload. Centralized so both
 * consumeSubagentExitSignal and pollForExit decode the same way.
 */
function withDefinedTokens(obj: PollResult, tokens: number | undefined): PollResult {
	if (tokens !== undefined) {
		obj.outputTokens = tokens;
	}
	return obj;
}

function withDefinedContextUsage(
	obj: PollResult,
	contextTokens: number | undefined,
	contextWindow: number | undefined,
): PollResult {
	if (contextTokens !== undefined && contextWindow !== undefined) {
		obj.contextTokens = contextTokens;
		obj.contextWindow = contextWindow;
	}
	return obj;
}

function withDefinedAcceptedCall(obj: PollResult, call: unknown): PollResult {
	const { toolCallId, args, dataError } = (call ?? {}) as { toolCallId?: unknown; args?: unknown; dataError?: unknown };
	if (typeof toolCallId === "string" && typeof args === "object" && args !== null && !Array.isArray(args)) {
		obj.acceptedCall = { toolCallId, args: args as Record<string, unknown> };
		if (typeof dataError === "string") obj.acceptedCall.dataError = dataError;
	}
	return obj;
}

function withDefinedCompletionReason(obj: PollResult, reason: unknown): PollResult {
	if (reason === "context-pressure") {
		obj.completionReason = "context-pressure";
	}
	if (reason === "context-pressure-failure") {
		obj.completionReason = "context-pressure-failure";
	}
	return obj;
}

function withOperatorClose(obj: PollResult, endedBy: unknown, output: unknown): PollResult {
	if (endedBy === "operator") obj.closedByOperator = true;
	if (typeof output === "string" && output.trim() !== "") obj.output = output;
	return obj;
}

/**
 * Interpret an `.exit` sidecar payload. Centralized so both
 * consumeSubagentExitSignal and pollForExit decode the same way.
 */
function interpretExitSidecar(data: any): PollResult {
	// T85: a record still held when the child is gone was never released by the child's own close,
	// so the person who took over the pane closed it.
	if (data[HELD_EXIT_FIELD] === true) data = { ...data, endedBy: "operator" };
	const tokens = typeof data.outputTokens === "number" ? data.outputTokens : undefined;
	const contextTokens = typeof data.contextTokens === "number" ? data.contextTokens : undefined;
	const contextWindow = typeof data.contextWindow === "number" ? data.contextWindow : undefined;
	const withUsage = (result: PollResult) =>
		withOperatorClose(
			withDefinedAcceptedCall(
				withDefinedCompletionReason(
					withDefinedContextUsage(withDefinedTokens(result, tokens), contextTokens, contextWindow),
					data.completionReason,
				),
				data.acceptedCall,
			),
			data.endedBy,
			data.output,
		);
	if (data.type === "ping") {
		return withUsage({
			reason: "ping" as const,
			exitCode: 0,
			ping: {
				name: data.name ?? "subagent",
				message: data.message ?? "",
			},
		});
	}
	if (data.type === "error") {
		const errorMessage =
			typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
				? data.errorMessage
				: "Subagent exited with stopReason=error (no errorMessage in sidecar).";
		return withUsage({ reason: "error" as const, exitCode: 1, errorMessage });
	}
	return withUsage({ reason: "done" as const, exitCode: 0 });
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * What the caller knows about the child process when it reads the exit record (T85). An exit record
 * is the child's answer, not proof that the child exited: while the child may still run, a record
 * held by a pane takeover stays in place until the child's real close releases it.
 */
export type ChildProcessProof = "child-exited" | "child-may-run";

export function consumeSubagentExitSignal(sessionFile: string, proof: ChildProcessProof): PollResult | null {
	const exitFile = getSubagentExitSidecarPath(sessionFile);
	if (!existsSync(exitFile)) return null;

	try {
		const parsed = JSON.parse(readFileSync(exitFile, "utf8"));
		if (!parsed || typeof parsed !== "object") return null;
		if (proof === "child-may-run" && parsed[HELD_EXIT_FIELD] === true) return null;
		clearSubagentExitSidecar(sessionFile);
		return interpretExitSidecar(parsed);
	} catch {
		return null;
	}
}

/** The wait between two reads of a child's completion files; close it when the poll loop ends. */
export interface CompletionWake {
	/** Resolves after `interval` ms, or sooner when a watched file changed since the last wait began. */
	wait(interval: number, signal: AbortSignal): Promise<void>;
	close(): void;
}

/**
 * Watches the directories of the given files, so a poll loop reads the child's exit record or done
 * sentinel as soon as it is written. A watch that fails to start or misses an event leaves the poll
 * interval as the fallback. A wake only triggers a read; the read keeps its own rules (T85).
 */
export function wakeOnCompletionFiles(files: readonly (string | undefined)[]): CompletionWake {
	const namesByDir = new Map<string, Set<string>>();
	for (const file of files) {
		if (!file) continue;
		const names = namesByDir.get(dirname(file)) ?? new Set<string>();
		names.add(basename(file));
		namesByDir.set(dirname(file), names);
	}
	let changed = false;
	let wake: (() => void) | undefined;
	const watchers: FSWatcher[] = [];
	for (const [dir, names] of namesByDir) {
		try {
			const watcher = watch(dir, (_event, name) => {
				// Without a file name the event may be ours; an extra read costs less than a missed one.
				if (name !== null && !names.has(String(name))) return;
				changed = true;
				wake?.();
			});
			watcher.on("error", () => watcher.close());
			watchers.push(watcher);
		} catch {
			// The poll interval alone decides when this directory is read.
		}
	}
	return {
		wait: (interval, signal) =>
			new Promise<void>((resolve, reject) => {
				if (signal.aborted) return reject(new Error("Aborted"));
				const finish = () => {
					clearTimeout(timer);
					signal.removeEventListener("abort", onAbort);
					wake = undefined;
					changed = false;
				};
				const onAbort = () => {
					finish();
					reject(new Error("Aborted"));
				};
				if (changed) {
					changed = false;
					return resolve();
				}
				const timer = setTimeout(() => {
					finish();
					resolve();
				}, interval);
				wake = () => {
					finish();
					resolve();
				};
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		close: () => {
			wake = undefined;
			for (const watcher of watchers) watcher.close();
		},
	};
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function readDoneSentinel(doneSentinelFile: string): PollResult | null {
	if (!existsSync(doneSentinelFile)) return null;
	let fileText: string;
	try {
		fileText = readFileSync(doneSentinelFile, "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return null;
		throw error;
	}
	const fileMatch = fileText.match(/__SUBAGENT_DONE_(\d+)__/);
	return fileMatch ? { reason: "sentinel", exitCode: parseInt(fileMatch[1], 10) } : null;
}

function readInteractiveProcessId(processIdFile: string): number | null {
	if (!existsSync(processIdFile)) return null;
	try {
		const pid = Number(readFileSync(processIdFile, "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return null;
		throw error;
	}
}

function hasInteractiveProcessExited(doneSentinelFile: string): boolean {
	const processIdFile = getInteractiveProcessFile(doneSentinelFile);
	const pid = readInteractiveProcessId(processIdFile);
	if (pid === null) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		// Only ESRCH proves that the launcher is absent. Permission and unknown
		// probe failures leave the child supervised.
		if (!hasErrorCode(error, "ESRCH")) return false;
		// Normal launcher completion removes the marker before the shell publishes
		// its sentinel. Re-read it so that transition does not look abrupt.
		return readInteractiveProcessId(processIdFile) === pid;
	}
}

export async function pollForExit(
	surface: string,
	signal: AbortSignal,
	options: {
		interval: number;
		sessionFile?: string;
		doneSentinelFile?: string;
		onTick?: (elapsed: number) => void;
	},
): Promise<PollResult> {
	const wake = wakeOnCompletionFiles([
		options.sessionFile && getSubagentExitSidecarPath(options.sessionFile),
		options.doneSentinelFile,
	]);
	try {
		return await pollUntilExit(surface, signal, options, wake);
	} finally {
		wake.close();
	}
}

async function pollUntilExit(
	surface: string,
	signal: AbortSignal,
	options: Parameters<typeof pollForExit>[2],
	wake: CompletionWake,
): Promise<PollResult> {
	const start = Date.now();
	while (true) {
		if (signal.aborted) {
			throw new Error("Aborted while waiting for subagent to finish");
		}

		if (options.sessionFile) {
			const exitSignal = consumeSubagentExitSignal(options.sessionFile, "child-may-run");
			if (exitSignal) return exitSignal;
		}

		if (options.doneSentinelFile) {
			const sentinel = readDoneSentinel(options.doneSentinelFile);
			if (sentinel) return sentinel;
			if (hasInteractiveProcessExited(options.doneSentinelFile)) {
				return {
					reason: "error",
					exitCode: 1,
					errorMessage: "Interactive child process exited without a completion signal.",
				};
			}
		}

		try {
			const screen = await readScreenAsync(surface, 5);
			const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
			if (match) return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
		} catch {
			// An unreadable surface means the pane is gone, and the child with it.
			if (options.sessionFile) {
				const exitSignal = consumeSubagentExitSignal(options.sessionFile, "child-exited");
				if (exitSignal) return exitSignal;
			}
			if (options.doneSentinelFile) {
				const sentinel = readDoneSentinel(options.doneSentinelFile);
				if (sentinel) return sentinel;
			}
			throw new Error("Failed to read subagent surface while polling for exit");
		}

		const elapsed = Math.floor((Date.now() - start) / 1000);
		options.onTick?.(elapsed);
		await wake.wait(options.interval, signal);
	}
}
