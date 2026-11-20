import { testResultsDir } from "../support/result-fixtures.ts";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { coordinateSubagentLaunch } from "../../src/launch/launch-coordinator.ts";
import { LaunchUndo } from "../../src/launch/launch-undo.ts";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { readSubagentLaunchMetadataEntries } from "../../src/session/session-files.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	assert,
	createTestDir,
	describe,
	existsSync,
	it,
	join,
	readFileSync,
	writeExecutable,
	writeFileSync,
	writeSubagentLaunchMetadataEntryForTest,
} from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";

async function readNonEmptyFileEventually(path: string): Promise<string> {
	let lastText = "";
	// Up to 5 s, as in headless-env-boundary: a spawned child can take over 0.5 s to write under host load.
	for (let attempt = 0; attempt < 500; attempt++) {
		if (existsSync(path)) {
			lastText = readFileSync(path, "utf8");
			if (lastText.trim().length > 0) return lastText;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${path}; last content: ${lastText}`);
}

describe("subagent_resume env filtering", () => {
	it("applies persisted deny-env and persists model overrides on background resumes", async () => {
		const dir = createTestDir();
		const stdinLog = join(dir, "stdin.log");
		const flagsLog = join(dir, "flags.log");
		// Records only presence or equality flags of named markers, never an environment (T44).
		const bin = writeExecutable(
			dir,
			"capture-pi",
			`#!/usr/bin/env bash
cat > '${stdinLog}'
{
  for n in RESUME_TEST_AGENT_DENY RESUME_TEST_GLOBAL_DENY; do [ -n "\${!n+x}" ] && echo "\$n=yes" || echo "\$n=no"; done
  [ "\$RESUME_TEST_KEEP" = kept ] && echo "equal:RESUME_TEST_KEEP=yes" || echo "equal:RESUME_TEST_KEEP=no"
  [ "\$PI_SUBAGENT_NAME" = resume-child ] && echo "equal:PI_SUBAGENT_NAME=yes" || echo "equal:PI_SUBAGENT_NAME=no"
} > '${flagsLog}.tmp' && mv '${flagsLog}.tmp' '${flagsLog}'
`,
		);
		const originalCommand = process.env.PI_SUBAGENT_PI_COMMAND;
		process.env.PI_SUBAGENT_PI_COMMAND = bin;
		const originalDeny = process.env.PI_SUBAGENT_ENV_DENY;
		process.env.PI_SUBAGENT_ENV_DENY = "RESUME_TEST_GLOBAL_DENY";
		const originalAgentDeny = process.env.RESUME_TEST_AGENT_DENY;
		process.env.RESUME_TEST_AGENT_DENY = "agent-denied";
		const originalGlobalDeny = process.env.RESUME_TEST_GLOBAL_DENY;
		process.env.RESUME_TEST_GLOBAL_DENY = "global-denied";
		const originalKeep = process.env.RESUME_TEST_KEEP;
		process.env.RESUME_TEST_KEEP = "kept";
		try {
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({
					type: "session",
					version: 3,
					id: "child-session",
					timestamp: new Date().toISOString(),
					cwd: dir,
				}) + "\n",
			);
			await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "resume-child",
				agent: "scout",
				mode: "background",
				sessionMode: "lineage-only",
				autoExit: true,
				model: "provider/original",
				modelRef: "provider/original:low",
				allowModelOverride: true,
				parentClosePolicy: "terminate",
				async: true,
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: dir,
				cwd: dir,
				boundarySystemPrompt: false,
				denyEnv: "RESUME_TEST_AGENT_DENY, RESUME_TEST_MISSING_*",
			});


			await resumeSubagentSession(
				{ resultsDir: testResultsDir(), parent: { parentCwd: process.cwd(), warnings: [] }, sessionFile, task: "Background deny-env probe.", model: "provider/override:high" },
				{
					isMuxAvailable: () => true,
					getShellReadyDelayMs: () => 0,
					watchBackgroundSubagent: async () => ({
						name: "",
						task: "",
						summary: "",
						exitCode: 0,
						elapsed: 0,
					}),
					watchSubagent: async () => ({
						name: "",
						task: "",
						summary: "",
						exitCode: 0,
						elapsed: 0,
					}),
					getWatcherSignal: (_running: any, controller: AbortController) => controller.signal,
					startWidgetRefresh: () => {},
					getContextWindow: () => undefined,
					runningSubagents: new Map<string, any>(),
					modelRegistry: {
						getAvailable: () => [{ provider: "provider", id: "override", thinkingLevelMap: { high: "high" } }],
					},
				},
			);

			await readNonEmptyFileEventually(flagsLog);
			const flags = readFileSync(flagsLog, "utf8");
			assert.match(flags, /^RESUME_TEST_AGENT_DENY=no$/m, "persisted agent deny-env must filter the child env");
			assert.match(flags, /^RESUME_TEST_GLOBAL_DENY=no$/m, "global deny must filter the child env");
			assert.match(flags, /^equal:RESUME_TEST_KEEP=yes$/m, "non-denied env must still flow");
			assert.match(flags, /^equal:PI_SUBAGENT_NAME=yes$/m, "controlled overrides must still flow");
			const entries = readSubagentLaunchMetadataEntries(sessionFile);
			assert.equal(entries.length, 2, "a resume model override must append launch metadata");
			assert.equal(entries.at(-1)?.modelRef, "provider/override:high");
			assert.equal(entries.at(-1)?.modelSource, "resume-override");
		} finally {
			if (originalCommand == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = originalCommand;
			if (originalDeny === undefined) delete process.env.PI_SUBAGENT_ENV_DENY;
			else process.env.PI_SUBAGENT_ENV_DENY = originalDeny;
			if (originalAgentDeny === undefined) delete process.env.RESUME_TEST_AGENT_DENY;
			else process.env.RESUME_TEST_AGENT_DENY = originalAgentDeny;
			if (originalGlobalDeny === undefined) delete process.env.RESUME_TEST_GLOBAL_DENY;
			else process.env.RESUME_TEST_GLOBAL_DENY = originalGlobalDeny;
			if (originalKeep === undefined) delete process.env.RESUME_TEST_KEEP;
			else process.env.RESUME_TEST_KEEP = originalKeep;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("forces auto-exit when persisted background metadata says false", async () => {
		const dir = createTestDir();
		const capturedAutoExit = join(dir, "captured-auto-exit.txt");
		const bin = writeExecutable(
			dir,
			"capture-auto-exit",
			"#!/usr/bin/env bash\nprintf '%s' \"$PI_SUBAGENT_AUTO_EXIT\" > " + JSON.stringify(capturedAutoExit) + "\n",
		);
		const originalCommand = process.env.PI_SUBAGENT_PI_COMMAND;
		process.env.PI_SUBAGENT_PI_COMMAND = bin;
		try {
			const sessionFile = join(dir, "legacy-background.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({
					type: "session",
					version: 3,
					id: "legacy-background",
					timestamp: new Date().toISOString(),
					cwd: dir,
				}) + "\n",
			);
			await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "legacy-background",
				mode: "background",
				sessionMode: "lineage-only",
				autoExit: false,
				parentClosePolicy: "terminate",
				async: true,
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: dir,
				cwd: dir,
				boundarySystemPrompt: false,
			});

			const quietResult = async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 });
			const running = await resumeSubagentSession(
				{ resultsDir: testResultsDir(), parent: { parentCwd: process.cwd(), warnings: [] }, sessionFile },
				{
					isMuxAvailable: () => true,
					getShellReadyDelayMs: () => 0,
					watchBackgroundSubagent: quietResult,
					watchSubagent: quietResult,
					getWatcherSignal: (_running: any, controller: AbortController) => controller.signal,
					startWidgetRefresh: () => {},
					getContextWindow: () => undefined,
					runningSubagents: new Map<string, any>(),
				},
			);

			assert.equal(running.mode, "background");
			assert.equal(running.async, true);
			assert.equal(running.autoExit, true);
			assert.equal(running.launchMetadata?.autoExit, true);
			assert.equal(await readNonEmptyFileEventually(capturedAutoExit), "1");
		} finally {
			if (originalCommand == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = originalCommand;
		}
	});

	it("applies persisted deny-env to interactive resumes", async () => {
		const dir = createTestDir();
		const capsuleRoot = join(dir, "capsules");
		mkdirSync(capsuleRoot, { recursive: true });
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		const logFile = join(dir, "tmux.log");
		writeExecutable(
			binDir,
			"tmux",
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_TMUX_LOG"
case "$1" in
  new-window) printf '%%42\\n' ;;
esac
`,
		);
		const originalPath = process.env.PATH;
		const originalMux = process.env.PI_SUBAGENT_MUX;
		const originalTmux = process.env.TMUX;
		const originalKeep = process.env.RESUME_TEST_KEEP;
		const originalAgentDeny = process.env.RESUME_TEST_AGENT_DENY;
		process.env.PATH = `${binDir}:${originalPath ?? ""}`;
		process.env.PI_SUBAGENT_MUX = "tmux";
		process.env.TMUX = "fake-tmux-socket";
		process.env.FAKE_TMUX_LOG = logFile;
		const originalCapsuleDir = process.env.PI_SUBAGENT_ENV_CAPSULE_DIR;
		process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = capsuleRoot;
		process.env.RESUME_TEST_KEEP = "kept";
		process.env.RESUME_TEST_AGENT_DENY = "agent-denied";

		try {
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({
					type: "session",
					version: 3,
					id: "child-session",
					timestamp: new Date().toISOString(),
					cwd: dir,
				}) + "\n",
			);
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
				agentConfigDir: dir,
				cwd: dir,
				boundarySystemPrompt: false,
				denyEnv: "RESUME_TEST_AGENT_DENY, RESUME_TEST_MISSING_*",
			});

			const running = await resumeSubagentSession(
				{ resultsDir: testResultsDir(), parent: { parentCwd: process.cwd(), warnings: [] }, sessionFile, task: "Interactive deny-env probe." },
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

			assert.equal(running.autoExit, true, "interactive resumes default auto-exit to true when metadata omits it");
			assert.equal(
				running.launchMetadata?.autoExit,
				undefined,
				"interactive resumes must not persist a synthesized auto-exit override",
			);
			const log = readFileSync(logFile, "utf8");
			const capsuleMatch = log.match(/run-child\.mjs' '([^']+)'/);
			assert.ok(capsuleMatch, "expected the resume command to invoke the capsule launcher");
			const capsule = JSON.parse(readFileSync(capsuleMatch[1], "utf8"));
			assert.equal(capsule.parentEnv.RESUME_TEST_AGENT_DENY, undefined, "persisted deny-env must filter the resumed child env");
			assert.equal(capsule.parentEnv.RESUME_TEST_KEEP, "kept", "non-denied env must still flow");
			assert.equal(capsule.overrides.PI_SUBAGENT_NAME, "resume-child", "controlled overrides must survive");
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalMux === undefined) delete process.env.PI_SUBAGENT_MUX;
			else process.env.PI_SUBAGENT_MUX = originalMux;
			if (originalTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = originalTmux;
			if (originalKeep === undefined) delete process.env.RESUME_TEST_KEEP;
			else process.env.RESUME_TEST_KEEP = originalKeep;
			if (originalAgentDeny === undefined) delete process.env.RESUME_TEST_AGENT_DENY;
			else process.env.RESUME_TEST_AGENT_DENY = originalAgentDeny;
			if (originalCapsuleDir === undefined) delete process.env.PI_SUBAGENT_ENV_CAPSULE_DIR;
			else process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = originalCapsuleDir;
			delete process.env.FAKE_TMUX_LOG;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("deletes the capsule when interactive resume delivery fails", async () => {
		const dir = createTestDir();
		const capsuleRoot = join(dir, "capsules");
		mkdirSync(capsuleRoot, { recursive: true });
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		writeExecutable(
			binDir,
			"tmux",
			`#!/usr/bin/env bash
case "$1" in
  new-window) printf '%%42\\n' ;;
  send-keys) exit 9 ;;
esac
`,
		);
		const originalPath = process.env.PATH;
		const originalMux = process.env.PI_SUBAGENT_MUX;
		const originalTmux = process.env.TMUX;
		process.env.PATH = `${binDir}:${originalPath ?? ""}`;
		process.env.PI_SUBAGENT_MUX = "tmux";
		process.env.TMUX = "fake-tmux-socket";
		const originalCapsuleDir = process.env.PI_SUBAGENT_ENV_CAPSULE_DIR;
		process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = capsuleRoot;

		try {
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({
					type: "session",
					version: 3,
					id: "child-session",
					timestamp: new Date().toISOString(),
					cwd: dir,
				}) + "\n",
			);
			await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "resume-child",
				agent: "scout",
				mode: "interactive",
				sessionMode: "fork",
				autoExit: true,
				parentClosePolicy: "terminate",
				async: true,
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: dir,
				cwd: dir,
				boundarySystemPrompt: false,
			});

			await assert.rejects(
				resumeSubagentSession(
					{ resultsDir: testResultsDir(), parent: { parentCwd: process.cwd(), warnings: [] }, sessionFile, task: "Failure probe." },
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
				),
				/send-keys|Command failed|tmux/i,
			);

			assert.equal(
				existsSync(capsuleRoot) ? readdirSync(capsuleRoot).length : 0,
				0,
				"an unconsumed capsule must not survive a failed interactive resume delivery",
			);
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalMux === undefined) delete process.env.PI_SUBAGENT_MUX;
			else process.env.PI_SUBAGENT_MUX = originalMux;
			if (originalTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = originalTmux;
			if (originalCapsuleDir === undefined) delete process.env.PI_SUBAGENT_ENV_CAPSULE_DIR;
			else process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = originalCapsuleDir;
		}
	});
});

