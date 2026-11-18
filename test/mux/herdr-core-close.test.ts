import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { MuxSessionTarget, ProgramLaunch } from "../../src/mux/backend.ts";
import { herdrCoreBackend, stopExitWatchesForTest } from "../../src/mux/herdr-core.ts";
import { HERDR_CORE_LAUNCH_LABEL_KEY } from "../../src/mux/herdr-core-exit.ts";
import {
	resetSubagentStateForTest,
	setRunningSubagentForTest,
	shutdownSubagentsForTest,
	writeExecutable,
} from "../support/index.ts";
import { FAKE_HC, FAKE_HC_CALLER, readFakeHcCalls, readFakeHcRequests, seedFakeHcCaller } from "./fake-hc.ts";
import { FAKE_HERDR_APP, seedFakeHerdrApp } from "./fake-herdr-app.ts";

const LAUNCH: ProgramLaunch = {
	shellCommand: "unused-by-herdr-core",
	launcherArgv: ["/usr/bin/node", "/repo/src/launch/run-child.mjs", "/tmp/pi-subagent-env-x/capsule.json"],
	cwd: "/work",
};
/**
 * Delay before a terminal made by a lost start appears in hc ls. It lies inside the lookup window of D27 (the
 * 2,000 ms app-check bound) and after the first lookup, so only a repeated lookup finds it.
 */
const LATE_TERMINAL_MS = 1_500;

describe("herdr-core close, lost replies and parent close (T46, D27)", () => {
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
		root = mkdtempSync(join(tmpdir(), "herdr-core-close-"));
		stateDir = join(root, "state");
		const binDir = join(root, "bin");
		mkdirSync(stateDir);
		mkdirSync(binDir);
		writeExecutable(binDir, "hc", FAKE_HC);
		writeExecutable(binDir, "herdr-app", FAKE_HERDR_APP);
		seedFakeHcCaller(stateDir);
		seedFakeHerdrApp(stateDir, FAKE_HC_CALLER);
		setEnv("FAKE_TERMINAL_STATE", stateDir);
		setEnv("HC_TERMINAL_ID", FAKE_HC_CALLER);
		setEnv("HC_TERMINAL_SOCKET", join(stateDir, "hc.sock"));
		setEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
		setEnv("PI_SUBAGENT_MUX", "herdr-core");
	});

	afterEach(() => {
		resetSubagentStateForTest();
		stopExitWatchesForTest();
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	async function start(): Promise<string> {
		const session = await herdrCoreBackend.openProgramSession!();
		target = session.target;
		return session.start("Close Child", LAUNCH);
	}

	const startRequests = () => readFakeHcRequests(stateDir).filter((request) => request.method === "terminal.run");
	const launchLabel = (request: { params: Record<string, unknown> }) =>
		(request.params.labels as Record<string, string>)[HERDR_CORE_LAUNCH_LABEL_KEY]!;
	const terminalFiles = () => readdirTerminals(stateDir).filter((address) => address !== FAKE_HC_CALLER);
	const terminalState = (address: string) =>
		JSON.parse(readFileSync(join(stateDir, `term-${address}.json`), "utf8")) as Record<string, unknown>;
	const killAndRemoveCalls = () =>
		readFakeHcCalls(stateDir).filter((call) => call.startsWith("kill ") || call.startsWith("rm "));

	it("closes by kill, then remove, of the child's terminal only, and retires its exit watch", async () => {
		const child = await start();
		const sibling = await start();
		await herdrCoreBackend.closeSurface(child, target);
		assert.deepEqual(killAndRemoveCalls(), [`kill ${child}`, `rm ${child}`]);
		assert.equal(terminalState(sibling).state, "live");
		// The watch retired with the terminal; checkExit answers from the facts read before the removal and
		// asks hc nothing more.
		const callsBefore = readFakeHcCalls(stateDir).length;
		assert.equal((await herdrCoreBackend.checkExit!(child, target))?.exitCode, 1);
		assert.equal(readFakeHcCalls(stateDir).length, callsBefore);
	});

	it("uses the one terminal found by label when the start reply is lost after the terminal was made", async () => {
		writeFileSync(join(stateDir, "lose-reply"), "create");
		const surface = await start();
		assert.equal(startRequests().length, 1);
		assert.deepEqual(terminalFiles(), [surface]);
		assert.equal(
			launchLabel(startRequests()[0]!),
			(terminalState(surface).labels as Record<string, string>)[HERDR_CORE_LAUNCH_LABEL_KEY],
		);
	});

	it("fails, names the label and sends no second start when the lost start made no terminal", async () => {
		writeFileSync(join(stateDir, "lose-reply"), "none");
		await assert.rejects(start(), (error: Error) => {
			const label = launchLabel(startRequests()[0]!);
			assert.ok(error.message.includes(label), error.message);
			return true;
		});
		assert.equal(startRequests().length, 1);
		assert.deepEqual(terminalFiles(), []);
	});

	it("finds a terminal that appears in the lookup only after a delay inside the window", async () => {
		writeFileSync(join(stateDir, "lose-reply"), `delay:${LATE_TERMINAL_MS}`);
		const surface = await start();
		assert.equal(startRequests().length, 1);
		assert.deepEqual(terminalFiles(), [surface]);
		const lookups = readFakeHcCalls(stateDir).filter((call) => call.startsWith("ls "));
		assert.ok(lookups.length > 1, `the first lookup misses the late terminal: ${lookups.length} lookups`);
	});

	it("names the label when the start request fails without reaching hc", async () => {
		setEnv("PATH", "/nonexistent");
		// The label subscription needs hc too, so it fails first; its error names the label as well.
		await assert.rejects(start(), /launch-[0-9a-f-]{36}/);
	});

	it("kills a default-policy child at parent shutdown and leaves a continue child running", async () => {
		const terminate = await start();
		const keep = await start();
		const child = (id: string, surface: string, parentClosePolicy: "terminate" | "continue") => ({
			id,
			name: id,
			task: "Run until the parent closes",
			mode: "interactive" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy,
			startTime: Date.now(),
			sessionFile: join(root, `${id}.jsonl`),
			abortController: new AbortController(),
			surface,
		});
		setRunningSubagentForTest(child("default-child", terminate, "terminate"));
		setRunningSubagentForTest(child("continue-child", keep, "continue"));
		await shutdownSubagentsForTest({ escalationMs: 10 });
		assert.deepEqual(killAndRemoveCalls(), [`kill ${terminate}`, `rm ${terminate}`]);
		assert.equal(terminalState(keep).state, "live");
	});
});

function readdirTerminals(stateDir: string): string[] {
	return readdirSync(stateDir)
		.filter((name) => name.startsWith("term-") && name.endsWith(".json"))
		.map((name) => name.slice("term-".length, -".json".length))
		.sort();
}
