import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { MuxSessionTarget, ProgramLaunch } from "../../src/mux/backend.ts";
import { herdrCoreBackend } from "../../src/mux/herdr-core.ts";
import { HERDR_CORE_LAUNCH_LABEL_KEY } from "../../src/mux/herdr-core-exit.ts";
import { writeExecutable } from "../support/index.ts";
import {
	FAKE_HC,
	FAKE_HC_CALLER,
	FAKE_HC_DAEMON_CWD,
	finishFakeTerminal,
	readFakeHcCalls,
	readFakeHcRequests,
	seedFakeHcCaller,
} from "./fake-hc.ts";
import { FAKE_HERDR_APP, seedFakeHerdrApp } from "./fake-herdr-app.ts";
import { readTypedText } from "./fake-terminal-state.ts";

const LAUNCH: ProgramLaunch = {
	shellCommand: "unused-by-herdr-core",
	launcherArgv: ["/usr/bin/node", "/repo/src/launch/run-child.mjs", "/tmp/pi-subagent-env-x/capsule.json"],
	cwd: "/work",
};
const WAIT_MS = 5_000;

async function eventually<T>(
	read: () => Promise<T | null | undefined> | T | null | undefined,
	what: string,
): Promise<T> {
	const deadline = Date.now() + WAIT_MS;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== null && value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${what}`);
}

describe("herdr-core launch and exit (T45, D27)", () => {
	let root = "";
	let stateDir = "";
	let saved = new Map<string, string | undefined>();
	let target: MuxSessionTarget;

	function setEnv(key: string, value: string): void {
		if (!saved.has(key)) saved.set(key, process.env[key]);
		process.env[key] = value;
	}

	beforeEach(() => {
		saved = new Map();
		root = mkdtempSync(join(tmpdir(), "herdr-core-exit-"));
		stateDir = join(root, "state");
		const binDir = join(root, "bin");
		mkdirSync(stateDir);
		mkdirSync(binDir);
		writeExecutable(binDir, "hc", FAKE_HC);
		// The child gets its split in the app; placement itself is covered in herdr-core-placement.test.ts.
		writeExecutable(binDir, "herdr-app", FAKE_HERDR_APP);
		seedFakeHcCaller(stateDir);
		seedFakeHerdrApp(stateDir, FAKE_HC_CALLER);
		setEnv("FAKE_TERMINAL_STATE", stateDir);
		setEnv("HC_TERMINAL_ID", FAKE_HC_CALLER);
		setEnv("HC_TERMINAL_SOCKET", join(stateDir, "hc.sock"));
		setEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
	});

	afterEach(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	async function start(name = "Exit Child", launch: ProgramLaunch = LAUNCH): Promise<string> {
		const session = await herdrCoreBackend.openProgramSession!();
		target = session.target;
		assert.deepEqual(session.surfaceFromEnv, { name: "HC_TERMINAL_ID", prefix: "" });
		return session.start(name, launch);
	}

	const terminalState = (address: string) =>
		JSON.parse(readFileSync(join(stateDir, `term-${address}.json`), "utf8")) as Record<string, unknown>;

	const checkExit = (surface: string) => herdrCoreBackend.checkExit!(surface, target);

	it("starts the launcher as program with caller, notes off, a unique label and no env map", async () => {
		const first = await start();
		const second = await start();
		const requests = readFakeHcRequests(stateDir);
		assert.equal(requests.length, 2);
		const labels = requests.map(
			(request) => (request.params.labels as Record<string, string>)[HERDR_CORE_LAUNCH_LABEL_KEY],
		);
		assert.notEqual(labels[0], labels[1]);
		for (const [index, request] of requests.entries()) {
			assert.equal(request.method, "terminal.run");
			assert.deepEqual(Object.keys(request.params).sort(), ["argv", "caller", "cwd", "labels", "no_notify"]);
			assert.deepEqual(request.params.argv, LAUNCH.launcherArgv);
			assert.equal(request.params.caller, FAKE_HC_CALLER);
			assert.equal(request.params.no_notify, true);
			assert.equal(request.params.cwd, "/work");
			assert.match(labels[index]!, /^launch-[0-9a-f-]{36}$/);
		}
		// The label subscription comes before each start; nothing is typed into a shell.
		const calls = readFakeHcCalls(stateDir);
		assert.deepEqual(
			calls.map((call) => call.split(" ")[0]),
			["events", "connect", "events", "connect"],
		);
		assert.equal(calls[0], `events --label ${HERDR_CORE_LAUNCH_LABEL_KEY}=${labels[0]} --json`);
		assert.equal(readTypedText(stateDir, first), "");
		assert.equal(readTypedText(stateDir, second), "");
		await herdrCoreBackend.closeSurface(first, target);
		await herdrCoreBackend.closeSurface(second, target);
	});

	it("ends the watch with exit code 7 from the finished event", async () => {
		const surface = await start();
		assert.equal(await checkExit(surface), null);
		finishFakeTerminal(stateDir, surface, 7);
		const exit = await eventually(() => checkExit(surface), "the finished event");
		assert.equal(exit.exitCode, 7);
		assert.equal(
			readFakeHcCalls(stateDir).some((call) => call.startsWith("get ")),
			false,
			"the event alone ends the watch",
		);
	});

	it("after a dropped stream subscribes again first, then reads the state once", async () => {
		const surface = await start();
		writeFileSync(join(stateDir, "drop"), "");
		await eventually(() => readFakeHcCalls(stateDir).find((call) => call.startsWith("get ")), "the state read");
		const calls = readFakeHcCalls(stateDir).map((call) => call.split(" ")[0]);
		assert.deepEqual(calls, ["events", "connect", "events", "get"]);
		assert.equal(await checkExit(surface), null);
		finishFakeTerminal(stateDir, surface, 7);
		assert.equal((await eventually(() => checkExit(surface), "the event on the new stream")).exitCode, 7);
	});

	it("a terminal that finished while the stream was down still ends the watch with its exit facts", async () => {
		const surface = await start();
		// The finished event falls into the gap: no stream sees it, only the state read can.
		finishFakeTerminal(stateDir, surface, 7, false);
		writeFileSync(join(stateDir, "drop"), "");
		assert.equal((await eventually(() => checkExit(surface), "the exit facts from the read")).exitCode, 7);
		assert.equal(readFakeHcCalls(stateDir).includes(`rm ${surface}`), false, "the watch never removes the terminal");
	});

	// Review P1: hc names are 1-32 of a-z 0-9 - _ . and Pi titles are not; the label identifies the launch.
	it("starts a child and a shell terminal whose title hc would reject as a name", async () => {
		const surface = await start("[reviewer] Review changes");
		assert.equal(terminalState(surface).state, "live");
		const shell = await herdrCoreBackend.createSurface("[reviewer] Review changes");
		assert.equal(terminalState(shell).parent, FAKE_HC_CALLER);
		// A live watch outlives the test's state folder and would subscribe again into the next test's fake.
		await herdrCoreBackend.closeSurface(surface, target);
		await herdrCoreBackend.closeSurface(shell, target);
	});

	// Review P1: without a cwd hc runs the program in the core's working directory, not the parent's.
	it("starts the launcher in the parent cwd when the launch has no cwd override", async () => {
		assert.notEqual(process.cwd(), FAKE_HC_DAEMON_CWD);
		const surface = await start("Exit Child", { shellCommand: LAUNCH.shellCommand, launcherArgv: LAUNCH.launcherArgv });
		assert.equal(terminalState(surface).cwd, process.cwd());
		await herdrCoreBackend.closeSurface(surface, target);
	});

	// Review P1: hc's Terminal schema has an integer signal; SIGTERM (15) with no exit code is 128 + 15.
	it("maps an integer signal without exit code to 143, from the finished event and from the state read", async () => {
		const byEvent = await start();
		finishFakeTerminal(stateDir, byEvent, { signal: 15 });
		assert.equal((await eventually(() => checkExit(byEvent), "the finished event")).exitCode, 143);

		const byRead = await start();
		finishFakeTerminal(stateDir, byRead, { signal: 15 }, false);
		writeFileSync(join(stateDir, "drop"), "");
		assert.equal((await eventually(() => checkExit(byRead), "the exit facts from the read")).exitCode, 143);
	});

	// Review P1: the stream drops during the start, the launcher exits before the replacement snapshot, and the
	// run reply comes late. One owner recovers: exactly one state read, after the new subscription.
	it("ends the watch with exit 7 when the stream drops during a start whose reply comes late", async () => {
		writeFileSync(join(stateDir, "hold-run"), "");
		const starting = start();
		const surface = await eventually(
			() => (existsSync(join(stateDir, "term-t2.json")) ? "t2" : undefined),
			"the started terminal",
		);
		// The launcher exits and the stream drops before any replacement subscription exists: no stream sees
		// the finished event (emitted, the old stream could read it between the two writes).
		finishFakeTerminal(stateDir, surface, 7, false);
		writeFileSync(join(stateDir, "drop"), "");
		const kinds = () => readFakeHcCalls(stateDir).map((call) => call.split(" ")[0]);
		await eventually(
			() => (kinds().filter((kind) => kind === "events").length === 2 ? true : undefined),
			"the new subscription",
		);
		assert.deepEqual(kinds(), ["events", "connect", "events"], "no state read before the run reply");
		rmSync(join(stateDir, "hold-run"));
		assert.equal(await starting, surface);
		assert.equal((await eventually(() => checkExit(surface), "the exit facts")).exitCode, 7);
		// The child finished before its split, so placement falls back to the tab label: it reads the parent
		// (get t1) and labels the child. Those calls are not exit-state reads.
		const exitCalls = readFakeHcCalls(stateDir)
			.filter((call) => call !== `get ${FAKE_HC_CALLER} --json` && !call.startsWith("label "))
			.map((call) => call.split(" ")[0]);
		assert.deepEqual(exitCalls, ["events", "connect", "events", "get"]);
	});

	it("closes by kill, then reads the exit facts, then removes", async () => {
		const surface = await start();
		await herdrCoreBackend.closeSurface(surface, target);
		const calls = readFakeHcCalls(stateDir).filter((call) => !call.startsWith("events") && !call.startsWith("connect"));
		// The exit facts come from the finished event of the kill or, when the event is not in yet, from one read.
		const expected = calls.includes(`get ${surface} --json`)
			? [`kill ${surface}`, `get ${surface} --json`, `rm ${surface}`]
			: [`kill ${surface}`, `rm ${surface}`];
		assert.deepEqual(calls, expected);
		const exit = await checkExit(surface);
		assert.equal(exit?.exitCode, 1);
	});
});
