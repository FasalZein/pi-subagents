import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSessionResultsDir } from "../../src/artifact-storage.ts";
import { launchBackgroundSubagent } from "../../src/launch/background.ts";
import { LAUNCH_FILE, RECORD_FILE } from "../../src/runtime/result-files.ts";
import { assert, createTestDir, describe, it, resetSubagentStateForTest, SESSION_HEADER } from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";

// T25 check 5: a continue child that ends after its parent process exited gets no result (D13). A
// restarted parent that looks up its run id gets "no result record" with the durable session file
// from the launch note, and launches nothing (D16). The launch is the production headless path with
// a fake pi; the restart is a fresh Node process, so no module state of the first parent survives.

const srcUrl = (path: string) => new URL(`../../${path}`, import.meta.url).href;

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

/** The restarted parent: a fresh extension instance whose subagent_wait looks up one run id. */
function lookupScript(cwd: string, sessionId: string, runId: string): string {
	return `
import { registerSubagentWaitTool } from ${JSON.stringify(srcUrl("src/tools/wait-tool.ts"))};
import { runningSubagents } from ${JSON.stringify(srcUrl("src/runtime/state.ts"))};
let tool;
registerSubagentWaitTool({ registerTool: (definition) => (tool = definition) }, () => true, { mayLaunch: () => true });
const ctx = { cwd: ${JSON.stringify(cwd)}, sessionManager: { getSessionId: () => ${JSON.stringify(sessionId)} } };
const reply = await tool.execute("c1", { ids: [${JSON.stringify(runId)}] }, undefined, undefined, ctx);
process.stdout.write(JSON.stringify({ text: reply.content[0].text, details: reply.details, running: runningSubagents.size }));
`;
}

async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!condition()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("T25 check 5: a continue child that ended after its parent exited", () => {
	it("a restarted parent gets no result record with the durable session file, and nothing is launched", async () => {
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

			const restart = join(cwd, "restart.mjs");
			writeFileSync(restart, lookupScript(cwd, sessionId, running.id));
			const child = spawnSync(process.execPath, [restart], {
				encoding: "utf8",
				env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PI_ARTIFACT_PROJECT_ROOT: artifacts },
			});
			assert.equal(child.status, 0, child.stderr);
			const reply = JSON.parse(child.stdout) as {
				text: string;
				details: { status: string; missing: { id: string; error: string }[] };
				running: number;
			};
			const expected = `No result record for "${running.id}". Its session file: ${running.sessionFile}`;
			assert.equal(reply.text, expected);
			assert.deepEqual(reply.details.missing, [{ id: running.id, error: expected }]);
			assert.equal(reply.details.status, "empty");
			assert.equal(reply.running, 0, "the restarted parent launched nothing");
			assert.deepEqual(readdirSync(resultsDir), [running.id], "no new run folder: nothing launched");
		} finally {
			if (saved.command === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = saved.command;
			if (saved.root === undefined) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
			else process.env.PI_ARTIFACT_PROJECT_ROOT = saved.root;
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
