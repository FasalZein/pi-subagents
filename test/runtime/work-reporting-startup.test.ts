import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerOutstandingWorkReporting } from "../../src/runtime/work-reporting.ts";
import { createTestDir, writeExecutable } from "../support/index.ts";

// Differential checks of the default reporter connection against its c8cb9af behaviour:
// no CLI call outside an eligible TUI, only bounded asynchronous discovery, and the
// HERDR_BIN_PATH binary without a herdr on PATH. A recording fake herdr stands in for the CLI.

const STATUS_HANG_MS = 5000;
const DISCOVERY_TIMEOUT_MS = 2000;

/** A fake herdr that logs each call; status answers protocol 22 after the given delay. */
function fakeHerdr(dir: string, statusDelayMs: number): { bin: string; calls: () => string[][] } {
	const log = join(dir, "calls.jsonl");
	const bin = writeExecutable(
		dir,
		"herdr",
		`#!${process.execPath}
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const out = (value) => process.stdout.write(JSON.stringify(value));
const command = args.slice(0, 2).join(" ");
if (command === "status server") setTimeout(() => out({ running: true, compatible: true, protocol: 22 }), ${statusDelayMs});
else if (command === "pane current") out({ result: { pane: { pane_id: "pane-7" } } });
else out({ result: {} });
`,
	);
	const calls = () => {
		try {
			return readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		} catch {
			return [];
		}
	};
	return { bin, calls };
}

const VARS = [
	"PATH",
	"HERDR_ENV",
	"HERDR_PANE_ID",
	"HERDR_BIN_PATH",
	"PI_SUBAGENT_MUX",
	"PI_SUBAGENT_NAME",
	"PI_SUBAGENT_SURFACE",
	"HC_TERMINAL_ID",
	"HC_TERMINAL_SOCKET",
	"REX_SESSION",
	"REX_BLOCK",
	"REX_BIN_DIR",
];

/** Run one session start through the default connection with the given process environment. */
async function startDefault(t: { after(fn: () => void): void }, mode: string, env: Record<string, string>) {
	const saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
	// Host markers (HC_*, REX_*) are cleared and the backend is pinned, so only the fake herdr can report.
	for (const name of VARS) delete process.env[name];
	Object.assign(process.env, { PI_SUBAGENT_MUX: "herdr", ...env });
	t.after(() => {
		for (const name of VARS) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
	});
	// SAFETY: The reporting lifecycle only registers event handlers on this Pi boundary.
	const pi = { on: () => {} } as unknown as ExtensionAPI;
	// SAFETY: The reporting lifecycle only reads mode, session identity and idleness from this context.
	const ctx = {
		mode,
		sessionManager: { getSessionFile: () => "parent.jsonl" },
		isIdle: () => true,
	} as unknown as ExtensionContext;
	const reporting = registerOutstandingWorkReporting(pi);
	const before = performance.now();
	const ready = reporting.start(ctx);
	const syncMs = performance.now() - before;
	await ready;
	const readyMs = performance.now() - before;
	t.after(() => reporting.stop());
	return { syncMs, readyMs, stop: () => reporting.stop() };
}

function tempDirs(t: { after(fn: () => void): void }) {
	const root = createTestDir();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	const empty = join(root, "empty");
	mkdirSync(bin);
	mkdirSync(empty);
	return { bin, empty };
}

for (const mode of ["print", "json", "rpc"]) {
	test(`${mode} session start in a herdr pane runs no herdr call`, async (t) => {
		const dirs = tempDirs(t);
		const herdr = fakeHerdr(dirs.bin, 0);
		await startDefault(t, mode, { PATH: dirs.bin, HERDR_ENV: "1", HERDR_PANE_ID: "pane-7" });
		assert.deepEqual(herdr.calls(), []);
	});
}

test("TUI session start discovers herdr asynchronously within the discovery timeout", async (t) => {
	const dirs = tempDirs(t);
	const herdr = fakeHerdr(dirs.bin, STATUS_HANG_MS);
	const { syncMs, readyMs } = await startDefault(t, "tui", { PATH: dirs.bin, HERDR_ENV: "1", HERDR_PANE_ID: "pane-7" });
	assert.ok(syncMs < 500, `session start blocked for ${Math.round(syncMs)} ms`);
	assert.ok(readyMs < DISCOVERY_TIMEOUT_MS + 1500, `discovery took ${Math.round(readyMs)} ms`);
	assert.deepEqual(herdr.calls(), [["status", "server", "--json"]]);
});

/** A fake rex at the tested API revision: a host Rex that would accept the OSC reporter. */
const HOST_REX = `#!/bin/sh
[ "$1" = whoami ] && { echo '{"api_revision":16}'; exit 0; }
exit 1
`;

test("TUI cases on a Herdr app or Rex host write no OSC record to stdout", async (t) => {
	const dirs = tempDirs(t);
	const hostRex = join(dirs.empty, "..", "host-rex");
	mkdirSync(hostRex);
	writeExecutable(hostRex, "rex", HOST_REX);
	const host = {
		HC_TERMINAL_ID: "t1",
		HC_TERMINAL_SOCKET: join(hostRex, "hc.sock"),
		REX_SESSION: "s1",
		REX_BLOCK: "b1",
		REX_BIN_DIR: hostRex,
	};
	const saved = Object.fromEntries(Object.keys(host).map((name) => [name, process.env[name]]));
	Object.assign(process.env, host);
	// A recording terminal stands in for stdout: no live pane, and a record never reaches the runner's output.
	const stdout = process.stdout as { isTTY?: boolean; write: typeof process.stdout.write };
	const { isTTY, write } = stdout;
	const written: string[] = [];
	stdout.isTTY = true;
	stdout.write = ((chunk: string | Uint8Array) => written.push(String(chunk)) > 0) as typeof process.stdout.write;
	t.after(() => {
		stdout.isTTY = isTTY;
		stdout.write = write;
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	const herdr = fakeHerdr(dirs.bin, 0);
	const { stop } = await startDefault(t, "tui", { PATH: dirs.bin, HERDR_ENV: "1", HERDR_PANE_ID: "pane-7" });
	await stop();
	assert.deepEqual(
		written.filter((chunk) => chunk.includes("\x1b]7501;")),
		[],
	);
	assert.equal(herdr.calls().filter((args) => args[1] === "report-metadata").length, 2);
});

test("TUI reporter publishes through HERDR_BIN_PATH when herdr is not on PATH", async (t) => {
	const dirs = tempDirs(t);
	const herdr = fakeHerdr(dirs.bin, 0);
	const { stop } = await startDefault(t, "tui", {
		PATH: dirs.empty,
		HERDR_ENV: "1",
		HERDR_PANE_ID: "pane-7",
		HERDR_BIN_PATH: herdr.bin,
	});
	await stop();
	const writes = herdr.calls().filter((args) => args[1] === "report-metadata");
	assert.equal(writes.length, 2, JSON.stringify(herdr.calls()));
	assert.deepEqual(writes[0].slice(0, 3), ["pane", "report-metadata", "pane-7"]);
	assert.match(writes[0].at(-1) ?? "", /^pi_subagents_work_v1=[A-Za-z0-9_-]{43}:0:\d+$/);
	assert.deepEqual(writes[1].slice(-2), ["--clear-token", "pi_subagents_work_v1"]);
});
