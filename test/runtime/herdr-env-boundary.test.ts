import { mkdirSync, rmSync } from "node:fs";
import { writeEnvCapsule } from "../../src/launch/env-capsule.ts";
import { launchInteractiveSubagent } from "../../src/launch/interactive.ts";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { restartSubagentForTimeoutWrapUp } from "../../src/runtime/timeout-wrap-up.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { makeProbeDir, presenceProbeCommand, runLauncherInSurface } from "../support/env-presence.ts";
import {
	ASSISTANT_MSG,
	assert,
	createSessionFile,
	createTestDir,
	describe,
	it,
	join,
	MODEL_CHANGE,
	readFileSync,
	SESSION_HEADER,
	USER_MSG,
	writeExecutable,
	writeFileSync,
	writeSubagentLaunchMetadataEntryForTest,
} from "../support/index.ts";
import { testResultsDir } from "../support/result-fixtures.ts";
import "../support/ambient-spawn-grant.ts";

// Old herdr fake: answers the availability probes and one split surface; "pane run" only logs the staged script.
const FAKE_HERDR = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_HERDR_LOG"
case "$*" in
  "status server --json")
    echo '{"status":"running","running":true,"compatible":true,"protocol":17,"version":"0.7.5"}'; exit 0 ;;
  "pane current --current")
    echo '{"id":"c","result":{"type":"pane_current","pane":{"pane_id":"w1:p1","tab_id":"w1:t1","workspace_id":"w1","cwd":"/parent","foreground_cwd":"/parent","focused":true}}}'; exit 0 ;;
  "pane layout"*)
    echo '{"id":"l","result":{"type":"pane_layout","layout":{"area":{"height":52,"width":120,"x":0,"y":0},"focused_pane_id":"w1:p1","panes":[{"focused":true,"pane_id":"w1:p1","rect":{"height":52,"width":120,"x":0,"y":0}}],"splits":[],"tab_id":"w1:t1","workspace_id":"w1","zoomed":false}}}'; exit 0 ;;
  "pane split"*)
    echo '{"id":"s","result":{"type":"pane_split","pane":{"pane_id":"w1:p2","tab_id":"w1:t1","workspace_id":"w1","cwd":"/child","focused":false}}}'; exit 0 ;;
  "tab create"*)
    echo '{"id":"t","result":{"type":"tab_created","tab":{"tab_id":"w1:t2","workspace_id":"w1","label":"Child","focused":false,"pane_count":1},"root_pane":{"pane_id":"w1:p2","tab_id":"w1:t2","workspace_id":"w1","cwd":"/child","focused":false}}}'; exit 0 ;;
  "tab list"*)
    echo '{"id":"tl","result":{"type":"tab_list","tabs":[{"tab_id":"w1:t1","workspace_id":"w1","label":"Parent","focused":true,"pane_count":1},{"tab_id":"w1:t2","workspace_id":"w1","label":"Child","focused":false,"pane_count":1}]}}'; exit 0 ;;
  "pane rename"*|"tab rename"*|"workspace rename"*)
    echo '{"id":"r","result":{"type":"renamed"}}'; exit 0 ;;
  "pane run"*|"pane send-text"*|"pane send-keys"*) exit 0 ;;