/** A synthetic marker that only the agent's deny-env names; its value is never read or printed. */
const AGENT_ONLY_MARKER = "STANDALONE_TEST_AGENT_DENY";

const quietResult = async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 });
const resumeRuntime = () => ({
	isMuxAvailable: () => true,
	getShellReadyDelayMs: () => 0,
	watchBackgroundSubagent: quietResult,
	watchSubagent: quietResult,
	getWatcherSignal: (_running: unknown, controller: AbortController) => controller.signal,
	startWidgetRefresh: () => {},
	getContextWindow: () => undefined,
	runningSubagents: new Map<string, RunningSubagent>(),
});

type ResumeMode = "background" | "interactive";

/**
 * A standalone agent with an agent-only deny-env under a temporary agent dir, the marker set in the parent,
 * and per-mode fakes: a headless child that records only the marker's presence, and a fake tmux pane whose
 * capsule holds the filtered parent env. The support env hooks restore PATH, PI_CODING_AGENT_DIR and the mux keys.
 */
function standaloneFixture(mode: ResumeMode) {
	const dir = createTestDir();
	const agentDir = join(dir, "agent");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(
		join(agentDir, "agents", "keeper.md"),
		`---\nname: keeper\nsession-mode: standalone\nmode: ${mode}\ndeny-env: ${AGENT_ONLY_MARKER}\n---\nKeeper body.\n`,
	);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env[AGENT_ONLY_MARKER] = "agent-only";
	const flagsLog = join(dir, "flags.log");
	const binDir = join(dir, "bin");
	mkdirSync(binDir);
	const tmuxLog = join(dir, "tmux.log");
	const capsuleRoot = join(dir, "capsules");
	mkdirSync(capsuleRoot);
	const saved = {
		command: process.env.PI_SUBAGENT_PI_COMMAND,
		capsules: process.env.PI_SUBAGENT_ENV_CAPSULE_DIR,
	};
	if (mode === "background") {
		process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(
			dir,
			"capture-pi",
			`#!/usr/bin/env bash\ncat > /dev/null\n[ -n "\${${AGENT_ONLY_MARKER}+x}" ] && echo present > '${flagsLog}' || echo absent > '${flagsLog}'\n`,
		);
	} else {
		writeExecutable(binDir, "tmux", `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${tmuxLog}'\ncase "$1" in new-window) printf '%%42\\n' ;; esac\n`);
		process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
		process.env.PI_SUBAGENT_MUX = "tmux";
		process.env.TMUX = "fake-tmux-socket";
		process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = capsuleRoot;
	}
	return {
		dir,
		/** Whether the resumed child received the marker. */
		async markerReached(): Promise<boolean> {
			if (mode === "background") return (await readNonEmptyFileEventually(flagsLog)).trim() === "present";
			const capsulePath = readFileSync(tmuxLog, "utf8").match(/run-child\.mjs' '([^']+)'/)?.[1];
			assert.ok(capsulePath, "the resume command invokes the capsule launcher");
			return AGENT_ONLY_MARKER in JSON.parse(readFileSync(capsulePath, "utf8")).parentEnv;
		},
		cleanup() {
			delete process.env[AGENT_ONLY_MARKER];
			if (saved.command === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = saved.command;
			if (saved.capsules === undefined) delete process.env.PI_SUBAGENT_ENV_CAPSULE_DIR;
			else process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = saved.capsules;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function writePiHeader(sessionFile: string, cwd: string): void {
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "standalone", timestamp: new Date().toISOString(), cwd })}\n`,
	);
}

describe("standalone sessions keep the agent's deny-env on resume (B3 g4)", () => {
	for (const mode of ["background", "interactive"] as const) {
		it(`a ${mode} launch then resume never passes a variable denied only by the agent`, async () => {
			const fixture = standaloneFixture(mode);
			try {
				const parentSession = join(fixture.dir, "parent.jsonl");
				writePiHeader(parentSession, fixture.dir);
				const launch = await coordinateSubagentLaunch(
					{ name: "keeper-run", title: "Keeper", task: "Keep.", agent: "keeper" },
					{
						cwd: fixture.dir,
						sessionManager: { getSessionFile: () => parentSession, getSessionId: () => "parent-session-id" },
					},
					{ mode, undo: new LaunchUndo() },
				);
				assert.equal(launch.sessionMode, "standalone");
				const sessionFile = launch.prepared.subagentSessionFile;
				// The first spawn: Pi creates the session file when no launch step wrote one.
				if (!existsSync(sessionFile)) writePiHeader(sessionFile, fixture.dir);
				const header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0] ?? "");
				assert.equal(header.parentSession, undefined, "a standalone session has no parent link");
				await resumeSubagentSession(
					{
						resultsDir: testResultsDir(),
						parent: { parentCwd: process.cwd(), warnings: [] },
						sessionFile,
						task: "Resume probe.",
						mode,
					},
					resumeRuntime(),
				);
				assert.equal(await fixture.markerReached(), false, "the agent-only marker must not reach the resumed child");
			} finally {
				fixture.cleanup();
			}
		});
	}

	it("an older standalone session without launch metadata takes the named agent's current deny-env", async () => {
		const fixture = standaloneFixture("background");
		try {
			const sessionFile = join(fixture.dir, "legacy-standalone.jsonl");
			writePiHeader(sessionFile, fixture.dir);
			await resumeSubagentSession(
				{
					resultsDir: testResultsDir(),
					parent: { parentCwd: process.cwd(), warnings: [] },
					sessionFile,
					task: "Resume probe.",
					mode: "background",
					agent: "keeper",
				},
				resumeRuntime(),
			);
			assert.equal(await fixture.markerReached(), false);
		} finally {
			fixture.cleanup();
		}
	});

	for (const [label, agent] of [
		["no agent", undefined],
		["an agent without a definition", "vanished"],
	] as const) {
		it(`an older standalone session without launch metadata and ${label} is refused`, async () => {
			const fixture = standaloneFixture("background");
			try {
				const sessionFile = join(fixture.dir, "legacy-standalone.jsonl");
				writePiHeader(sessionFile, fixture.dir);
				await assert.rejects(
					resumeSubagentSession(
						{
							resultsDir: testResultsDir(),
							parent: { parentCwd: process.cwd(), warnings: [] },
							sessionFile,
							task: "Resume probe.",
							mode: "background",
							...(agent ? { agent } : {}),
						},
						resumeRuntime(),
					),
					/deny-env/,
				);
				assert.equal(existsSync(join(fixture.dir, "flags.log")), false, "no child started");
			} finally {
				fixture.cleanup();
			}
		});
	}
});

describe("a default-manual pane keeps its lifecycle on resume (T69)", () => {
	// T69: an interactive agent without an auto-exit key launches as a manual pane; its resume must
	// stay manual (PI_SUBAGENT_AUTO_EXIT empty), so the resumed child gets no subagent_done.
	it("an interactive launch with no auto-exit key resumes with auto-exit off", async () => {
		const fixture = standaloneFixture("interactive");
		try {
			const parentSession = join(fixture.dir, "parent.jsonl");
			writePiHeader(parentSession, fixture.dir);
			const launch = await coordinateSubagentLaunch(
				{ name: "keeper-run", title: "Keeper", task: "Keep.", agent: "keeper" },
				{
					cwd: fixture.dir,
					sessionManager: { getSessionFile: () => parentSession, getSessionId: () => "parent-session-id" },
				},
				{ mode: "interactive", undo: new LaunchUndo() },
			);
			assert.equal(launch.envVars.PI_SUBAGENT_AUTO_EXIT, "", "the launch runs as a manual pane");
			const sessionFile = launch.prepared.subagentSessionFile;
			if (!existsSync(sessionFile)) writePiHeader(sessionFile, fixture.dir);
			const running = await resumeSubagentSession(
				{
					resultsDir: testResultsDir(),
					parent: { parentCwd: process.cwd(), warnings: [] },
					sessionFile,
					task: "Resume probe.",
					mode: "interactive",
				},
				resumeRuntime(),
			);
			assert.equal(running.autoExit, false);
			const capsulePath = readFileSync(join(fixture.dir, "tmux.log"), "utf8").match(/run-child\.mjs' '([^']+)'/)?.[1];
			assert.ok(capsulePath, "the resume command invokes the capsule launcher");
			assert.equal(JSON.parse(readFileSync(capsulePath, "utf8")).overrides.PI_SUBAGENT_AUTO_EXIT, "");
		} finally {
			fixture.cleanup();
		}
	});
});
