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
import { FAKE_HC, seedFakeHcCaller } from "../mux/fake-hc.ts";
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

// Logging fakes: each answers its surface-creation call with one child surface and logs every call.
const FAKE_TMUX = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_MUX_LOG"
case "$1" in
  new-window|split-window) printf '%%42\\n' ;;
esac
exit 0
`;
const FAKE_CMUX = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_MUX_LOG"
case "$1" in
  identify) exit 1 ;;
  new-surface|new-split) echo "surface:2 pane:2" ;;
esac
exit 0
`;
const FAKE_WEZTERM = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_MUX_LOG"
case "$2" in
  spawn|split-pane) echo "7" ;;
esac
exit 0
`;

// Zellij starts the launch command as the new pane's own program; the argv lands in the log.
const FAKE_ZELLIJ = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_MUX_LOG"
if [ "$*" = "list-sessions --no-formatting" ]; then echo "$ZELLIJ_SESSION_NAME [Created 1s ago]"; exit 0; fi
[ "$1" = "--session" ] && shift 2
case "$2" in
  list-panes) echo '[{"id":0,"is_plugin":false,"exited":false,"title":"pane 0"}]' ;;
  new-pane) echo "terminal_5" ;;
esac
exit 0
`;

const DENY = "T44_DENIED_MARKER,T44_WILD_DENY_*,T44_PANE_DENIED";
const COMMON_PARENT_ENV: Record<string, string> = {
	PI_SUBAGENT_ENV_DENY: DENY,
	T44_ALLOWED_MARKER: "allowed",
	T44_DENIED_MARKER: "denied",
	T44_WILD_DENY_A: "wild",
	SHELL: "/bin/sh",
};
const COMMON_MARKERS = ["T44_ALLOWED_MARKER", "T44_DENIED_MARKER", "T44_WILD_DENY_A", "T44_PANE_DENIED"];
const COMMON_FLAGS = {
	T44_ALLOWED_MARKER: "yes",
	T44_DENIED_MARKER: "no",
	T44_WILD_DENY_A: "no",
	T44_PANE_DENIED: "no",
};

/** One backend fake. Synthetic markers only; the parent has its own pane identity, the surface another. */
interface BackendFake {
	mux: string;
	bin: string;
	script: string;
	parentEnv: Record<string, string>;
	/** The env of the child's surface (pane shell or daemon). */
	surfaceEnv: Record<string, string>;
	/** Identity names whose child value must equal the surface's. */
	identity: string[];
	extraMarkers: string[];
	extraFlags: Record<string, "yes" | "no">;
	/** A required identity name; without it in the surface the launcher must refuse. */
	required?: string;
	/** The PI_SUBAGENT_SURFACE that the child derives from its own surface (a direct-program backend). */
	derivedSurface?: string;
}

