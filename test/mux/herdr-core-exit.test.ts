import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { MuxSessionTarget, ProgramLaunch } from "../../src/mux/backend.ts";
import { HERDR_CORE_LAUNCH_LABEL_KEY } from "../../src/mux/herdr-core-exit.ts";
import { herdrCoreBackend } from "../../src/mux/herdr-core.ts";
import { writeExecutable } from "../support/index.ts";
import {
	FAKE_HC,
	FAKE_HC_CALLER,
	finishFakeTerminal,
	readFakeHcCalls,
	readFakeHcRequests,
	seedFakeHcCaller,
} from "./fake-hc.ts";
import { readTypedText } from "./fake-terminal-state.ts";

const LAUNCH: ProgramLaunch = {
	shellCommand: "unused-by-herdr-core",
	launcherArgv: ["/usr/bin/node", "/repo/src/launch/run-child.mjs", "/tmp/pi-subagent-env-x/capsule.json"],
	cwd: "/work",
};
const WAIT_MS = 5_000;

async function eventually<T>(read: () => Promise<T | null | undefined> | T | null | undefined, what: string): Promise<T> {
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
		seedFakeHcCaller(stateDir);
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

	async function start(): Promise<string> {
		const session = await herdrCoreBackend.openProgramSession!();
		target = session.target;
		assert.deepEqual(session.surfaceFromEnv, { name: "HC_TERMINAL_ID", prefix: "" });
		return session.start("Exit Child", LAUNCH);
	}

	const checkExit = (surface: string) => herdrCoreBackend.checkExit!(surface, target);

	it("starts the launcher as program with caller, notes off, a unique label and no env map", async () => {
		const first = await start();
		const second = await start();
		const requests = readFakeHcRequests(stateDir);
		assert.equal(requests.length, 2);
		const labels = requests.map((request) => (request.params.labels as Record<string, string>)[HERDR_CORE_LAUNCH_LABEL_KEY]);
		assert.notEqual(labels[0], labels[1]);
		for (const [index, request] of requests.entries()) {
			assert.equal(request.method, "terminal.run");
			assert.deepEqual(Object.keys(request.params).sort(), ["argv", "caller", "cwd", "labels", "name", "no_notify"]);
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
		assert.equal(readFakeHcCalls(stateDir).some((call) => call.startsWith("get ")), false, "the event alone ends the watch");
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

	it("closes by kill, then reads the exit facts, then removes", async () => {
		const surface = await start();
		await herdrCoreBackend.closeSurface(surface, target);
		const calls = readFakeHcCalls(stateDir).filter((call) => !call.startsWith("events") && !call.startsWith("connect"));
		assert.deepEqual(calls, [`kill ${surface}`, `get ${surface} --json`, `rm ${surface}`]);
		const exit = await checkExit(surface);
		assert.equal(exit?.exitCode, 1);
	});
});
