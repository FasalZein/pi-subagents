import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { execFileAsync } from "./core.ts";
import type { PollResult } from "./poll.ts";

/** The herdr-core CLI. */
export const HC_COMMAND = "hc";
/** Label key whose value is unique to one launch (spec D27). */
export const HERDR_CORE_LAUNCH_LABEL_KEY = "pi-subagents.launch";
const SUBSCRIBE_READY_TIMEOUT_MS = 10_000;

/**
 * Exit facts of a finished terminal: the finished event data and the same fields of `hc get --json`.
 * hc's Terminal schema declares exit_code and signal as int32 or null.
 */
interface TerminalExitFacts {
	exit_code: number | null;
	signal: number | null;
	reason: string | null;
}

/** The launcher passes Pi's exit code and signal on (D27), so the facts map like a sentinel exit code. */
export function exitFactsResult(facts: TerminalExitFacts): PollResult {
	if (typeof facts.exit_code === "number") return { reason: "sentinel", exitCode: facts.exit_code };
	return {
		reason: "error",
		exitCode: typeof facts.signal === "number" ? 128 + facts.signal : 1,
		errorMessage: `herdr-core terminal ended without an exit code (reason ${facts.reason ?? "unknown"}, signal ${facts.signal ?? "none"}).`,
	};
}

/** Reads one terminal; returns its exit facts when it has finished, else undefined. */
export async function readFinishedTerminal(address: string): Promise<TerminalExitFacts | undefined> {
	const { stdout } = await execFileAsync(HC_COMMAND, ["get", address, "--json"], { encoding: "utf8" });
	const terminal = JSON.parse(stdout) as Record<string, unknown>;
	if (terminal.state !== "finished") return undefined;
	return exitFacts(terminal);
}

/** Takes the exit facts as hc's schema types them; a field of another type counts as absent. */
function exitFacts(data: Record<string, unknown>): TerminalExitFacts {
	return {
		exit_code: typeof data.exit_code === "number" ? data.exit_code : null,
		signal: typeof data.signal === "number" ? data.signal : null,
		reason: typeof data.reason === "string" ? data.reason : null,
	};
}

interface EventLine {
	method?: string;
	params?: { type?: string; terminal?: string; data?: Record<string, unknown> };
}

/**
 * The exit watch of one launch: a subscription to the events of its label, made before the start.
 * The finished event sets the exit. After a dropped stream it subscribes again first and then reads
 * the terminal state once, so a finish between the drop and the new subscription is not lost (D27).
 */
export class LabelExitWatch {
	exit: PollResult | undefined;
	address: string | undefined;
	/** True after a dropped stream could not subscribe again: no event can end the watch, so checkExit reads. */
	lost = false;
	private stopped = false;
	/** A recovery waits for the address: the stream dropped before the start reply named the terminal. */
	private readOnAttach = false;
	private stopStream: (() => void) | undefined;

	readonly label: string;

	constructor(label: string) {
		this.label = label;
	}

	/** Resolves when the subscription answered with its snapshot, so no later event is missed. */
	subscribe(): Promise<void> {
		const child = spawn(HC_COMMAND, ["events", "--label", `${HERDR_CORE_LAUNCH_LABEL_KEY}=${this.label}`, "--json"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		// The watch must not keep the parent process alive.
		child.unref();
		(child.stdout as unknown as { unref?: () => void }).unref?.();
		this.stopStream = () => child.kill();
		return new Promise<void>((resolve, reject) => {
			let ready = false;
			const timer = setTimeout(() => {
				child.kill();
				reject(new Error(`hc events for label ${this.label} gave no snapshot`));
			}, SUBSCRIBE_READY_TIMEOUT_MS);
			timer.unref?.();
			createInterface({ input: child.stdout }).on("line", (line) => {
				if (!ready) {
					ready = true;
					clearTimeout(timer);
					resolve();
					return;
				}
				this.handleEvent(line);
			});
			child.on("error", (error) => {
				clearTimeout(timer);
				reject(new Error(`hc events for label ${this.label} failed: ${error.message}`));
			});
			child.on("close", () => {
				clearTimeout(timer);
				if (!ready) {
					reject(new Error(`hc events for label ${this.label} ended before its snapshot`));
					return;
				}
				if (!this.stopped && !this.exit) void this.recover();
			});
		});
	}

	private handleEvent(line: string): void {
		let event: EventLine;
		try {
			event = JSON.parse(line) as EventLine;
		} catch {
			return;
		}
		if (event.method !== "event" || event.params?.type !== "finished") return;
		if (this.address && event.params.terminal !== this.address) return;
		this.finish(exitFacts(event.params.data ?? {}));
	}

	private finish(facts: TerminalExitFacts): void {
		if (this.exit) return;
		this.exit = exitFactsResult(facts);
		this.stop();
	}

	/** The start reply named the terminal; a recovery that waited for it reads the state now. */
	attach(address: string): void {
		this.address = address;
		if (this.readOnAttach) {
			this.readOnAttach = false;
			void this.readOnce();
		}
	}

	/**
	 * The one owner of recovery: subscribe again first, then read the state once, or, before the start
	 * reply, once the reply names the terminal. A failed subscription leaves the exit to checkExit's reads.
	 */
	private async recover(): Promise<void> {
		try {
			await this.subscribe();
		} catch {
			this.lost = true;
		}
		if (this.address) await this.readOnce();
		else this.readOnAttach = true;
	}

	/** Reads the terminal state once and takes its exit facts when it has finished. */
	async readOnce(): Promise<void> {
		if (this.exit || !this.address) return;
		try {
			const facts = await readFinishedTerminal(this.address);
			if (facts) this.finish(facts);
		} catch {}
	}

	stop(): void {
		this.stopped = true;
		this.stopStream?.();
		this.stopStream = undefined;
	}
}
