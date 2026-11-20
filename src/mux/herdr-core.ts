import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { HERDR_CORE_PANE_IDENTITY } from "../launch/child-env.ts";
import type { DirectProgramSession, MuxBackendAdapter, ProgramLaunch } from "./backend.ts";
import { execFileAsync, tailLines } from "./core.ts";
import {
	exitFactsResult,
	HC_COMMAND,
	HERDR_CORE_LAUNCH_LABEL_KEY,
	LabelExitWatch,
	readFinishedTerminal,
} from "./herdr-core-exit.ts";
import { placeChildTerminal } from "./herdr-core-placement.ts";
import { createOscWorkReporter } from "./osc-work-record.ts";
import type { PollResult } from "./poll.ts";
import { defaultMuxRuntimeProbe } from "./runtime-probe.ts";

const START_REPLY_TIMEOUT_MS = 10_000;
/** Bound of the detection call: the same 2,000 ms as old herdr's bounded CLI calls (runHerdrJsonAsync). */
export const APP_CHECK_TIMEOUT_MS = 2_000;
/** Label that carries the title of the caller terminal; herdr-core has no tab or workspace of its own. */
const TITLE_LABEL_KEY = "pi-subagents.title";

/**
 * Window of the label lookup after a start request without an answer (D27): the same 2,000 ms bound as the
 * app check. The live drop probes found the terminal, when one was made, in the first lookup after the drop.
 */
const LABEL_LOOKUP_WINDOW_MS = APP_CHECK_TIMEOUT_MS;
/** Pause between label lookups: the 1,000 ms poll of the program-surface exit watcher (interactive-watch). */
const LABEL_LOOKUP_INTERVAL_MS = 1_000;

/** Exit watches of the direct-program terminals of this process, by terminal address. */
const exitWatches = new Map<string, LabelExitWatch>();
/**
 * Exit results of the terminals this process removed. The backend contract reports the exit after an awaited
 * close; addresses are unique per core, and an entry is one small result per closed child of this process.
 */
const removedExits = new Map<string, PollResult>();

/**
 * Stops and forgets every exit watch of this process. Test seam: a watch whose terminal never finished
 * keeps its `hc events` stream; when a test removes the fake's state the stream drops, and the watch
 * subscribes again with the env of whatever test runs then (test/test.ts runs every suite in one process).
 */
export function stopExitWatchesForTest(): void {
	for (const watch of exitWatches.values()) watch.stop();
	exitWatches.clear();
	removedExits.clear();
}

function callerTerminal(): string {
	const caller = process.env.HC_TERMINAL_ID;
	if (!caller) throw new Error("HC_TERMINAL_ID not set");
	return caller;
}

