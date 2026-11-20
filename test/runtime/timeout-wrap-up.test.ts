import { once } from "node:events";
import { mkdirSync, readdirSync } from "node:fs";
import { restartSubagentForTimeoutWrapUp } from "../../src/runtime/timeout-wrap-up.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	existsSync,
	it,
	join,
	readFileSync,
	rmSync,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";
import { subagentDoneExtension } from "../support/project.ts";

const savedPiCommand = process.env.PI_SUBAGENT_PI_COMMAND;

async function readNonEmptyFileEventually(path: string): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (existsSync(path)) {
			const value = readFileSync(path, "utf8");
			if (value) return value;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

function makeMetadata(dir: string): PersistedSubagentLaunchMetadata {
	return {
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
		spawnBudget: 2,
		spawnableAgents: true,
		noContextFiles: false,
		noSession: true,
		agentConfigDir: dir,
		cwd: dir,
		boundarySystemPrompt: true,
		timeout: 10,
		timeoutWarnThreshold: "80%",
	};
}

function makeRunning(dir: string, sessionFile: string): RunningSubagent {
	const startTime = Date.now() - 8_000;
	return {
		id: "timeout-child",
		name: "timeout-child",
		task: "Do the long task",
		agent: "scout",
		mode: "background",
		phase: "running",
		parentClosePolicy: "terminate",
		async: true,
		autoExit: false,
		noSession: true,
		startTime,
		sessionFile,
		timeoutBudget: { timeoutSeconds: 10 },
		timeoutWarnThreshold: 80,
		timeoutWrapUp: { kind: "timeout", seconds: 10, threshold: 80 },
		modelRef: "test/model:off",
		launchMetadata: makeMetadata(dir),
	};
}

describe("timeout wrap-up restart", () => {
	afterEach(() => {
		if (savedPiCommand === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
		else process.env.PI_SUBAGENT_PI_COMMAND = savedPiCommand;
	});

	it("restarts the same background session with the original deadline and a report-only prompt", async () => {
		const dir = createTestDir();
		const stdinFile = join(dir, "stdin.txt");
		const envFile = join(dir, "env.txt");
		const argvFile = join(dir, "argv.txt");
		const pi = writeExecutable(
			dir,
			"capture-pi",
			`#!/usr/bin/env bash
printf '%s' "$PI_SUBAGENT_TIMEOUT_STARTED_AT|$PI_SUBAGENT_TIMEOUT_WRAP_UP|$PI_SUBAGENT_AUTO_EXIT|$PI_SUBAGENT_SPAWN_BUDGET" > "${envFile}"
printf '%s\n' "$@" > "${argvFile}"
cat > "${stdinFile}"
`,
		);
		process.env.PI_SUBAGENT_PI_COMMAND = pi;

		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: new Date().toISOString(), cwd: dir })}\n`,
		);
		const running = makeRunning(dir, sessionFile);

		await restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 });
		assert.ok(running.childProcess);
		await once(running.childProcess!, "exit");

		assert.equal(
			await readNonEmptyFileEventually(envFile),
			`${running.startTime}|1|1|0`,
			"the continuation must keep the original clock, force auto-exit, and revoke spawning",
		);
		const argv = await readNonEmptyFileEventually(argvFile);
		assert.match(argv, /--session/);
		assert.match(argv, new RegExp(sessionFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.doesNotMatch(argv, /--no-session/);

		const prompt = await readNonEmptyFileEventually(stdinFile);
		assert.match(prompt, /process restart.*does not reset/i);
		assert.match(prompt, /conversation inherited or forked.*consumed zero seconds/i);
		assert.match(prompt, /elapsed and remaining values.*authoritative/i);
		assert.match(prompt, /interrupted your previous active operation/i);
		assert.match(prompt, /Do not retry.*tool/i);
		assert.match(prompt, /Report your result now/i);
	});

	it("closes an interactive pane when restart fails after surface creation", async () => {
		const dir = createTestDir();
		const capsuleRoot = join(dir, "capsules");
		mkdirSync(capsuleRoot, { recursive: true });
		const binDir = dir;
		const tmuxLog = join(dir, "tmux.log");
		writeFileSync(tmuxLog, "");
		writeExecutable(
			binDir,
			"tmux",
			`#!/usr/bin/env bash
printf '%s\n' "$*" >> "${tmuxLog}"
case "$1" in
  new-window) printf '%%42\n' ;;
  send-keys) exit 1 ;;
esac
`,
		);
		const originalPath = process.env.PATH;
		const originalMux = process.env.PI_SUBAGENT_MUX;
		const originalTmux = process.env.TMUX;
		const originalShell = process.env.SHELL;
		process.env.PATH = `${binDir}:${originalPath ?? ""}`;
		process.env.PI_SUBAGENT_MUX = "tmux";
		process.env.TMUX = "fake-tmux-socket";
		process.env.SHELL = "/bin/sh";
		const originalCapsuleDir = process.env.PI_SUBAGENT_ENV_CAPSULE_DIR;
		process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = capsuleRoot;

		try {
			const sessionFile = join(dir, "interactive-child.jsonl");
			writeFileSync(
				sessionFile,
				`${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: new Date().toISOString(), cwd: dir })}\n`,
			);
			const running = makeRunning(dir, sessionFile);
			running.mode = "interactive";
			running.launchMetadata = { ...running.launchMetadata!, mode: "interactive" };

			await assert.rejects(
				restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 }),
				/send-keys|Command failed|tmux/i,
			);

			const log = readFileSync(tmuxLog, "utf8");
			assert.match(log, /new-window/);
			assert.match(log, /kill-pane -t %42/, "a partially created wrap-up pane must be closed on launch failure");
			assert.equal(
				existsSync(capsuleRoot) ? readdirSync(capsuleRoot).length : 0,
				0,
				"an unconsumed launch capsule must not survive a failed wrap-up delivery",
			);
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalMux === undefined) delete process.env.PI_SUBAGENT_MUX;
			else process.env.PI_SUBAGENT_MUX = originalMux;
			if (originalTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = originalTmux;
			if (originalShell === undefined) delete process.env.SHELL;
			else process.env.SHELL = originalShell;
			if (originalCapsuleDir === undefined) delete process.env.PI_SUBAGENT_ENV_CAPSULE_DIR;
			else process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = originalCapsuleDir;
		}
	});

	it("applies persisted deny-env to interactive wrap-up children", async () => {
		const dir = createTestDir();
		const capsuleRoot = join(dir, "capsules");
		mkdirSync(capsuleRoot, { recursive: true });
		const tmuxLog = join(dir, "tmux.log");
		writeFileSync(tmuxLog, "");
		writeExecutable(
			dir,
			"tmux",
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${tmuxLog}"
case "$1" in
  new-window) printf '%%42\\n' ;;
esac
`,
		);
		const originalPath = process.env.PATH;
		const originalMux = process.env.PI_SUBAGENT_MUX;
		const originalTmux = process.env.TMUX;
		const originalShell = process.env.SHELL;
		const originalKeep = process.env.WRAP_TEST_KEEP;
		const originalDenied = process.env.WRAP_TEST_DENIED;
		process.env.PATH = `${dir}:${originalPath ?? ""}`;
		process.env.PI_SUBAGENT_MUX = "tmux";
		process.env.TMUX = "fake-tmux-socket";
		process.env.SHELL = "/bin/sh";
		const originalCapsuleDir = process.env.PI_SUBAGENT_ENV_CAPSULE_DIR;
		process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = capsuleRoot;
		process.env.WRAP_TEST_KEEP = "kept";
		process.env.WRAP_TEST_DENIED = "secret";

		try {
			const sessionFile = join(dir, "interactive-child.jsonl");
			writeFileSync(
				sessionFile,
				`${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: new Date().toISOString(), cwd: dir })}\n`,
			);
			const running = makeRunning(dir, sessionFile);
			running.mode = "interactive";
			running.launchMetadata = { ...running.launchMetadata!, mode: "interactive", denyEnv: "WRAP_TEST_DENIED" };

			await restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 });

			const log = readFileSync(tmuxLog, "utf8");
			const capsuleMatch = log.match(/run-child\.mjs' '([^']+)'/);
			assert.ok(capsuleMatch, "expected the wrap-up command to invoke the capsule launcher");
			const capsule = JSON.parse(readFileSync(capsuleMatch[1], "utf8"));
			assert.equal(
				capsule.parentEnv.WRAP_TEST_DENIED,
				undefined,
				"persisted deny-env must filter the wrap-up child env",
			);
			assert.equal(capsule.parentEnv.WRAP_TEST_KEEP, "kept", "non-denied env must still flow");
			assert.equal(capsule.overrides.PI_SUBAGENT_AUTO_EXIT, "1", "wrap-up overrides must survive");
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalMux === undefined) delete process.env.PI_SUBAGENT_MUX;
			else process.env.PI_SUBAGENT_MUX = originalMux;
			if (originalTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = originalTmux;
			if (originalShell === undefined) delete process.env.SHELL;
			else process.env.SHELL = originalShell;
			if (originalKeep === undefined) delete process.env.WRAP_TEST_KEEP;
			else process.env.WRAP_TEST_KEEP = originalKeep;
			if (originalDenied === undefined) delete process.env.WRAP_TEST_DENIED;
			else process.env.WRAP_TEST_DENIED = originalDenied;
			if (originalCapsuleDir === undefined) delete process.env.PI_SUBAGENT_ENV_CAPSULE_DIR;
			else process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = originalCapsuleDir;
			rmSync(capsuleRoot, { recursive: true, force: true });
		}
	});

	// T69/T72: a pane's report-only replacement exits by itself (forced auto-exit), so like v2.9.2
	// (cf6dbf4 getDeniedToolNames with autoExit) it gets no subagent_done, manual or auto-exit.
	for (const autoExit of [false, true]) {
		it(`a ${autoExit ? "auto-exit" : "manual"} pane's wrap-up child has no subagent_done`, async () => {
			const dir = createTestDir();
			const capsuleRoot = join(dir, "capsules");
			mkdirSync(capsuleRoot, { recursive: true });
			const tmuxLog = join(dir, "tmux.log");
			writeFileSync(tmuxLog, "");
			writeExecutable(
				dir,
				"tmux",
				`#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${tmuxLog}"\ncase "$1" in new-window) printf '%%42\\n' ;; esac\n`,
			);
			const envKeys = ["PATH", "PI_SUBAGENT_MUX", "TMUX", "SHELL", "PI_SUBAGENT_ENV_CAPSULE_DIR"];
			const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
			process.env.PATH = `${dir}:${saved.PATH ?? ""}`;
			process.env.PI_SUBAGENT_MUX = "tmux";
			process.env.TMUX = "fake-tmux-socket";
			process.env.SHELL = "/bin/sh";
			process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = capsuleRoot;
			const childKeys = [
				"PI_DENY_TOOLS",
				"PI_SUBAGENT_AUTO_EXIT",
				"PI_SUBAGENT_SURFACE",
				"PI_SUBAGENT_TIMEOUT_WRAP_UP",
			];
			try {
				const sessionFile = join(dir, "pane-child.jsonl");
				writeFileSync(
					sessionFile,
					`${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: new Date().toISOString(), cwd: dir })}\n`,
				);
				const running = makeRunning(dir, sessionFile);
				running.mode = "interactive";
				running.autoExit = autoExit;
				running.launchMetadata = { ...running.launchMetadata!, mode: "interactive", autoExit };

				await restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 });

				const capsulePath = readFileSync(tmuxLog, "utf8").match(/run-child\.mjs' '([^']+)'/)?.[1];
				assert.ok(capsulePath, "expected the wrap-up command to invoke the capsule launcher");
				const { overrides } = JSON.parse(readFileSync(capsulePath, "utf8"));
				assert.equal(overrides.PI_SUBAGENT_AUTO_EXIT, "1", "the replacement still exits by itself");
				assert.ok(overrides.PI_SUBAGENT_SURFACE, "the replacement runs in a pane");
				for (const key of childKeys) process.env[key] = overrides[key] ?? "";
				const tools = new Set<string>();
				subagentDoneExtension({
					getAllTools: () => [],
					getActiveTools: () => [],
					setActiveTools() {},
					registerTool(definition: { name: string }) {
						tools.add(definition.name);
						return definition;
					},
					on() {},
					registerShortcut() {},
					appendEntry() {},
					registerCommand() {},
				} as any);
				assert.equal(tools.has("subagent_done"), false);
			} finally {
				for (const key of childKeys) delete process.env[key];
				for (const [key, value] of Object.entries(saved)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}
});
