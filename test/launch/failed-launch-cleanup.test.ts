import fs, { chmodSync, mkdirSync, readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { getSessionResultsDir } from "../../src/artifact-storage.ts";
import { launchBackgroundSubagent } from "../../src/launch/background.ts";
import { writeEnvCapsule } from "../../src/launch/env-capsule.ts";
import { launchInteractiveSubagent } from "../../src/launch/interactive.ts";
import { resumeSubagentSession, type ResumeServiceRuntime } from "../../src/runtime/resume-service.ts";
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
import { testResultsDir } from "../support/result-fixtures.ts";
import "../support/ambient-spawn-grant.ts";

// D6: a launch step that fails after the surface exists closes the surface, deletes the capsule,
// gives back the run folder and removes a seeded session file that no process opened. A failed
// resume does the same, except that it never changes the session it resumes.

const ENV_KEYS = [
	"PATH",
	"PI_SUBAGENT_MUX",
	"TMUX",
	"PI_SUBAGENT_ENV_CAPSULE_DIR",
	"PI_ARTIFACT_PROJECT_ROOT",
	"PI_SUBAGENT_PI_COMMAND",
] as const;

type FailingStep = "send-command" | "task-file" | "none";

/** The error each injected failure raises, so a test cannot pass on a different failure. */
function isInjectedFailure(failing: FailingStep): (error: unknown) => boolean {
	return (error) => {
		const { status, code } = error as { status?: unknown; code?: unknown };
		if (failing === "send-command") return status === 7;
		return code === "ENOTDIR" || code === "EEXIST";
	};
}

interface FakeTmux {
	dir: string;
	capsuleRoot: string;
	calls(): string[];
	restore(): void;
}

/** A tmux that opens pane %42 and logs every call; send-keys fails when the send step must fail. */
function installFakeTmux(failing: FailingStep): FakeTmux {
	const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	const dir = createTestDir();
	const binDir = join(dir, "bin");
	mkdirSync(binDir, { recursive: true });
	const log = join(dir, "tmux.log");
	writeExecutable(
		binDir,
		"tmux",
		`#!/usr/bin/env bash
echo "$@" >> '${log}'
case "$1" in
  new-window) printf '%%42\\n' ;;
  send-keys) exit ${failing === "send-command" ? 7 : 0} ;;
esac
`,
	);
	const capsuleRoot = join(dir, "capsules");
	mkdirSync(capsuleRoot, { recursive: true });
	process.env.PATH = `${binDir}:${saved.PATH ?? ""}`;
	process.env.PI_SUBAGENT_MUX = "tmux";
	process.env.TMUX = "fake-tmux-socket";
	process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = capsuleRoot;
	if (failing === "task-file") {
		// The artifact root is a file, so writing the task file throws after the pane exists.
		const notADirectory = join(dir, "not-a-dir");
		writeFileSync(notADirectory, "x");
		process.env.PI_ARTIFACT_PROJECT_ROOT = notADirectory;
	} else {
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(dir, "artifacts");
	}
	return {
		dir,
		capsuleRoot,
		calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
		restore() {
			for (const key of ENV_KEYS) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
		},
	};
}

function listFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));
}

function assertSurfaceClosedAndCapsuleGone(tmux: FakeTmux): void {
	const calls = tmux.calls();
	assert.ok(
		calls.some((call) => call.startsWith("new-window")),
		`the surface must exist before the failure: ${JSON.stringify(calls)}`,
	);
	assert.deepEqual(
		calls.filter((call) => call.startsWith("kill-pane")),
		["kill-pane -t %42"],
		`the failed launch closes pane %42 exactly once: ${JSON.stringify(calls)}`,
	);
	assert.deepEqual(readdirSync(tmux.capsuleRoot), [], "no capsule survives a failed launch");
}

async function launchFailingInteractive(failing: FailingStep): Promise<void> {
	const tmux = installFakeTmux(failing);
	try {
		const { dir } = tmux;
		mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(dir, ".pi", "agents", "cleanup-probe.md"),
			"---\nname: cleanup-probe\nauto-exit: true\nsession-mode: fork\n---\nProbe body.",
		);
		const parentSession = join(dir, "parent.jsonl");
		writeFileSync(
			parentSession,
			`${JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: new Date().toISOString(), cwd: dir })}\n`,
		);
		await assert.rejects(
			launchInteractiveSubagent(
				{ name: "cleanup-child", title: "Cleanup child", task: "Probe.", agent: "cleanup-probe" },
				{
					cwd: dir,
					sessionManager: {
						getSessionFile: () => parentSession,
						getSessionId: () => "parent",
						getLeafId: () => null,
					},
				},
				{ getContextWindow: () => undefined, getShellReadyDelayMs: () => 0 },
			),
			isInjectedFailure(failing),
		);
		assertSurfaceClosedAndCapsuleGone(tmux);
		const sessions = listFiles(dir).filter((file) => file.endsWith(".jsonl"));
		assert.deepEqual(sessions, [parentSession], "the seeded child session file is removed");
		const resultsDir = getSessionResultsDir(dir, "parent");
		assert.deepEqual(existsSync(resultsDir) ? readdirSync(resultsDir) : [], [], "the run folder is given back");
	} finally {
		tmux.restore();
	}
}

