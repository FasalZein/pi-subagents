import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSessionResultsDir } from "../../src/artifact-storage.ts";
import { launchBackgroundSubagent } from "../../src/launch/background.ts";
import { LAUNCH_FILE, RECORD_FILE } from "../../src/runtime/result-files.ts";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	assert,
	createTestDir,
	describe,
	it,
	resetSubagentStateForTest,
	SESSION_HEADER,
	writeSubagentLaunchMetadataEntryForTest,
} from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";

// T25 check 5: a continue child that ends after its parent process exited gets no result (D13). The
// launch note in its run folder keeps the durable session file for a restarted parent or a person
// (owner 2026-11-24: no wait tool, so no lookup by run id; the note is read as a file). The launch is the production headless path with
// a fake pi; the restart is a fresh Node process, so no module state of the first parent survives.

/** The session file the run folder's launch note names, read from disk as a restarted parent would. */
function launchNoteSessionFile(resultsDir: string, runId: string): unknown {
	return (JSON.parse(readFileSync(join(resultsDir, runId, LAUNCH_FILE), "utf8")) as { sessionFile?: unknown })
		.sessionFile;
}

/** A fake headless child: it outlives its parent, appends to its session file, and exits. */
const FAKE_CHILD = [
	"const fs = require('node:fs');",
	"const session = process.argv[process.argv.indexOf('--session') + 1];",
	"process.stdin.resume();",
	"setTimeout(() => {",
	"  fs.appendFileSync(session, JSON.stringify({ type: 'custom', customType: 'fake-child-ended', id: 'z1', parentId: null }) + '\\n');",
	"  process.exit(0);",
	"}, 200);",
].join("\n");

async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!condition()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("T25 check 5: a continue child that ended after its parent exited", () => {
	it("no result record for a run nobody watched; its launch note names the durable session file", async () => {
		const cwd = realpathSync(createTestDir());
		const artifacts = join(cwd, "artifacts");
		const saved = { command: process.env.PI_SUBAGENT_PI_COMMAND, root: process.env.PI_ARTIFACT_PROJECT_ROOT };
		const fakeChild = join(cwd, "fake-child.cjs");
		writeFileSync(fakeChild, FAKE_CHILD);
		process.env.PI_SUBAGENT_PI_COMMAND = `${process.execPath} ${fakeChild}`;
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifacts;
		try {
			mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
			writeFileSync(
				join(cwd, ".pi", "agents", "keeper.md"),
				"---\nname: keeper\nmode: background\nparent-close-policy: continue\n---\nKeep going.\n",
			);
			const parentSession = join(cwd, "parent.jsonl");
			writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);
			const sessionId = "t25-continue-parent";
			const running = await launchBackgroundSubagent(
				{ name: "keeper", title: "Keeper", task: "Keep going.", agent: "keeper" },
				{
					cwd,
					sessionManager: {
						getSessionFile: () => parentSession,
						getSessionId: () => sessionId,
						getLeafId: () => null,
					},
				},
				{ getContextWindow: () => undefined },
			);
			assert.equal(running.parentClosePolicy, "continue");
			// The parent exits now: nobody watches the run, so it never publishes a record (D13).
			resetSubagentStateForTest();
			await until(
				() => existsSync(running.sessionFile) && readFileSync(running.sessionFile, "utf8").includes("fake-child-ended"),
				"the child to end after its parent",
			);
			const resultsDir = getSessionResultsDir(cwd, sessionId);
			const runFolder = join(resultsDir, running.id);
			assert.equal(existsSync(join(runFolder, RECORD_FILE)), false, "no result for a run nobody watched");
			assert.ok(existsSync(join(runFolder, LAUNCH_FILE)), "the launch note stays in the run folder");

			assert.equal(launchNoteSessionFile(resultsDir, running.id), running.sessionFile);
			assert.deepEqual(readdirSync(resultsDir), [running.id], "no new run folder: nothing launched");
		} finally {
			if (saved.command === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = saved.command;
			if (saved.root === undefined) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
			else process.env.PI_ARTIFACT_PROJECT_ROOT = saved.root;
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("fix round 1: a resume by a relative session file keeps the absolute path in its launch note, read from another directory", async () => {
		const resumeDir = realpathSync(createTestDir());
		const otherDir = realpathSync(createTestDir());
		const parentCwd = realpathSync(createTestDir());
		const artifacts = join(parentCwd, "artifacts");
		const saved = {
			command: process.env.PI_SUBAGENT_PI_COMMAND,
			root: process.env.PI_ARTIFACT_PROJECT_ROOT,
			cwd: process.cwd(),
		};
		const fakeChild = join(resumeDir, "fake-child.cjs");
		writeFileSync(fakeChild, FAKE_CHILD);
		process.env.PI_SUBAGENT_PI_COMMAND = `${process.execPath} ${fakeChild}`;
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifacts;
		const header = (dir: string) =>
			`${JSON.stringify({ type: "session", version: 3, id: "child-session", timestamp: new Date().toISOString(), cwd: dir })}\n`;
		try {
			// Review b2 g2 P1: a relative session file names a file of the parent session's project, as in
			// Pi, not of the directory the parent process runs in.
			const childSession = join(parentCwd, "child.jsonl");
			writeFileSync(childSession, header(parentCwd));
			// The same relative name exists where the parent process runs: it must not be named.
			writeFileSync(join(otherDir, "child.jsonl"), header(otherDir));
			await writeSubagentLaunchMetadataEntryForTest(childSession, {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "keeper",
				agent: "keeper",
				mode: "background",
				sessionMode: "lineage-only",
				autoExit: true,
				parentClosePolicy: "continue",
				async: true,
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: resumeDir,
				cwd: resumeDir,
				boundarySystemPrompt: false,
			});
			const sessionId = "t25-relative-resume";
			process.chdir(otherDir);
			const quiet = new Promise<never>(() => {});
			const running = await resumeSubagentSession(
				{
					resultsDir: getSessionResultsDir(parentCwd, sessionId),
					parentSessionId: "test-parent",
					parent: { parentCwd, warnings: [] },
					sessionFile: "child.jsonl",
					task: "Keep going.",
				},
				{
					isMuxAvailable: () => true,
					getShellReadyDelayMs: () => 0,
					watchBackgroundSubagent: () => quiet,
					watchSubagent: () => quiet,
					getWatcherSignal: (_running: unknown, controller: AbortController) => controller.signal,
					startWidgetRefresh: () => {},
					getContextWindow: () => undefined,
					runningSubagents: new Map<string, RunningSubagent>(),
				},
			);
			assert.equal(running.sessionFile, childSession, "the running child names the absolute session file");
			// The parent exits while the continue child runs; it reopens the session from another directory.
			resetSubagentStateForTest();
			assert.equal(launchNoteSessionFile(getSessionResultsDir(parentCwd, sessionId), running.id), childSession);
		} finally {
			process.chdir(saved.cwd);
			if (saved.command === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = saved.command;
			if (saved.root === undefined) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
			else process.env.PI_ARTIFACT_PROJECT_ROOT = saved.root;
		}
	});
});