esac
echo '{"error":{"code":"unknown_command","message":"unsupported fake herdr command"}}'
exit 1
`;

// Synthetic markers only. The parent carries its own pane identity; the child's surface carries another.
const PARENT_ENV: Record<string, string> = {
	PI_SUBAGENT_MUX: "herdr",
	HERDR_ENV: "1",
	HERDR_PANE_ID: "w1:p1",
	HERDR_TAB_ID: "w1:t1",
	HERDR_WORKSPACE_ID: "w1",
	PI_SUBAGENT_ENV_DENY: "T44_DENIED_MARKER,T44_WILD_DENY_*,T44_PANE_DENIED",
	T44_ALLOWED_MARKER: "allowed",
	T44_DENIED_MARKER: "denied",
	T44_WILD_DENY_A: "wild",
	SHELL: "/bin/sh",
};
const SURFACE_ENV = {
	HERDR_ENV: "1",
	HERDR_PANE_ID: "w1:p2",
	HERDR_TAB_ID: "w1:t2",
	HERDR_PROBE_PRIVATE: "surface-only",
	T44_PANE_DENIED: "pane-only",
};
const MARKERS = [
	"T44_ALLOWED_MARKER",
	"T44_DENIED_MARKER",
	"T44_WILD_DENY_A",
	"T44_PANE_DENIED",
	"HERDR_PROBE_PRIVATE",
	"HERDR_WORKSPACE_ID",
];
const EXPECTED_FLAGS = {
	T44_ALLOWED_MARKER: "yes",
	T44_DENIED_MARKER: "no",
	T44_WILD_DENY_A: "no",
	T44_PANE_DENIED: "no",
	HERDR_PROBE_PRIVATE: "no",
	// The parent has HERDR_WORKSPACE_ID and the surface does not: the parent's value must not reach the child.
	HERDR_WORKSPACE_ID: "no",
	"equal:HERDR_ENV": "yes",
	"equal:HERDR_PANE_ID": "yes",
	"equal:HERDR_TAB_ID": "yes",
};

interface Fixture {
	dir: string;
	logFile: string;
	outFile: string;
	restore: () => void;
}

/** Point pi at a presence probe and the parent env at the fake herdr. */
function useFakeHerdrParent(): Fixture {
	const dir = createTestDir();
	const binDir = join(dir, "bin");
	mkdirSync(binDir, { recursive: true });
	mkdirSync(join(dir, "capsules"));
	const logFile = join(dir, "herdr.log");
	writeFileSync(logFile, "");
	writeExecutable(binDir, "herdr", FAKE_HERDR);
	const probe = makeProbeDir();
	const { command, args } = presenceProbeCommand(probe.outFile, MARKERS, {
		HERDR_ENV: SURFACE_ENV.HERDR_ENV,
		HERDR_PANE_ID: SURFACE_ENV.HERDR_PANE_ID,
		HERDR_TAB_ID: SURFACE_ENV.HERDR_TAB_ID,
	});
	const probeScript = join(dir, "probe.cjs");
	writeFileSync(probeScript, `process.argv.splice(1, 0, ${JSON.stringify(args[2])}, ${JSON.stringify(args[3])}, ${JSON.stringify(args[4])});\n${args[1]}\n`);
	const env: Record<string, string> = {
		...PARENT_ENV,
		PATH: `${binDir}:${process.env.PATH ?? ""}`,
		FAKE_HERDR_LOG: logFile,
		PI_SUBAGENT_ENV_CAPSULE_DIR: join(dir, "capsules"),
		PI_SUBAGENT_PI_COMMAND: `${command} ${probeScript}`,
		PI_ARTIFACT_PROJECT_ROOT: join(dir, "artifacts"),
	};
	const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	return {
		dir,
		logFile,
		outFile: probe.outFile,
		restore: () => {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			probe.dispose();
		},
	};
}

/** Run the staged launch command's capsule in the child surface, once complete and once without HERDR_PANE_ID. */
function checkChildEnvironment(fixture: Fixture): void {
	const runScript = readFileSync(fixture.logFile, "utf8").match(/pane run w1:p2 '([^']+)'/)?.[1];
	assert.ok(runScript, "expected a staged herdr launch script");
	const capsulePath = readFileSync(runScript, "utf8").match(/run-child\.mjs' '([^']+)'/)?.[1];
	assert.ok(capsulePath, "expected the launch to invoke the capsule launcher");
	const capsule = JSON.parse(readFileSync(capsulePath, "utf8"));
	const missingCapsule = writeEnvCapsule(capsule, join(fixture.dir, "capsules"));

	const run = runLauncherInSurface(capsulePath, SURFACE_ENV, fixture.outFile);
	assert.equal(run.status, 0, run.stderr);
	assert.deepEqual(run.flags, EXPECTED_FLAGS);

	rmSync(fixture.outFile);
	const { HERDR_PANE_ID: _dropped, ...withoutPane } = SURFACE_ENV;
	const refused = runLauncherInSurface(missingCapsule, withoutPane, fixture.outFile);
	assert.equal(refused.status, 2);
	assert.match(refused.stderr, /identity variable HERDR_PANE_ID/);
	assert.equal(refused.flags, undefined, "pi must not start without the surface's HERDR_PANE_ID");
}

function writeChildSession(dir: string): string {
	const sessionFile = join(dir, "child.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "child-session", timestamp: new Date().toISOString(), cwd: dir })}\n`,
	);
	return sessionFile;
}

describe("old herdr environment boundary (D34)", () => {
	it("launch: the child gets the surface's identity names and no denied or surface-only marker", async () => {
		const fixture = useFakeHerdrParent();
		try {
			const cwd = fixture.dir;
			mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "agents", "env-child.md"), "---\nname: env-child\n---\nProbe.\n");
			const parentSession = createSessionFile(cwd, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
			await launchInteractiveSubagent(
				{ name: "env-child", title: "Env child", task: "Probe.", agent: "env-child" },
				{
					cwd,
					sessionManager: {
						getSessionFile: () => parentSession,
						getSessionId: () => "parent-session-id",
						getLeafId: () => "asst-001",
					},
				},
				{ getContextWindow: () => undefined, getShellReadyDelayMs: () => 0 },
			);
			checkChildEnvironment(fixture);
		} finally {
			fixture.restore();
		}
	});

	it("resume: the same boundary holds", async () => {
		const fixture = useFakeHerdrParent();
		try {
			const sessionFile = writeChildSession(fixture.dir);
			await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "resume-child",
				agent: "scout",
				mode: "interactive",
				sessionMode: "fork",
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
				{ resultsDir: testResultsDir(), sessionFile, task: "Probe." },
				{
					isMuxAvailable: () => true,
					getShellReadyDelayMs: () => 0,
					watchBackgroundSubagent: async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 }),
					watchSubagent: async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 }),
					getWatcherSignal: (_running: any, controller: AbortController) => controller.signal,
					startWidgetRefresh: () => {},
					getContextWindow: () => undefined,
					runningSubagents: new Map<string, any>(),
				},
			);
			checkChildEnvironment(fixture);
		} finally {
			fixture.restore();
		}
	});

	it("time-limit restart: the same boundary holds", async () => {
		const fixture = useFakeHerdrParent();
		try {
			const sessionFile = writeChildSession(fixture.dir);
			const running = {
				id: "timeout-child",
				name: "timeout-child",
				task: "Do the long task",
				agent: "scout",
				mode: "interactive",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				async: true,
				autoExit: false,
				noSession: true,
				startTime: Date.now() - 8_000,
				sessionFile,
				timeoutBudget: { timeoutSeconds: 10 },
				timeoutWarnThreshold: 80,
				timeoutWrapUp: { kind: "timeout", seconds: 10, threshold: 80 },
				modelRef: "test/model:off",
				launchMetadata: {
					version: 1,
					timestamp: new Date().toISOString(),
					name: "timeout-child",
					agent: "scout",
					mode: "interactive",
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
			checkChildEnvironment(fixture);
		} finally {
			fixture.restore();
		}
	});
});
