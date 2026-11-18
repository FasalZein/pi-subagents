import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ProgramLaunch } from "../../src/mux/backend.ts";
import { herdrCoreBackend } from "../../src/mux/herdr-core.ts";
import { placeChildTerminal } from "../../src/mux/herdr-core-placement.ts";
import { writeExecutable } from "../support/index.ts";
import { FAKE_HC, FAKE_HC_CALLER, readFakeHcCalls, readFakeHcRequests, seedFakeHcCaller } from "./fake-hc.ts";
import {
	addFakeAppPane,
	FAKE_APP_OWNER_PANE,
	FAKE_APP_SPACE,
	FAKE_APP_TAB,
	FAKE_HERDR_APP,
	fakeAppPaneOf,
	fakeAppTabOf,
	readFakeAppCalls,
	readFakeAppFocus,
	seedFakeHerdrApp,
} from "./fake-herdr-app.ts";

const LAUNCH: ProgramLaunch = {
	shellCommand: "unused-by-herdr-core",
	launcherArgv: ["/usr/bin/node", "/repo/src/launch/run-child.mjs", "/tmp/pi-subagent-env-x/capsule.json"],
	cwd: "/work",
};

/** The split transaction of D27 for one child, as herdr-app calls (live check L2 sequence, then the status check). */
function splitTransaction(child: string, parent = FAKE_HC_CALLER): string[] {
	return [
		"herdr-app status",
		`herdr-app do pane.focus --terminal ${parent}`,
		`herdr-app do terminal.keep --terminal ${child} --place right`,
		`herdr-app do pane.focus --pane ${FAKE_APP_OWNER_PANE}`,
		"herdr-app status",
	];
}

/** The bound of each placement call in src/mux/herdr-core-placement.ts (5 s), plus process start slack. */
const PLACEMENT_CALL_BOUND_MS = 5_000;