const quietResult = async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 });

function resumeRuntime(runningSubagents = new Map<string, RunningSubagent>()): ResumeServiceRuntime & {
	watched: string[];
} {
	const watched: string[] = [];
	const watch = async (running: RunningSubagent) => {
		watched.push(running.id);
		return quietResult();
	};
	return {
		watched,
		isMuxAvailable: () => true,
		getShellReadyDelayMs: () => 0,
		watchBackgroundSubagent: watch,
		watchSubagent: watch,
		getWatcherSignal: (_running: unknown, controller: AbortController) => controller.signal,
		startWidgetRefresh: () => {},
		getContextWindow: () => undefined,
		runningSubagents,
	};
}

/** A child session with launch metadata; a persisted model lets a resume carry a thinking override. */
async function writeResumableSession(dir: string, mode: "interactive" | "background"): Promise<string> {
	const sessionFile = join(dir, "child.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: new Date().toISOString(), cwd: dir })}\n`,
	);
	await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
		version: 1,
		timestamp: new Date().toISOString(),
		name: "resume-child",
		mode,
		sessionMode: "lineage-only",
		autoExit: true,
		parentClosePolicy: "terminate",
		async: true,
		model: "test/model",
		modelRef: "test/model:off",
		denyTools: [],
		noContextFiles: false,
		noSession: false,
		agentConfigDir: dir,
		cwd: dir,
		boundarySystemPrompt: false,
	});
	return sessionFile;
}

async function resumeFailingInteractive(failing: FailingStep): Promise<void> {
	const tmux = installFakeTmux(failing);
	try {
		const { dir } = tmux;
		const sessionFile = await writeResumableSession(dir, "interactive");
		// The previous run's verdicts: a failed resume must keep both (D6).
		writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
		writeFileSync(`${sessionFile}.timeout`, JSON.stringify({ kind: "timeout", blocksResume: false, budget: { timeoutSeconds: 30 } }));
		const sidecarsBefore = [readFileSync(`${sessionFile}.exit`), readFileSync(`${sessionFile}.timeout`)];
		const before = readFileSync(sessionFile);
		const resultsDir = join(testResultsDir(), `t30-${failing}`);
		await assert.rejects(
			resumeSubagentSession(
				{ resultsDir, parent: { parentCwd: dir, warnings: [] }, sessionFile, task: "Continue." },
				resumeRuntime(),
			),
			isInjectedFailure(failing),
		);
		assertSurfaceClosedAndCapsuleGone(tmux);
		assert.ok(readFileSync(sessionFile).equals(before), "a failed resume keeps every byte of its session file");
		assert.ok(readFileSync(`${sessionFile}.exit`).equals(sidecarsBefore[0]), "the previous exit sidecar is kept");
		assert.ok(readFileSync(`${sessionFile}.timeout`).equals(sidecarsBefore[1]), "the previous timeout sidecar is kept");
		assert.deepEqual(existsSync(resultsDir) ? readdirSync(resultsDir) : [], [], "the run folder is given back");
	} finally {
		tmux.restore();
	}
}

/** PI_SUBAGENT_PI_COMMAND names a missing executable: spawn returns a handle, then emits ENOENT. */
function useMissingPiCommand(dir: string): () => void {
	const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	process.env.PI_SUBAGENT_PI_COMMAND = join(dir, "removed-pi-wrapper");
	process.env.PI_ARTIFACT_PROJECT_ROOT = join(dir, "artifacts");
	return () => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	};
}

const isSpawnEnoent = (error: unknown) => (error as { code?: unknown }).code === "ENOENT";

