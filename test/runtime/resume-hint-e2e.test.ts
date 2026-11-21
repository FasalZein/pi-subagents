import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getSessionResultsDir } from "../../src/artifact-storage.ts";
import { assembleResult } from "../../src/runtime/result-assembler.ts";
import { parseRunId, type ResultRecord } from "../../src/runtime/result-record.ts";
import { renderResult } from "../../src/runtime/result-render.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import { writeSubagentLaunchMetadataEntry } from "../../src/session/session-files.ts";
import { registerSubagentResumeTool } from "../../src/tools/resume-tool.ts";
import { assert, createTestDir, resetSubagentStateForTest, writeExecutable, writeFileSync } from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";
import { assistant, facts, parentToolCtx, sessionHeader } from "../support/result-fixtures.ts";

/**
 * Stands in for Pi in print mode (main.js readPipedStdin, then prepareInitialMessage): piped stdin is the
 * initial message, and only an initial message prompts the session, so only then a user turn is appended
 * to the --session file. Empty stdin prompts nothing.
 */
const FAKE_PRINT_MODE_PI = `#!/usr/bin/env node
const fs = require("node:fs");
const session = process.argv[process.argv.indexOf("--session") + 1];
const message = fs.readFileSync(0, "utf8");
if (message.trim()) {
	const entry = { type: "message", message: { role: "user", content: [{ type: "text", text: message }] } };
	fs.appendFileSync(session, JSON.stringify(entry) + "\\n");
}
`;

function writeBackgroundChildSession(dir: string): string {
	const sessionFile = join(dir, "timed-out-child.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: dir })}\n`,
	);
	writeSubagentLaunchMetadataEntry(sessionFile, {
		version: 1,
		timestamp: new Date().toISOString(),
		name: "timed-out-child",
		mode: "background",
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
	} as PersistedSubagentLaunchMetadata);
	return sessionFile;
}

function resumeTool() {
	const empty = async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 });
	let tool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
	registerSubagentResumeTool({ registerTool: (definition: never) => (tool = definition) } as never, () => true, {
		isMuxAvailable: () => true,
		getShellReadyDelayMs: () => 0,
		watchBackgroundSubagent: empty,
		watchSubagent: empty,
		getWatcherSignal: (_running: unknown, controller: AbortController) => controller.signal,
		startWidgetRefresh: () => {},
		getContextWindow: () => undefined,
		runningSubagents: new Map(),
		wireSubagentSteerBack: () => {},
		getLaunchedSubagentResult: async () => ({ content: [], details: {} }),
	} as never);
	return tool!;
}

/** The arguments of the subagent_resume call the result text shows, as a parent would copy them. */
function shownResumeArgs(text: string, task: string): Record<string, unknown> {
	const call = /^resume: subagent_resume\((\{.*\})\)/m.exec(text)?.[1];
	assert.ok(call, `the result names the resume call:\n${text}`);
	const filled = call.replace(/task: "<[^">]+>"/, `task: ${JSON.stringify(task)}`);
	return JSON.parse(filled.replace(/([{,]\s*)(\w+):/g, '$1"$2":'));
}

async function userTurns(sessionFile: string, until: number): Promise<string[]> {
	const read = () =>
		readFileSync(sessionFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.type === "message" && entry.message.role === "user")
			.map((entry) => entry.message.content[0].text);
	const deadline = Date.now() + 5_000;
	while (read().length < until && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
	return read();
}

// T88 fix round 1 (review P1): a background child resumed without a task gets no prompt, so the
// displayed resume call must carry a task the parent fills in. End to end without a live Pi: the
// rendered call, with the placeholder filled, submits one new user turn to the same session file.
describe("T88 resume hint, end to end", () => {
	afterEach(() => resetSubagentStateForTest());

	it("the displayed call with its task filled in prompts the same session", async () => {
		const dir = createTestDir();
		const saved = { pi: process.env.PI_SUBAGENT_PI_COMMAND, root: process.env.PI_ARTIFACT_PROJECT_ROOT };
		process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(dir, "fake-pi", FAKE_PRINT_MODE_PI);
		process.env.PI_ARTIFACT_PROJECT_ROOT = dir;
		try {
			const sessionFile = writeBackgroundChildSession(dir);
			const ctx = parentToolCtx(dir, { hasUI: true });
			const runId = "aaaa0001";
			const assembled = assembleResult(
				facts([sessionHeader(), assistant("partial work")], { runId: parseRunId(runId), resume: { resumable: true } }),
			).record;
			const record: ResultRecord = {
				...assembled,
				sessionFile,
				timeLimit: { kind: "timeout", seconds: 900, wrapUp: true },
				report: { saved: false, error: "fixture" },
			};
			const resultsDir = getSessionResultsDir(dir, ctx.sessionManager.getSessionId());
			mkdirSync(join(resultsDir, runId), { recursive: true });
			writeFileSync(join(resultsDir, runId, "record.json"), JSON.stringify(record));

			const text = renderResult(record, { cwd: dir, homeDir: "/nonexistent-home" });
			const task = "Write the summary file and stop";
			const args = shownResumeArgs(text, task);
			assert.deepEqual(args, { runId, task });

			await resumeTool().execute("r1", args, undefined, undefined, ctx);
			assert.deepEqual(await userTurns(sessionFile, 1), [task], "one new user turn in the same session");
		} finally {
			for (const [name, value] of [
				["PI_SUBAGENT_PI_COMMAND", saved.pi],
				["PI_ARTIFACT_PROJECT_ROOT", saved.root],
			] as const) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});
});
