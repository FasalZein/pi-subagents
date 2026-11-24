import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchBackgroundSubagent } from "../../src/launch/background.ts";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { restartSubagentForTimeoutWrapUp } from "../../src/runtime/timeout-wrap-up.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	assert,
	createTestDir,
	describe,
	it,
	SESSION_HEADER,
	writeSubagentLaunchMetadataEntryForTest,
} from "../support/index.ts";
import { testResultsDir } from "../support/result-fixtures.ts";
import "../support/ambient-spawn-grant.ts";

/**
 * Pane identity names of every backend, pinned from spec D34 and the v2.9.2 pane
 * names, not from the production lists. The parent has each; a headless child has
 * no pane, so it must get none of them.
 */
const PARENT_PANE_IDENTITY: Record<string, string> = {
	HERDR_ENV: "1",
	HERDR_PANE_ID: "w1:p1",
	HERDR_TAB_ID: "w1:t1",
	HERDR_WORKSPACE_ID: "w1",
	HERDR_BIN_PATH: "/fake/herdr",
	HERDR_SOCKET_PATH: "/fake/herdr.sock",
	HERDR_CONFIG_PATH: "/fake/herdr.toml",
	HC_TERMINAL_ID: "term-1",
	HC_TERMINAL_SOCKET: "/fake/hc.sock",
	HC_SCOPE: "scope-1",
	REX_SESSION: "rex-1",
	REX_BLOCK: "block-1",
	TMUX_PANE: "%1",
	CMUX_SURFACE_ID: "surface:1",
	WEZTERM_PANE: "1",
	ZELLIJ_PANE_ID: "0",
};
/** Synthetic markers: a kept parent name, a session-level mux name, and a denied name. */
const PARENT_MARKERS: Record<string, string> = {
	T44_HEADLESS_KEEP: "kept",
	WEZTERM_UNIX_SOCKET: "/fake/wezterm.sock",
	T44_HEADLESS_DENIED: "denied",
	PI_SUBAGENT_ENV_DENY: "T44_HEADLESS_DENIED",
};
const EXPECTED_FLAGS: Record<string, "yes" | "no"> = {
	...Object.fromEntries(Object.keys(PARENT_PANE_IDENTITY).map((name) => [name, "no" as const])),
	T44_HEADLESS_KEEP: "yes",
	WEZTERM_UNIX_SOCKET: "yes",
	T44_HEADLESS_DENIED: "no",
};

interface Fixture {
	dir: string;
	outFile: string;
	restore: () => void;
}

/** Point pi at a probe that records only presence flags of the named markers (T44: no environment on disk). */
function useHeadlessParent(): Fixture {
	const dir = createTestDir();
	const outFile = join(dir, "flags.json");
	const probe = join(dir, "probe.cjs");
	writeFileSync(
		probe,
		[
			"const fs = require('node:fs');",
			"fs.readFileSync(0);",
			`const names = ${JSON.stringify(Object.keys(EXPECTED_FLAGS))};`,
			"const flags = {};",
			"for (const n of names) flags[n] = typeof process.env[n] === 'string' ? 'yes' : 'no';",
			`fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(flags));`,
		].join("\n"),
	);
	const env: Record<string, string> = {
		...PARENT_PANE_IDENTITY,
		...PARENT_MARKERS,
		PI_SUBAGENT_PI_COMMAND: `${process.execPath} ${probe}`,
		PI_ARTIFACT_PROJECT_ROOT: join(dir, "artifacts"),
	};
	const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	return {
		dir,
		outFile,
		restore: () => {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

async function readFlags(outFile: string): Promise<Record<string, string>> {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (existsSync(outFile)) {
			const text = readFileSync(outFile, "utf8");
			if (text) return JSON.parse(text);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("the headless child did not write its presence flags");
}

function writeChildSession(dir: string): string {
	const sessionFile = join(dir, "child.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "child-session", timestamp: new Date().toISOString(), cwd: dir })}\n`,
	);
	return sessionFile;
}

const quietResult = async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 });

describe("headless child environment boundary (D34)", () => {
	it("launch: a background child gets no pane identity of the parent", async () => {
		const fixture = useHeadlessParent();
		try {
			const cwd = fixture.dir;
			mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "agents", "probe.md"), "---\nname: probe\nmode: background\n---\nProbe.\n");
			const parentSession = join(cwd, "parent.jsonl");
			writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);
			await launchBackgroundSubagent(
				{ name: "probe", title: "Probe", task: "Probe.", agent: "probe" },
				{
					cwd,
					sessionManager: {
						getSessionFile: () => parentSession,
						getSessionId: () => "parent-session-id",
						getLeafId: () => null,
					},
				},
				{ getContextWindow: () => undefined },
			);
			assert.deepEqual(await readFlags(fixture.outFile), EXPECTED_FLAGS);
		} finally {
			fixture.restore();
		}
	});

	it("resume: a background resume gets no pane identity of the parent", async () => {
		const fixture = useHeadlessParent();
		try {
			const sessionFile = writeChildSession(fixture.dir);
			await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "resume-child",
				agent: "scout",
				mode: "background",
				sessionMode: "lineage-only",
				autoExit: true,
				parentClosePolicy: "terminate",
				async: true,
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: fixture.dir,
				cwd: fixture.dir,
				boundarySystemPrompt: false,
			});
			await resumeSubagentSession(
				{
					resultsDir: testResultsDir(),
					parentSessionId: "test-parent",
					parent: { parentCwd: process.cwd(), warnings: [] },
					sessionFile,
					task: "Probe.",
				},
				{
					isMuxAvailable: () => true,
					getShellReadyDelayMs: () => 0,
					watchBackgroundSubagent: quietResult,
					watchSubagent: quietResult,
					getWatcherSignal: (_running: unknown, controller: AbortController) => controller.signal,
					startWidgetRefresh: () => {},
					getContextWindow: () => undefined,
					runningSubagents: new Map<string, RunningSubagent>(),
				},
			);
			assert.deepEqual(await readFlags(fixture.outFile), EXPECTED_FLAGS);
		} finally {
			fixture.restore();
		}
	});

	it("time-limit restart: a background restart gets no pane identity of the parent", async () => {
		const fixture = useHeadlessParent();
		try {
			const sessionFile = writeChildSession(fixture.dir);
			const running = {
				id: "timeout-child",
				name: "timeout-child",
				task: "Do the long task",
				agent: "scout",
				mode: "background",
				parentClosePolicy: "terminate",
				async: true,
				autoExit: false,
				noSession: true,
				startTime: Date.now() - 8_000,
				sessionFile,
				timeoutBudget: { timeoutSeconds: 10 },
				timeoutWarnThreshold: 80,
				phase: {
					kind: "soft-limit",
					wrapUp: { wrapUp: { kind: "timeout", seconds: 10, threshold: 80 }, deadlineAt: 0 },
				},
				modelRef: "test/model:off",
				launchMetadata: {
					version: 1,
					timestamp: new Date().toISOString(),
					name: "timeout-child",
					agent: "scout",
					mode: "background",
					sessionMode: "fork",
					autoExit: false,
					parentClosePolicy: "terminate",
					async: true,
					modelRef: "test/model:off",
					denyTools: [],
					noContextFiles: false,
					noSession: true,
					agentConfigDir: fixture.dir,
					cwd: fixture.dir,
					boundarySystemPrompt: true,
					timeout: 10,
					timeoutWarnThreshold: "80%",
				},
			} as RunningSubagent;
			await restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 });
			assert.deepEqual(await readFlags(fixture.outFile), EXPECTED_FLAGS);
		} finally {
			fixture.restore();
		}
	});
});
