import { mkdirSync, readdirSync } from "node:fs";
import { getSessionResultsDir } from "../../src/artifact-storage.ts";
import { launchInteractiveSubagent } from "../../src/launch/interactive.ts";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
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
] as const;

type FailingStep = "send-command" | "task-file";

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
	assert.ok(
		calls.some((call) => call.startsWith("kill-pane") && call.includes("%42")),
		`the failed launch must close pane %42: ${JSON.stringify(calls)}`,
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

async function resumeFailingInteractive(failing: FailingStep): Promise<void> {
	const tmux = installFakeTmux(failing);
	try {
		const { dir } = tmux;
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: new Date().toISOString(), cwd: dir })}\n`,
		);
		await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
			version: 1,
			timestamp: new Date().toISOString(),
			name: "resume-child",
			mode: "interactive",
			sessionMode: "lineage-only",
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
		const before = readFileSync(sessionFile);
		const resultsDir = join(testResultsDir(), `t30-${failing}`);
		const quietResult = async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 });
		await assert.rejects(
			resumeSubagentSession(
				{ resultsDir, parent: { parentCwd: dir, warnings: [] }, sessionFile, task: "Continue." },
				{
					isMuxAvailable: () => true,
					getShellReadyDelayMs: () => 0,
					watchBackgroundSubagent: quietResult,
					watchSubagent: quietResult,
					getWatcherSignal: (_running: unknown, controller: AbortController) => controller.signal,
					startWidgetRefresh: () => {},
					getContextWindow: () => undefined,
					runningSubagents: new Map(),
				},
			),
		);
		assertSurfaceClosedAndCapsuleGone(tmux);
		assert.ok(readFileSync(sessionFile).equals(before), "a failed resume keeps every byte of its session file");
		assert.deepEqual(existsSync(resultsDir) ? readdirSync(resultsDir) : [], [], "the run folder is given back");
	} finally {
		tmux.restore();
	}
}

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
});