/** The capsule path of the launch command: typed, inside a staged script (herdr, cmux), or a logged argv (herdr-core). */
function capsuleIn(log: string): string | undefined {
	const typed = log.match(/run-child\.mjs' '([^']+)'/)?.[1] ?? log.match(/run-child\.mjs","([^"]+)"/)?.[1];
	if (typed) return typed;
	const staged = log.match(/'([^']*pi-subagent-shell-[^']+\.sh)'/)?.[1];
	return staged ? capsuleIn(readFileSync(staged, "utf8")) : undefined;
}

const BACKENDS: BackendFake[] = [
	// herdr-core: the launcher is the terminal's program; the surface env is the daemon env plus the terminal's identity.
	{
		mux: "herdr-core",
		bin: "hc",
		script: FAKE_HC,
		parentEnv: { HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "/fake/hc-parent.sock", HC_SCOPE: "parent-scope" },
		surfaceEnv: { HC_TERMINAL_ID: "t2", HC_TERMINAL_SOCKET: "/fake/hc-child.sock", HC_SCOPE: "child-scope", HC_PROBE_PRIVATE: "daemon-only" },
		identity: ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE"],
		extraMarkers: ["HC_PROBE_PRIVATE"],
		extraFlags: { HC_PROBE_PRIVATE: "no" },
		required: "HC_TERMINAL_ID",
		derivedSurface: "t2",
	},
	{
		mux: "herdr",
		bin: "herdr",
		script: FAKE_HERDR,
		parentEnv: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1" },
		surfaceEnv: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_TAB_ID: "w1:t2", HERDR_PROBE_PRIVATE: "surface-only" },
		identity: ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID"],
		extraMarkers: ["HERDR_PROBE_PRIVATE", "HERDR_WORKSPACE_ID"],
		// The parent has HERDR_WORKSPACE_ID and the surface does not: the parent's value must not reach the child.
		extraFlags: { HERDR_PROBE_PRIVATE: "no", HERDR_WORKSPACE_ID: "no" },
		required: "HERDR_PANE_ID",
	},
	// D34 known limit: the prefix backends still copy a pane-only name with their prefix.
	{
		mux: "tmux",
		bin: "tmux",
		script: FAKE_TMUX,
		parentEnv: { TMUX: "fake-tmux-socket", TMUX_PANE: "%1" },
		surfaceEnv: { TMUX: "fake-tmux-socket", TMUX_PANE: "%42", TMUX_PROBE_PRIVATE: "pane-only" },
		identity: ["TMUX_PANE"],
		extraMarkers: ["TMUX_PROBE_PRIVATE"],
		extraFlags: { TMUX_PROBE_PRIVATE: "yes" },
	},
	{
		mux: "cmux",
		bin: "cmux",
		script: FAKE_CMUX,
		parentEnv: { CMUX_SOCKET_PATH: "fake-cmux-socket", CMUX_SURFACE_ID: "surface:1" },
		surfaceEnv: { CMUX_SOCKET_PATH: "fake-cmux-socket", CMUX_SURFACE_ID: "surface:2", CMUX_PROBE_PRIVATE: "pane-only" },
		identity: ["CMUX_SURFACE_ID"],
		extraMarkers: ["CMUX_PROBE_PRIVATE"],
		extraFlags: { CMUX_PROBE_PRIVATE: "yes" },
	},
	{
		mux: "wezterm",
		bin: "wezterm",
		script: FAKE_WEZTERM,
		parentEnv: { WEZTERM_UNIX_SOCKET: "fake-wezterm-socket", WEZTERM_PANE: "1" },
		surfaceEnv: { WEZTERM_UNIX_SOCKET: "fake-wezterm-socket", WEZTERM_PANE: "7", WEZTERM_PROBE_PRIVATE: "pane-only" },
		identity: ["WEZTERM_PANE"],
		extraMarkers: ["WEZTERM_PROBE_PRIVATE"],
		extraFlags: { WEZTERM_PROBE_PRIVATE: "yes" },
	},
	{
		mux: "zellij",
		bin: "zellij",
		script: FAKE_ZELLIJ,
		parentEnv: {
			ZELLIJ: "0",
			ZELLIJ_SESSION_NAME: `t44-${process.pid}-${Date.now()}`,
			ZELLIJ_PANE_ID: "0",
			PI_SUBAGENT_ZELLIJ_PLACEMENT: "floating",
		},
		surfaceEnv: { ZELLIJ: "0", ZELLIJ_PANE_ID: "5", ZELLIJ_PROBE_PRIVATE: "pane-only" },
		identity: ["ZELLIJ_PANE_ID"],
		extraMarkers: ["ZELLIJ_PROBE_PRIVATE"],
		extraFlags: { ZELLIJ_PROBE_PRIVATE: "yes" },
	},
];

/** Runtime names of every backend, cleared so that only the fake under test is detected. */
const MUX_RUNTIME_KEYS = [
	"TMUX",
	"TMUX_PANE",
	"CMUX_SOCKET_PATH",
	"CMUX_SURFACE_ID",
	"WEZTERM_UNIX_SOCKET",
	"WEZTERM_PANE",
	"ZELLIJ",
	"ZELLIJ_SESSION_NAME",
	"ZELLIJ_PANE_ID",
	"PI_SUBAGENT_ZELLIJ_PLACEMENT",
	"HERDR_ENV",
	"HERDR_PANE_ID",
	"HERDR_TAB_ID",
	"HERDR_WORKSPACE_ID",
	"HC_TERMINAL_ID",
	"HC_TERMINAL_SOCKET",
	"HC_SCOPE",
];

interface Fixture {
	backend: BackendFake;
	dir: string;
	logFile: string;
	outFile: string;
	restore: () => void;
}

/** Point pi at a presence probe and the parent env at the backend fake. */
function useFakeParent(backend: BackendFake): Fixture {
	const dir = createTestDir();
	const binDir = join(dir, "bin");
	mkdirSync(binDir, { recursive: true });
	mkdirSync(join(dir, "capsules"));
	const logFile = join(dir, "mux.log");
	writeFileSync(logFile, "");
	writeExecutable(binDir, backend.bin, backend.script);
	const hcState = join(dir, "hc-state");
	mkdirSync(hcState);
	seedFakeHcCaller(hcState);
	const probe = makeProbeDir();
	const { command, args } = presenceProbeCommand(
		probe.outFile,
		[...COMMON_MARKERS, ...backend.extraMarkers],
		{
			...Object.fromEntries(backend.identity.map((name) => [name, backend.surfaceEnv[name]])),
			...(backend.derivedSurface ? { PI_SUBAGENT_SURFACE: backend.derivedSurface } : {}),
		},
	);
	const probeScript = join(dir, "probe.cjs");
	writeFileSync(
		probeScript,
		`process.argv.splice(1, 0, ${JSON.stringify(args[2])}, ${JSON.stringify(args[3])}, ${JSON.stringify(args[4])});\n${args[1]}\n`,
	);
	const env: Record<string, string> = {
		...COMMON_PARENT_ENV,
		...backend.parentEnv,
		PI_SUBAGENT_MUX: backend.mux,
		PATH: `${binDir}:${process.env.PATH ?? ""}`,
		FAKE_HERDR_LOG: logFile,
		FAKE_MUX_LOG: logFile,
		FAKE_TERMINAL_STATE: hcState,
		PI_SUBAGENT_ENV_CAPSULE_DIR: join(dir, "capsules"),
		PI_SUBAGENT_PI_COMMAND: `${command} ${probeScript}`,
		PI_ARTIFACT_PROJECT_ROOT: join(dir, "artifacts"),
	};
	const keys = [...new Set([...MUX_RUNTIME_KEYS, ...Object.keys(env)])];
	const saved = new Map(keys.map((key) => [key, process.env[key]]));
	for (const key of MUX_RUNTIME_KEYS) delete process.env[key];
	Object.assign(process.env, env);
	return {
		backend,
		dir,
		logFile,
		outFile: probe.outFile,
		restore: () => {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			probe.dispose();
			// The fixture holds capsules, which carry a parent env snapshot: none may stay on disk.
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** Run the launch command's capsule in the child surface; on an exact backend also without a required name. */
function checkChildEnvironment(fixture: Fixture): void {
	const { backend } = fixture;
	const log = readFileSync(fixture.logFile, "utf8");
	// herdr-core: the launcher is the program; no shell terminal is opened and nothing is typed.
	if (backend.mux === "herdr-core") assert.doesNotMatch(log, /^hc (send|run) /m);
	const capsulePath = capsuleIn(log);
	assert.ok(capsulePath, "expected the launch to invoke the capsule launcher");
	const capsule = JSON.parse(readFileSync(capsulePath, "utf8"));

	const run = runLauncherInSurface(
		capsulePath,
		{ ...backend.surfaceEnv, T44_PANE_DENIED: "pane-only" },
		fixture.outFile,
	);
	assert.equal(run.status, 0, run.stderr);
	assert.deepEqual(run.flags, {
		...COMMON_FLAGS,
		...backend.extraFlags,
		...Object.fromEntries(backend.identity.map((name) => [`equal:${name}`, "yes"])),
		...(backend.derivedSurface ? { "equal:PI_SUBAGENT_SURFACE": "yes" } : {}),
	});

	if (!backend.required) return;
	rmSync(fixture.outFile);
	const missingCapsule = writeEnvCapsule(capsule, join(fixture.dir, "capsules"));
	const { [backend.required]: _dropped, ...withoutRequired } = backend.surfaceEnv;
	const refused = runLauncherInSurface(missingCapsule, withoutRequired, fixture.outFile);
	assert.equal(refused.status, 2);
	assert.match(refused.stderr, new RegExp(`identity variable ${backend.required}`));
	assert.equal(refused.flags, undefined, "pi must not start without the surface's required identity name");
}

function writeChildSession(dir: string): string {
	const sessionFile = join(dir, "child.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "child-session", timestamp: new Date().toISOString(), cwd: dir })}\n`,
	);
	return sessionFile;
}

for (const backend of BACKENDS)
	describe(`${backend.mux} environment boundary (D34)`, () => {
		it("launch: the child gets the surface's identity names and no denied or surface-only marker", async () => {
			const fixture = useFakeParent(backend);
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
			const fixture = useFakeParent(backend);
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
					{ resultsDir: testResultsDir(), parent: { parentCwd: process.cwd(), warnings: [] }, sessionFile, task: "Probe." },
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
			const fixture = useFakeParent(backend);
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