describe("herdr-core placement in the Herdr app (T47, D27)", () => {
	let root = "";
	let stateDir = "";
	let saved = new Map<string, string | undefined>();
	let warnings: string[] = [];
	const started: string[] = [];

	function setEnv(key: string, value: string): void {
		if (!saved.has(key)) saved.set(key, process.env[key]);
		process.env[key] = value;
	}

	beforeEach(() => {
		saved = new Map();
		warnings = [];
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
		for (const name of ["hang-label", "fail-keep", "fail-restore", "focus-no-ok"])
			rmSync(join(stateDir, name), { force: true });
		for (const surface of started.splice(0)) await herdrCoreBackend.closeSurface(surface);
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	async function start(name: string): Promise<string> {
		const session = await herdrCoreBackend.openProgramSession!();
		const surface = await session.start(name, LAUNCH, { onPlacementWarning: (warning) => warnings.push(warning) });
		started.push(surface);
		return surface;
	}

	const appCalls = () => readFakeAppCalls(stateDir);
	const labelsOf = (address: string) =>
		(JSON.parse(readFileSync(join(stateDir, `term-${address}.json`), "utf8")) as { labels: Record<string, string> })
			.labels;
	const terminals = () => readdirSync(stateDir).filter((name) => name.startsWith("term-"));
	const tabLabelCalls = () => readFakeHcCalls(stateDir).filter((call) => call.startsWith("label "));
	/** A live hc terminal outside the launch path, for direct placement calls. */
	function seedTerminal(address: string, labels: Record<string, string> = {}): void {
		writeFileSync(
			join(stateDir, `term-${address}.json`),
			JSON.stringify({ address, labels, state: "live", exit_code: null, signal: null, reason: null }),
		);
	}

	it("reads the status, focuses the parent by address, keeps the child as a split, then restores and checks the focus", async () => {
		const child = await start("Split Child");
		assert.deepEqual(appCalls(), splitTransaction(child));
		assert.equal(
			fakeAppTabOf(stateDir, fakeAppPaneOf(stateDir, child)!),
			FAKE_APP_TAB,
			"the child is in the parent's tab",
		);
		assert.equal(readFakeAppFocus(stateDir), FAKE_APP_OWNER_PANE, "focus is back on the saved pane");
		assert.deepEqual(tabLabelCalls(), [], "no tab label after a split");
		assert.deepEqual(warnings, []);
	});

	it("gives the same terminal a tab through the parent's space label when the split fails", async () => {
		writeFileSync(join(stateDir, "fail-keep"), "");
		const child = await start("Tab Child");
		assert.deepEqual(appCalls(), splitTransaction(child), "the failed split still restores the saved focus");
		assert.equal(readFakeAppFocus(stateDir), FAKE_APP_OWNER_PANE);
		assert.equal(fakeAppPaneOf(stateDir, child), undefined, "no split pane");
		assert.equal(labelsOf(child)["herdr.space"], FAKE_APP_SPACE, "the parent's space label is on the child");
		assert.deepEqual(tabLabelCalls(), [`label ${child} herdr.space=${FAKE_APP_SPACE}`]);
		assert.equal(readFakeHcRequests(stateDir).length, 1, "one start request");
		assert.deepEqual(terminals().sort(), [`term-${child}.json`, `term-${FAKE_HC_CALLER}.json`].sort());
		assert.deepEqual(warnings, [], "a tab is a placement, not a warning");
	});

	it("does not count a parent focus without ok: true as focused, and takes the tab fallback", async () => {
		writeFileSync(join(stateDir, "focus-no-ok"), "");
		const child = await start("Unacknowledged Child");
		assert.deepEqual(appCalls(), [
			"herdr-app status",
			`herdr-app do pane.focus --terminal ${FAKE_HC_CALLER}`,
			`herdr-app do pane.focus --pane ${FAKE_APP_OWNER_PANE}`,
			"herdr-app status",
		]);
		assert.equal(fakeAppPaneOf(stateDir, child), undefined, "no keep after an unacknowledged focus");
		assert.equal(labelsOf(child)["herdr.space"], FAKE_APP_SPACE);
		assert.equal(readFakeAppFocus(stateDir), FAKE_APP_OWNER_PANE);
	});

	it("keeps the split and warns separately when the focus restore fails", async () => {
		writeFileSync(join(stateDir, "fail-restore"), "");
		const child = await start("Unrestored Child");
		assert.ok(fakeAppPaneOf(stateDir, child), "the split stands");
		assert.deepEqual(tabLabelCalls(), [], "a failed restore does not start the tab fallback");
		assert.equal(warnings.length, 1);
		assert.match(
			warnings[0]!,
			new RegExp(`focus was not restored to pane ${FAKE_APP_OWNER_PANE} after placing ${child}`),
		);
		assert.match(warnings[0]!, /focus refused/);
	});

	it("warns when split and tab both fail, and bounds the hung tab fallback", async () => {
		writeFileSync(join(stateDir, "fail-keep"), "");
		writeFileSync(join(stateDir, "hang-label"), "");
		const begin = Date.now();
		const child = await start("Hidden Child");
		const elapsed = Date.now() - begin;
		assert.ok(elapsed < PLACEMENT_CALL_BOUND_MS + 3_000, `start returned after ${elapsed} ms`);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, new RegExp(`child terminal ${child} runs without a pane in the Herdr app`));
		assert.match(warnings[0]!, /split failed \(.*"split failed".*\); tab failed \(.*no reply within 5000 ms\)/s);
		assert.equal(readFakeHcRequests(stateDir).length, 1, "no second terminal");
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
		const [a, b] = await Promise.all([start("Failing Child"), start("Second Child")]);
		const calls = appCalls();
		const firstKept = calls[2]?.includes(`--terminal ${a} `) ? a : b;
		const second = firstKept === a ? b : a;
		assert.deepEqual(calls, [...splitTransaction(firstKept), ...splitTransaction(second)]);
		assert.equal(readFakeAppFocus(stateDir), FAKE_APP_OWNER_PANE);
		for (const child of [a, b]) assert.equal(labelsOf(child)["herdr.space"], FAKE_APP_SPACE);
	});

	it("puts each child beside its own parent when two parents in different tabs place at once", async () => {
		const otherTab = "tbaaaa0011223344556677889900aabbcc";
		const otherPane = "paaaa0aa11bb22cc33dd44ee55ff66778";
		seedTerminal("t50", { "herdr.space": FAKE_APP_SPACE, "herdr.tab": otherTab });
		addFakeAppPane(stateDir, "t50", otherPane, otherTab);
		seedTerminal("t51");
		seedTerminal("t52");
		// Each app reply takes 150 ms, so an interleaved transaction would keep a child in the other parent's tab.
		setEnv("FAKE_HERDR_APP_DELAY_MS", "150");
		await Promise.all([
			placeChildTerminal("t51", FAKE_HC_CALLER, (warning) => warnings.push(warning)),
			placeChildTerminal("t52", "t50", (warning) => warnings.push(warning)),
		]);
		assert.equal(fakeAppTabOf(stateDir, fakeAppPaneOf(stateDir, "t51")!), FAKE_APP_TAB, "t51 beside parent t1");
		assert.equal(fakeAppTabOf(stateDir, fakeAppPaneOf(stateDir, "t52")!), otherTab, "t52 beside parent t50");
		assert.equal(labelsOf("t51")["herdr.tab"], FAKE_APP_TAB);
		assert.equal(labelsOf("t52")["herdr.tab"], otherTab);
		assert.equal(readFakeAppFocus(stateDir), FAKE_APP_OWNER_PANE);
		assert.deepEqual(warnings, []);
	});
});
