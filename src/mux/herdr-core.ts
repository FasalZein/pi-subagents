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
import { defaultMuxRuntimeProbe } from "./runtime-probe.ts";

const START_REPLY_TIMEOUT_MS = 10_000;
/** Bound of the detection call: the same 2,000 ms as old herdr's bounded CLI calls (runHerdrJsonAsync). */
const APP_CHECK_TIMEOUT_MS = 2_000;
/** Label that carries the title of the caller terminal; herdr-core has no tab or workspace of its own. */
const TITLE_LABEL_KEY = "pi-subagents.title";

/** Exit watches of the direct-program terminals of this process, by terminal address. */
const exitWatches = new Map<string, LabelExitWatch>();

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
		const terminal = JSON.parse(
			execFileSync(HC_COMMAND, ["get", caller, "--json"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: APP_CHECK_TIMEOUT_MS,
				killSignal: "SIGKILL",
			}),
		) as { address?: unknown };
		return typeof terminal.address === "string";
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

/** Sends one JSON-RPC request through `hc connect` and returns its reply. */
function hcRequest(method: string, params: Record<string, unknown>): Promise<RpcReply> {
	return new Promise((resolve, reject) => {
		const child = spawn(HC_COMMAND, ["connect"], { stdio: ["pipe", "pipe", "ignore"] });
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`hc connect gave no reply to ${method}`));
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
					reject(new Error(`hc connect gave an invalid reply to ${method}`));
				}
				child.kill();
			});
		});
		child.on("error", (error) => settle(() => reject(error)));
		child.on("close", () => settle(() => reject(new Error(`hc connect closed without a reply to ${method}`))));
		child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
	});
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
		const reply = await hcRequest("terminal.run", {
			argv: [...launch.launcherArgv],
			// Without a cwd hc runs the program in the core's own directory; the child runs in the parent cwd (README).
			cwd: launch.cwd ?? process.cwd(),
			labels: { [HERDR_CORE_LAUNCH_LABEL_KEY]: label },
			caller: callerTerminal(),
			no_notify: true,
		});
		const address = reply.result?.address;
		if (!address) throw new Error(`hc terminal.run failed for label ${label}: ${reply.error?.message ?? "no address"}`);
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
	if (watch) {
		await watch.readOnce();
		if (!watch.exit) throw new Error(`herdr-core terminal ${surface} has not finished after kill; not removed`);
		watch.stop();
	} else if (!(await readFinishedTerminal(surface))) {
		throw new Error(`herdr-core terminal ${surface} has not finished after kill; not removed`);
	}
	await execFileAsync(HC_COMMAND, ["rm", surface], { encoding: "utf8" });
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
	// herdr-core has no workspace to rename.
	renameWorkspace: () => {},
	paneIdentity: HERDR_CORE_PANE_IDENTITY,
	openProgramSession: async (): Promise<DirectProgramSession> => ({
		// herdr-core has no numeric pane; the caller terminal names the session.
		target: { sessionName: callerTerminal(), parentPaneId: 0 },
		childEnv: {},
		surfaceFromEnv: { name: "HC_TERMINAL_ID", prefix: "" },
		start: (_name, launch, options) => startLauncherTerminal(launch, options?.onPlacementWarning ?? (() => {})),
	}),
	checkExit: async (surface) => {
		const watch = exitWatches.get(surface);
		if (!watch) return readExit(surface);
		// The watch owns recovery after a dropped stream; checkExit reads only when it could not subscribe again.
		if (!watch.exit && watch.lost) await watch.readOnce();
		return watch.exit ?? null;
	},
};
