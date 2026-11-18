import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ProgramLaunch } from "../../src/mux/backend.ts";
import { herdrCoreBackend } from "../../src/mux/herdr-core.ts";
import { writeExecutable } from "../support/index.ts";
import { FAKE_HC, FAKE_HC_CALLER, readFakeHcCalls, readFakeHcRequests, seedFakeHcCaller } from "./fake-hc.ts";
import {
	FAKE_APP_OWNER_PANE,
	FAKE_APP_SPACE,
	FAKE_HERDR_APP,
	fakeAppPaneOf,
	readFakeAppCalls,
	readFakeAppFocus,
	seedFakeHerdrApp,
} from "./fake-herdr-app.ts";

const LAUNCH: ProgramLaunch = {
	shellCommand: "unused-by-herdr-core",
	launcherArgv: ["/usr/bin/node", "/repo/src/launch/run-child.mjs", "/tmp/pi-subagent-env-x/capsule.json"],
	cwd: "/work",
};

/** The split transaction of D27 for one child, as herdr-app calls (live check L2 sequence). */
function splitTransaction(child: string): string[] {
	return [
		"herdr-app status",
		`herdr-app do pane.focus --terminal ${FAKE_HC_CALLER}`,
		`herdr-app do terminal.keep --terminal ${child} --place right`,
		`herdr-app do pane.focus --pane ${FAKE_APP_OWNER_PANE}`,
	];
}

describe("herdr-core placement in the Herdr app (T47, D27)", () => {
	let root = "";
	let stateDir = "";
	let saved = new Map<string, string | undefined>();
	const started: string[] = [];

	function setEnv(key: string, value: string): void {
		if (!saved.has(key)) saved.set(key, process.env[key]);
		process.env[key] = value;
	}

	beforeEach(() => {
		saved = new Map();
		root = mkdtempSync(join(tmpdir(), "herdr-core-placement-"));
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
	});

	afterEach(async () => {
		for (const surface of started.splice(0)) await herdrCoreBackend.closeSurface(surface);
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	async function start(name: string): Promise<string> {
		const session = await herdrCoreBackend.openProgramSession!();
		const surface = await session.start(name, LAUNCH);
		started.push(surface);
		return surface;
	}

	const appCalls = () => readFakeAppCalls(stateDir);
	const labelsOf = (address: string) =>
		(JSON.parse(readFileSync(join(stateDir, `term-${address}.json`), "utf8")) as { labels: Record<string, string> })
			.labels;
	const terminals = () => readdirSync(stateDir).filter((name) => name.startsWith("term-"));

	it("reads the status, focuses the parent by address, keeps the child as a split, then focuses the saved pane", async () => {
		const child = await start("Split Child");
		assert.deepEqual(appCalls(), splitTransaction(child));
		assert.ok(fakeAppPaneOf(stateDir, child), "the child has a pane");
		assert.equal(readFakeAppFocus(stateDir), FAKE_APP_OWNER_PANE, "focus is back on the saved pane");
		assert.equal(
			readFakeHcCalls(stateDir).some((call) => call.startsWith("label ")),
			false,
			"no tab label after a split",
		);
	});

	it("gives the same terminal a tab through the parent's space label when the split fails", async () => {
		writeFileSync(join(stateDir, "fail-keep"), "");
		const child = await start("Tab Child");
		assert.deepEqual(appCalls(), splitTransaction(child), "the failed split still restores the saved focus");
		assert.equal(readFakeAppFocus(stateDir), FAKE_APP_OWNER_PANE);
		assert.equal(fakeAppPaneOf(stateDir, child), undefined, "no split pane");
		assert.equal(labelsOf(child)["herdr.space"], FAKE_APP_SPACE, "the parent's space label is on the child");
		assert.ok(readFakeHcCalls(stateDir).includes(`label ${child} herdr.space=${FAKE_APP_SPACE}`));
		assert.equal(readFakeHcRequests(stateDir).length, 1, "one start request");
		assert.deepEqual(terminals().sort(), [`term-${child}.json`, `term-${FAKE_HC_CALLER}.json`].sort());
	});

	it("runs overlapping focus transactions on one app one after the other", async () => {
		// Each app reply takes 150 ms, so two unserialized transactions would interleave their calls.
		setEnv("FAKE_HERDR_APP_DELAY_MS", "150");
		const [a, b] = await Promise.all([start("Child A"), start("Child B")]);
		const calls = appCalls();
		const firstKept = calls[2]?.includes(`--terminal ${a} `) ? a : b;
		const second = firstKept === a ? b : a;
		assert.deepEqual(calls, [...splitTransaction(firstKept), ...splitTransaction(second)]);
		assert.equal(readFakeAppFocus(stateDir), FAKE_APP_OWNER_PANE);
	});

	it("restores the saved focus when a step of the first transaction fails, then runs the next one", async () => {
		setEnv("FAKE_HERDR_APP_DELAY_MS", "100");
		writeFileSync(join(stateDir, "fail-keep"), "");
		const first = start("Failing Child");
		// The split of the first child fails while the second launch waits for the transaction.
		const [a, b] = await Promise.all([first, start("Second Child")]);
		const calls = appCalls();
		const firstKept = calls[2]?.includes(`--terminal ${a} `) ? a : b;
		const second = firstKept === a ? b : a;
		assert.deepEqual(calls, [...splitTransaction(firstKept), ...splitTransaction(second)]);
		assert.equal(readFakeAppFocus(stateDir), FAKE_APP_OWNER_PANE);
		for (const child of [a, b]) assert.equal(labelsOf(child)["herdr.space"], FAKE_APP_SPACE);
	});
});
