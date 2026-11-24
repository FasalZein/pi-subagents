import { once } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { restartSubagentForTimeoutWrapUp } from "../../src/runtime/timeout-wrap-up.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
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

// Review b2 g2 P1 (two findings). A resume reads its project and its deny-env from the resumed
// session, never from the directory the parent process started in, and every process generation of
// one run (the resume and its time-limit wrap-up replacement) gets the same deny-env.

/** A synthetic marker; tests record only whether a child received it, never its value. */
const MARKER = "RESUME_AUTHORITY_TEST_DENY";

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

async function readLinesEventually(path: string, count: number): Promise<string[]> {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (existsSync(path)) {
			const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
			if (lines.length >= count) return lines;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${count} line(s) in ${path}`);
}

/** A fake headless Pi that appends one presence flag of the marker per process generation. */
function fixture() {
	const dir = createTestDir();
	const flagsLog = join(dir, "flags.log");
	const saved = { command: process.env.PI_SUBAGENT_PI_COMMAND, agentDir: process.env.PI_CODING_AGENT_DIR };
	process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(
		dir,
		"capture-pi",
		`#!/usr/bin/env bash\ncat > /dev/null\n[ -n "\${${MARKER}+x}" ] && echo present >> '${flagsLog}' || echo absent >> '${flagsLog}'\n`,
	);
	process.env[MARKER] = "parent-value";
	return {
		dir,
		flags: (count: number) => readLinesEventually(flagsLog, count),
		cleanup() {
			delete process.env[MARKER];
			if (saved.command === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = saved.command;
			if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function writePiHeader(sessionFile: string, cwd: string): void {
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: new Date().toISOString(), cwd })}\n`,
	);
}

describe("resume authority (b2 g2)", () => {
	for (const pathKind of ["relative", "absolute"] as const) {
		it(`a session without launch metadata resumes with its own project's agent (${pathKind} session file)`, async () => {
			const f = fixture();
			try {
				// Project A: the parent session's project. Its agent denies the marker.
				const projectA = join(f.dir, "project-a");
				mkdirSync(join(projectA, ".pi", "agents"), { recursive: true });
				writeFileSync(
					join(projectA, ".pi", "agents", "keeper.md"),
					`---\nname: keeper\nmode: background\ndeny-env: ${MARKER}\n---\nProject keeper.\n`,
				);
				// The same-name global agent denies nothing.
				const globalDir = join(f.dir, "global-agent");
				mkdirSync(join(globalDir, "agents"), { recursive: true });
				writeFileSync(
					join(globalDir, "agents", "keeper.md"),
					"---\nname: keeper\nmode: background\n---\nGlobal keeper.\n",
				);
				process.env.PI_CODING_AGENT_DIR = globalDir;
				writePiHeader(join(projectA, "child.jsonl"), projectA);
				// Directory B (this process's cwd) holds no such session file.
				assert.equal(existsSync(join(process.cwd(), "child.jsonl")), false);

				const running = await resumeSubagentSession(
					{
						resultsDir: testResultsDir(),
						parentSessionId: "test-parent",
						parent: { parentCwd: projectA, warnings: [] },
						sessionFile: pathKind === "relative" ? "child.jsonl" : join(projectA, "child.jsonl"),
						task: "Resume probe.",
						mode: "background",
						agent: "keeper",
					},
					resumeRuntime(),
				);
				assert.equal(running.sessionFile, join(projectA, "child.jsonl"));
				assert.deepEqual(await f.flags(1), ["absent"], "the project agent's deny-env must apply");
			} finally {
				f.cleanup();
			}
		});
	}

	it("the resume and its wrap-up replacement take the first launch entry's deny-env", async () => {
		const f = fixture();
		try {
			const sessionFile = join(f.dir, "child.jsonl");
			writePiHeader(sessionFile, f.dir);
			const first: PersistedSubagentLaunchMetadata = {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "authority-child",
				agent: "scout",
				mode: "background",
				sessionMode: "lineage-only",
				autoExit: true,
				parentClosePolicy: "terminate",
				async: true,
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: f.dir,
				cwd: f.dir,
				boundarySystemPrompt: false,
				timeout: 600,
				timeoutWarnThreshold: "80%",
				denyEnv: MARKER,
			};
			await writeSubagentLaunchMetadataEntryForTest(sessionFile, first);
			// A later entry (the child can append to its own session) names another deny-env.
			await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
				...first,
				timestamp: new Date().toISOString(),
				denyEnv: "RESUME_AUTHORITY_TEST_OTHER",
			});

			const running = await resumeSubagentSession(
				{
					resultsDir: testResultsDir(),
					parentSessionId: "test-parent",
					parent: { parentCwd: f.dir, warnings: [] },
					sessionFile,
					task: "Resume probe.",
				},
				resumeRuntime(),
			);
			assert.deepEqual(await f.flags(1), ["absent"], "the resumed process must not receive the marker");
			running.phase = {
				kind: "soft-limit",
				wrapUp: { wrapUp: { kind: "timeout", seconds: 600, threshold: 80 }, deadlineAt: 0 },
			};
			await restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 });
			if (running.childProcess && running.childProcess.exitCode === null) await once(running.childProcess, "exit");
			assert.deepEqual(await f.flags(2), ["absent", "absent"], "the replacement must not receive the marker either");
		} finally {
			f.cleanup();
		}
	});
});
