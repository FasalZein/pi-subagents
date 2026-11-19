import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { connectMuxWorkReporter, getMuxBackend } from "../../src/mux/core.ts";
import { recordOscOnStdout, writeExecutable } from "../support/index.ts";
import { FAKE_HC, FAKE_HC_CALLER, seedFakeHcCaller } from "./fake-hc.ts";

// Old herdr that answers its availability probes (status server, current pane).
const FAKE_HERDR = `#!/bin/sh
case "$*" in
  "status server --json")
    echo '{"status":"running","running":true,"compatible":true,"protocol":17,"version":"0.7.5"}'; exit 0 ;;
  "pane current --current")
    echo '{"id":"c","result":{"type":"pane_current","pane":{"pane_id":"w1:p1","tab_id":"w1:t1","workspace_id":"w1","cwd":"/parent","foreground_cwd":"/parent","focused":true}}}'; exit 0 ;;
esac
exit 1
`;
// Old herdr with the protocol-22 metadata endpoint (herdr-work.test.ts); it logs each call to $FAKE_TERMINAL_STATE/herdr-calls.
const FAKE_HERDR_METADATA = `#!/bin/sh
echo "$*" >> "$FAKE_TERMINAL_STATE/herdr-calls"
case "$*" in
  "status server --json")
    echo '{"status":"running","running":true,"compatible":true,"protocol":22,"version":"0.8.0"}'; exit 0 ;;
  "pane current --current")
    echo '{"id":"c","result":{"type":"pane_current","pane":{"pane_id":"w1:p1","tab_id":"w1:t1","workspace_id":"w1","cwd":"/parent","foreground_cwd":"/parent","focused":true}}}'; exit 0 ;;
  "pane report-metadata"*)
    echo '{"result":{}}'; exit 0 ;;
esac
exit 1
`;
// hc whose core does not answer: inherited HC markers outside a running Herdr app.
const SILENT_HC = `#!/bin/sh
echo "hc: cannot reach the core" >&2
exit 1
`;
// hc whose core hangs: detection must stay bounded.
const HANGING_HC = `#!/bin/sh
exec sleep 30
`;
/** The bounded app check reuses old herdr's CLI bound (2,000 ms); the rest is slack for a loaded host. */
const HANG_LIMIT_MS = 6_000;

const ENV_KEYS = [
	"PATH",
	"PI_SUBAGENT_MUX",
	"FAKE_TERMINAL_STATE",
	"HC_TERMINAL_ID",
	"HC_TERMINAL_SOCKET",
	"HERDR_PANE_ID",
	"HERDR_ENV",
	"HERDR_BIN_PATH",
	"HERDR_SOCKET_PATH",
	"REX_SESSION",
	"REX_BLOCK",
	"REX_BIN_DIR",
	"CMUX_SOCKET_PATH",
	"TMUX",
	"ZELLIJ",
	"ZELLIJ_SESSION_NAME",
	"WEZTERM_UNIX_SOCKET",
] as const;

describe("herdr-core detection needs the app to answer (T45, D27, D29)", () => {
	let root = "";
	let binDir = "";
	let saved = new Map<string, string | undefined>();

	beforeEach(() => {
		saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
		for (const key of ENV_KEYS) if (key !== "PATH") delete process.env[key];
		root = mkdtempSync(join(tmpdir(), "herdr-core-detect-"));
		binDir = join(root, "bin");
		const stateDir = join(root, "state");
		mkdirSync(binDir);
		mkdirSync(stateDir);
		seedFakeHcCaller(stateDir);
		writeExecutable(binDir, "herdr", FAKE_HERDR);
		// Both backends' markers: an herdr-core terminal's markers inherited into an old herdr pane.
		// No host PATH: an installed hc, herdr or rex must never answer for a fake (the fakes need node and sh).
		symlinkSync(process.execPath, join(binDir, "node"));
		process.env.PATH = `${binDir}:/usr/bin:/bin`;
		process.env.FAKE_TERMINAL_STATE = stateDir;
		process.env.HC_TERMINAL_ID = FAKE_HC_CALLER;
		process.env.HC_TERMINAL_SOCKET = join(stateDir, "hc.sock");
		process.env.HERDR_PANE_ID = "w1:p1";
	});

	afterEach(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	it("selects old herdr when the HC markers are inherited and no app answers", () => {
		writeExecutable(binDir, "hc", SILENT_HC);
		assert.equal(getMuxBackend(), "herdr");
	});

	it("selects old herdr within a bound when the app hangs", () => {
		writeExecutable(binDir, "hc", HANGING_HC);
		const started = Date.now();
		assert.equal(getMuxBackend(), "herdr");
		assert.ok(Date.now() - started < HANG_LIMIT_MS, `detection took ${Date.now() - started} ms`);
	});

	for (const [label, markers] of [
		["stale HC markers", {}],
		["stale HC and Rex markers", { REX_SESSION: "s1", REX_BLOCK: "b1" }],
		["stale Rex markers only", { REX_SESSION: "s1", REX_BLOCK: "b1", HC_TERMINAL_ID: undefined }],
	] as const) {
		it(`the status reporter follows launch to old herdr with ${label} and no answering app (D29, D30)`, async () => {
			writeExecutable(binDir, "hc", SILENT_HC);
			writeExecutable(binDir, "herdr", FAKE_HERDR_METADATA);
			process.env.HERDR_ENV = "1";
			for (const [key, value] of Object.entries(markers)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			assert.equal(getMuxBackend(), "herdr");
			// A recording terminal stands in for stdout: an OSC reporter would write its record here.
			const terminal = recordOscOnStdout();
			try {
				const reporter = await connectMuxWorkReporter({
					mode: "tui",
					sessionManager: { getSessionFile: () => "parent.jsonl" },
				});
				assert.ok(reporter, "old herdr reports the count");
				await reporter.publish(2);
				await reporter.stop();
			} finally {
				terminal.restore();
			}
			assert.deepEqual(terminal.records, [], "no OSC 7501 record");
			const calls = join(process.env.FAKE_TERMINAL_STATE ?? "", "herdr-calls");
			const metadata = existsSync(calls)
				? readFileSync(calls, "utf8")
						.split("\n")
						.filter((line) => line.startsWith("pane report-metadata w1:p1"))
				: [];
			assert.ok(
				metadata.some((line) => /pi_subagents_work_v1=[^:]+:2:/.test(line)),
				"old herdr metadata carries the count 2",
			);
		});
	}

	it("selects herdr-core over old herdr when its app answers (D29 order)", () => {
		writeExecutable(binDir, "hc", FAKE_HC);
		assert.equal(getMuxBackend(), "herdr-core");
	});

	it("a forced available backend still wins over an answering herdr-core app", () => {
		writeExecutable(binDir, "hc", FAKE_HC);
		process.env.PI_SUBAGENT_MUX = "herdr";
		assert.equal(getMuxBackend(), "herdr");
	});
});