describe("a failed launch removes what it made (D6)", () => {
	it("closes the surface when sending the command throws", async () => {
		await launchFailingInteractive("send-command");
	});

	it("closes the surface when writing the task file throws after the surface exists", async () => {
		await launchFailingInteractive("task-file");
	});

	it("closes the surface of a resume whose command send throws, and keeps the session bytes", async () => {
		await resumeFailingInteractive("send-command");
	});

	it("closes the surface of a resume whose task file write throws, and keeps the session bytes", async () => {
		await resumeFailingInteractive("task-file");
	});

	it("a background launch whose executable is missing leaves no seeded session and no run folder", async () => {
		const dir = createTestDir();
		const restore = useMissingPiCommand(dir);
		try {
			mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
			writeFileSync(
				join(dir, ".pi", "agents", "cleanup-probe.md"),
				"---\nname: cleanup-probe\nmode: background\nsession-mode: fork\n---\nProbe body.",
			);
			const parentSession = join(dir, "parent.jsonl");
			writeFileSync(
				parentSession,
				`${JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: new Date().toISOString(), cwd: dir })}\n`,
			);
			await assert.rejects(
				launchBackgroundSubagent(
					{ name: "cleanup-child", title: "Cleanup child", task: "Probe.", agent: "cleanup-probe" },
					{
						cwd: dir,
						sessionManager: {
							getSessionFile: () => parentSession,
							getSessionId: () => "parent",
							getLeafId: () => null,
						},
					},
					{ getContextWindow: () => undefined },
				),
				isSpawnEnoent,
			);
			const sessions = listFiles(dir).filter((file) => file.endsWith(".jsonl"));
			assert.deepEqual(sessions, [parentSession], "the seeded child session file is removed");
			const resultsDir = getSessionResultsDir(dir, "parent");
			assert.deepEqual(existsSync(resultsDir) ? readdirSync(resultsDir) : [], [], "the run folder is given back");
		} finally {
			restore();
		}
	});

	it("a background resume with a thinking override whose executable is missing keeps the session bytes", async () => {
		const dir = createTestDir();
		const restore = useMissingPiCommand(dir);
		try {
			const sessionFile = await writeResumableSession(dir, "background");
			const before = readFileSync(sessionFile);
			const resultsDir = join(testResultsDir(), "t30-missing-executable");
			const runtime = resumeRuntime();
			await assert.rejects(
				resumeSubagentSession(
					{ resultsDir, parent: { parentCwd: dir, warnings: [] }, sessionFile, task: "Continue.", thinking: "high" },
					runtime,
				),
				isSpawnEnoent,
			);
			assert.ok(readFileSync(sessionFile).equals(before), "no model override or launch metadata is appended");
			assert.deepEqual(existsSync(resultsDir) ? readdirSync(resultsDir) : [], [], "the run folder is given back");
			assert.equal(runtime.runningSubagents.size, 0);
		} finally {
			restore();
		}
	});
});

describe("a started child is never rolled back (D6)", () => {
	it("a resume whose metadata append fails after the send keeps the child registered and watched", async () => {
		const tmux = installFakeTmux("none");
		try {
			const sessionFile = await writeResumableSession(tmux.dir, "interactive");
			chmodSync(sessionFile, 0o444);
			const warnings: string[] = [];
			const runtime = resumeRuntime();
			const running = await resumeSubagentSession(
				{
					resultsDir: join(testResultsDir(), "t30-metadata-append"),
					parent: { parentCwd: tmux.dir, warnings },
					sessionFile,
					task: "Continue.",
					thinking: "high",
				},
				runtime,
			);
			assert.equal(runtime.runningSubagents.get(running.id), running, "the started child stays registered");
			assert.deepEqual(runtime.watched, [running.id], "the started child's watcher is installed");
			assert.ok(running.completionPromise, "the started child has a completion promise");
			assert.deepEqual(
				tmux.calls().filter((call) => call.startsWith("kill-pane")),
				[],
				"the started child's pane stays open",
			);
			assert.equal(warnings.length, 1, `the persistence failure is reported once: ${JSON.stringify(warnings)}`);
			assert.match(warnings[0], /EACCES|permission/i);
			await running.completionPromise;
		} finally {
			tmux.restore();
		}
	});
});

describe("the environment capsule writer owns its folder until it returns (D6)", () => {
	it("a failure after the capsule file exists leaves the capsule root empty", () => {
		const root = createTestDir();
		const injected = new Error("injected chmod failure");
		const chmod = mock.method(fs, "chmodSync", () => {
			throw injected;
		});
		syncBuiltinESMExports();
		try {
			assert.throws(
				() => writeEnvCapsule({ command: "pi", args: [], parentEnv: {}, overrides: {}, paneIdentityKeys: [] }, root),
				(error) => error === injected,
			);
		} finally {
			chmod.mock.restore();
			syncBuiltinESMExports();
		}
		assert.equal(chmod.mock.callCount(), 1, "the failure is injected after the file was written");
		assert.deepEqual(readdirSync(root), [], "no capsule folder survives a failed write");
	});
});