function hcSync(args: string[]): string {
	return execFileSync(HC_COMMAND, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * The Herdr app answers (D27): `hc get` on the caller terminal, bounded. Inherited HC markers outside a
 * running app must not shadow another backend (D29).
 */
function appAnswers(caller: string): boolean {
	try {
		return isTerminalReply(
			execFileSync(HC_COMMAND, ["get", caller, "--json"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: APP_CHECK_TIMEOUT_MS,
				killSignal: "SIGKILL",
			}),
		);
	} catch {
		return false;
	}
}

function isTerminalReply(out: string): boolean {
	return typeof (JSON.parse(out) as { address?: unknown }).address === "string";
}

/**
 * The launch check of isAvailable, asynchronous, for the status reporter: session start never blocks, and
 * the reporter follows the launch decision, so inherited HC markers do not shadow old herdr's reporter (D29, D30).
 */
async function herdrCoreUsable(): Promise<boolean> {
	const caller = process.env.HC_TERMINAL_ID;
	if (!caller || !process.env.HC_TERMINAL_SOCKET || !defaultMuxRuntimeProbe.hasCommand(HC_COMMAND)) return false;
	try {
		const { stdout } = await execFileAsync(HC_COMMAND, ["get", caller, "--json"], {
			encoding: "utf8",
			timeout: APP_CHECK_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		return isTerminalReply(stdout);
	} catch {
		return false;
	}
}

/**
 * A terminal for typed commands (createSurface, createSplit): a shell child of the caller, notes off.
 * No name: hc names are 1-32 of a-z 0-9 - _ . and unique among live terminals, which Pi titles are not.
 */
function runShellTerminal(): string {
	const out = hcSync([
		"run",
		"--bg",
		"--no-notify",
		"--json",
		"--parent",
		callerTerminal(),
		"--cwd",
		process.cwd(),
		"--",
		process.env.SHELL || "/bin/sh",
	]);
	const address = (JSON.parse(out) as { address?: string }).address;
	if (!address) throw new Error(`hc run gave no terminal address: ${out.trim()}`);
	return address;
}

interface RpcReply {
	result?: { address?: string };
	error?: { message?: string; data?: { kind?: string } };
}

/** The request may have reached the core, but no reply came: the core may or may not have acted on it. */
class NoReplyError extends Error {}

/** Sends one JSON-RPC request through `hc connect` and returns its reply. */
function hcRequest(method: string, params: Record<string, unknown>): Promise<RpcReply> {
	return new Promise((resolve, reject) => {
		const child = spawn(HC_COMMAND, ["connect"], { stdio: ["pipe", "pipe", "ignore"] });
		const timer = setTimeout(() => {
			child.kill();
			reject(new NoReplyError(`hc connect gave no reply to ${method}`));
		}, START_REPLY_TIMEOUT_MS);
		let settled = false;
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		createInterface({ input: child.stdout }).once("line", (line) => {
			settle(() => {
				try {
					resolve(JSON.parse(line) as RpcReply);
				} catch {
					reject(new NoReplyError(`hc connect gave an invalid reply to ${method}`));
				}
				child.kill();
			});
		});
		child.on("error", (error) => settle(() => reject(error)));
		child.on("close", () => settle(() => reject(new NoReplyError(`hc connect closed without a reply to ${method}`))));
		child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
	});
}

/** Addresses of the terminals, finished ones included, that carry this launch label (`hc ls --all --label`). */
async function terminalsWithLabel(label: string): Promise<string[]> {
	const { stdout } = await execFileAsync(
		HC_COMMAND,
		["ls", "--all", "--label", `${HERDR_CORE_LAUNCH_LABEL_KEY}=${label}`, "--json"],
		{ encoding: "utf8", timeout: APP_CHECK_TIMEOUT_MS, killSignal: "SIGKILL" },
	);
	const terminals = (JSON.parse(stdout) as { terminals?: Array<{ address?: unknown }> }).terminals ?? [];
	return terminals
		.map((terminal) => terminal.address)
		.filter((address): address is string => typeof address === "string");
}

/**
 * After a start request without an answer (D27): looks the label up until the window ends and returns the
 * terminal only when exactly one carries it. It never sends a second start request, so a retry cannot make
 * a second child. A failed lookup counts as no terminal found yet.
 */
async function findStartedTerminal(label: string, cause: string): Promise<string> {
	const deadline = Date.now() + LABEL_LOOKUP_WINDOW_MS;
	for (;;) {
		const found = await terminalsWithLabel(label).catch(() => []);
		if (found.length === 1) return found[0];
		if (found.length > 1) throw new Error(`${cause}; ${found.length} terminals carry label ${label}, not one`);
		const left = deadline - Date.now();
		if (left <= 0) throw new Error(`${cause}; no terminal carries label ${label}`);
		await new Promise((resolve) => setTimeout(resolve, Math.min(LABEL_LOOKUP_INTERVAL_MS, left)));
	}
}

/** Sends the one start request; a request without an answer is followed by the label lookup only. */
async function runLauncherTerminal(launch: ProgramLaunch, label: string): Promise<string> {
	let reply: RpcReply;
	try {
		reply = await hcRequest("terminal.run", {
			argv: [...launch.launcherArgv],
			// Without a cwd hc runs the program in the core's own directory; the child runs in the parent cwd (README).
			cwd: launch.cwd ?? process.cwd(),
			labels: { [HERDR_CORE_LAUNCH_LABEL_KEY]: label },
			caller: callerTerminal(),
			no_notify: true,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof NoReplyError) return findStartedTerminal(label, message);
		throw new Error(`hc terminal.run failed for label ${label}: ${message}`);
	}
	const address = reply.result?.address;
	if (!address) throw new Error(`hc terminal.run failed for label ${label}: ${reply.error?.message ?? "no address"}`);
	return address;
}

/**
 * Starts the launcher with its capsule as the terminal's program (D27): the parent terminal is the
 * caller, notes are off, the label is unique to this launch, and no environment map is sent,
 * because herdr-core would add its daemon environment to it. The exit watch subscribes first.
 * No name: hc's name rule rejects Pi titles, and the label already identifies the launch.
 */
async function startLauncherTerminal(launch: ProgramLaunch, warn: (warning: string) => void): Promise<string> {
	const label = `launch-${randomUUID()}`;
	const watch = new LabelExitWatch(label);
	await watch.subscribe();
	try {
		const address = await runLauncherTerminal(launch, label);
		watch.attach(address);
		exitWatches.set(address, watch);
		await placeChildTerminal(address, callerTerminal(), warn);
		return address;
	} catch (error) {
		watch.stop();
		throw error;
	}
}

/** Reads the exit facts once, for a terminal without a live watch (for example after its stream failed). */
async function readExit(surface: string) {
	const facts = await readFinishedTerminal(surface);
	return facts ? exitFactsResult(facts) : null;
}

/** Kill, read the exit facts, then remove: a terminal is never removed before its facts are read (D27). */
async function closeTerminal(surface: string): Promise<void> {
	await execFileAsync(HC_COMMAND, ["kill", surface], { encoding: "utf8" }).catch(() => undefined);
	const watch = exitWatches.get(surface);
	let exit: PollResult | undefined;
	if (watch) {
		await watch.readOnce();
		exit = watch.exit;
		watch.stop();
	} else {
		const facts = await readFinishedTerminal(surface);
		exit = facts && exitFactsResult(facts);
	}
	if (!exit) throw new Error(`herdr-core terminal ${surface} has not finished after kill; not removed`);
	await execFileAsync(HC_COMMAND, ["rm", surface], { encoding: "utf8" });
	// The watch retires; hc no longer knows the terminal, so checkExit answers from the facts read here.
	exitWatches.delete(surface);
	removedExits.set(surface, exit);
}

/** herdr-core (the `hc` CLI inside an herdr-core terminal). A direct-program child gets a pane (D27). */
export const herdrCoreBackend: MuxBackendAdapter = {
	id: "herdr-core",
	isAvailable: () =>
		!!process.env.HC_TERMINAL_ID &&
		!!process.env.HC_TERMINAL_SOCKET &&
		defaultMuxRuntimeProbe.hasCommand(HC_COMMAND) &&
		appAnswers(process.env.HC_TERMINAL_ID),
	setupHint: () => "Start pi in a terminal of the Herdr app (herdr-core), with `hc` on PATH.",
	createSurface: async () => runShellTerminal(),
	createSplit: () => runShellTerminal(),
	sendCommand: (surface, command) => {
		hcSync(["send", surface, command]);
	},
	readScreen: (surface, lines) => tailLines(hcSync(["read", surface]), lines),
	readScreenAsync: async (surface, lines) => {
		const { stdout } = await execFileAsync(HC_COMMAND, ["read", surface], { encoding: "utf8" });
		return tailLines(stdout, lines);
	},
	closeSurface: (surface) => closeTerminal(surface),
	renameCurrentTab: (title) => {
		hcSync(["label", callerTerminal(), `${TITLE_LABEL_KEY}=${title}`]);
	},
	// herdr-core has no workspace to rename, so it has no renameWorkspace.
	paneIdentity: HERDR_CORE_PANE_IDENTITY,
	connectWorkReporter: (session) => createOscWorkReporter(session, "herdr-core", herdrCoreUsable),
	openProgramSession: async (): Promise<DirectProgramSession> => ({
		// herdr-core has no numeric pane; the caller terminal names the session.
		target: { sessionName: callerTerminal(), parentPaneId: 0 },
		childEnv: {},
		surfaceFromEnv: { name: "HC_TERMINAL_ID", prefix: "" },
		start: (_name, launch, options) => startLauncherTerminal(launch, options?.onPlacementWarning ?? (() => {})),
	}),
	checkExit: async (surface) => {
		const removed = removedExits.get(surface);
		if (removed) return removed;
		const watch = exitWatches.get(surface);
		if (!watch) return readExit(surface);
		// The watch owns recovery after a dropped stream; checkExit reads only when it could not subscribe again.
		if (!watch.exit && watch.lost) await watch.readOnce();
		return watch.exit ?? null;
	},
};
