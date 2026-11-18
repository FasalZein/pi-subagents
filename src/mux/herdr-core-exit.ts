import { spawn } from "node:child_process";
import { constants } from "node:os";
import { createInterface } from "node:readline";
import { execFileAsync } from "./core.ts";
import type { PollResult } from "./poll.ts";

/** The herdr-core CLI. */
export const HC_COMMAND = "hc";
/** Label key whose value is unique to one launch (spec D27). */
export const HERDR_CORE_LAUNCH_LABEL_KEY = "pi-subagents.launch";
const SUBSCRIBE_READY_TIMEOUT_MS = 10_000;

/** Exit facts of a finished terminal: the finished event data and the same fields of `hc get --json`. */
export interface TerminalExitFacts {
	exit_code: number | null;
	signal: string | null;
	reason: string | null;
}

/** The launcher passes Pi's exit code and signal on (D27), so the facts map like a sentinel exit code. */
export function exitFactsResult(facts: TerminalExitFacts): PollResult {
	if (typeof facts.exit_code === "number") return { reason: "sentinel", exitCode: facts.exit_code };
	const signalNumber = facts.signal ? constants.signals[facts.signal as NodeJS.Signals] : undefined;
	return {
		reason: "error",
		exitCode: signalNumber ? 128 + signalNumber : 1,
		errorMessage: `herdr-core terminal ended without an exit code (reason ${facts.reason ?? "unknown"}, signal ${facts.signal ?? "none"}).`,
	};
}

/** Reads one terminal; returns its exit facts when it has finished, else undefined. */
export async function readFinishedTerminal(address: string): Promise<TerminalExitFacts | undefined> {
	const { stdout } = await execFileAsync(HC_COMMAND, ["get", address, "--json"], { encoding: "utf8" });
	const terminal = JSON.parse(stdout) as { state?: string } & Partial<TerminalExitFacts>;
	if (terminal.state !== "finished") return undefined;
	return { exit_code: terminal.exit_code ?? null, signal: terminal.signal ?? null, reason: terminal.reason ?? null };
}

interface EventLine {
	method?: string;
	params?: { type?: string; terminal?: string; data?: Partial<TerminalExitFacts> };
}

/**
 * The exit watch of one launch: a subscription to the events of its label, made before the start.
 * The finished event sets the exit. After a dropped stream it subscribes again first and then reads
 * the terminal state once, so a finish between the drop and the new subscription is not lost (D27).
 */
export class LabelExitWatch {
	exit: PollResult | undefined;
	address: string | undefined;
	/** True while a subscription has answered and its stream is open. */
	streamOpen = false;
	private stopped = false;
	private stopStream: (() => void) | undefined;

	constructor(readonly label: string) {}

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
					this.streamOpen = true;
					clearTimeout(timer);
					resolve();
					return;
				}
				this.handleEvent(line);
			});
			child.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.on("close", () => {
				clearTimeout(timer);
				if (ready) this.streamOpen = false;
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
		const data = event.params.data ?? {};
		this.finish({ exit_code: data.exit_code ?? null, signal: data.signal ?? null, reason: data.reason ?? null });
	}

	private finish(facts: TerminalExitFacts): void {
		if (this.exit) return;
		this.exit = exitFactsResult(facts);
		this.stop();
	}

	/** Subscribe again first, then read the state once. A failed step leaves the exit to checkExit's read. */
	private async recover(): Promise<void> {
		try {
			await this.subscribe();
		} catch {}
		await this.readOnce();
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
