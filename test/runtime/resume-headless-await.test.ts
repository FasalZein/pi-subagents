import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { foldMessages, runStub } from "../../src/runtime/context-fold.ts";
import { settleFold } from "../../src/runtime/context-fold-set.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import { writeSubagentLaunchMetadataEntry } from "../../src/session/session-files.ts";
import { registerSubagentResumeTool } from "../../src/tools/resume-tool.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	assert,
	createTestDir,
	getSubagentBatchStopMetadataForTest,
	resetSubagentStateForTest,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";
import { parentToolCtx } from "../support/result-fixtures.ts";

function writeAsyncChildSession(dir: string): string {
	const sessionFile = join(dir, "async-child.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "s",
			timestamp: new Date().toISOString(),
			cwd: dir,
		})}\n`,
	);
	writeSubagentLaunchMetadataEntry(sessionFile, {
		version: 1,
		timestamp: new Date().toISOString(),
		name: "async-child",
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

function registerResumeTool(reply?: (running: RunningSubagent) => unknown) {
	const awaited: RunningSubagent[] = [];
	const empty = async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 });
	const runtime = {
		isMuxAvailable: () => true,
		getShellReadyDelayMs: () => 0,
		watchBackgroundSubagent: empty,
		watchSubagent: empty,
		getWatcherSignal: (_running: unknown, controller: AbortController) => controller.signal,
		startWidgetRefresh: () => {},
		getContextWindow: () => undefined,
		runningSubagents: new Map<string, unknown>(),
		wireSubagentSteerBack: () => {},
		getLaunchedSubagentResult: async (running: RunningSubagent) => {
			awaited.push(running);
			if (reply) return reply(running);
			return { content: [{ type: "text", text: "completed" }], details: { status: "completed" } };
		},
	};
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	registerSubagentResumeTool(
		{
			registerTool(definition: { name: string }) {
				tools.set(definition.name, definition as never);
				return definition;
			},
		} as never,
		() => true,
		runtime as never,
	);
	return { tool: tools.get("subagent_resume")!, awaited };
}

function withFakePi<T>(bin: string, run: () => Promise<T>): Promise<T> {
	const original = process.env.PI_SUBAGENT_PI_COMMAND;
	const originalRoot = process.env.PI_ARTIFACT_PROJECT_ROOT;
	process.env.PI_SUBAGENT_PI_COMMAND = bin;
	process.env.PI_ARTIFACT_PROJECT_ROOT = dirname(bin);
	return run().finally(() => {
		if (original == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
		else process.env.PI_SUBAGENT_PI_COMMAND = original;
		if (originalRoot == null) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
		else process.env.PI_ARTIFACT_PROJECT_ROOT = originalRoot;
	});
}

describe("subagent_resume from a headless parent", () => {
	afterEach(() => resetSubagentStateForTest());

	it("awaits an async resume and does not end the turn when the parent has no UI", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "quiet-pi", "#!/usr/bin/env bash\nexit 0\n");
		await withFakePi(bin, async () => {
			const sessionFile = writeAsyncChildSession(dir);
			const { tool, awaited } = registerResumeTool();

			const result = (await tool.execute(
				"call-1",
				{ sessionFile },
				undefined,
				undefined,
				parentToolCtx(dir, { hasUI: false }),
			)) as {
				details: { status?: string };
				terminate?: true;
			};

			assert.equal(awaited.length, 1, "a headless parent must wait for the resumed child");
			assert.equal(awaited[0].blocking, true);
			assert.equal(awaited[0].async, false);
			assert.deepEqual(getSubagentBatchStopMetadataForTest(), {});
			assert.equal(result.details.status, "completed");
			assert.equal(result.terminate, undefined);
		});
	});

	it("keeps an async resume detached when the parent has a UI", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "quiet-pi", "#!/usr/bin/env bash\nexit 0\n");
		await withFakePi(bin, async () => {
			const sessionFile = writeAsyncChildSession(dir);
			const { tool, awaited } = registerResumeTool();

			const result = (await tool.execute(
				"call-1",
				{ sessionFile },
				undefined,
				undefined,
				parentToolCtx(dir, { hasUI: true }),
			)) as {
				details: { status?: string };
				terminate?: true;
			};

			assert.equal(awaited.length, 0);
			assert.equal(result.details.status, "started");
			assert.equal(result.terminate, true);
		});
	});
});

describe("subagent_resume reply and the settle fold (fold-waits review round 1)", () => {
	afterEach(() => resetSubagentStateForTest());

	it("a waited resume reply folds to its head and stub after use; a reply another extension changed stays", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "quiet-pi", "#!/usr/bin/env bash\nexit 0\n");
		const reportFile = join(dir, "report-1.md");
		writeFileSync(reportFile, "# report\n");
		await withFakePi(bin, async () => {
			const sessionFile = writeAsyncChildSession(dir);
			// The waited result as the wait gives it (wait-result.ts): the report and its saved path.
			const { tool } = registerResumeTool((running) => ({
				content: [{ type: "text", text: "RESUMED-REPORT" }],
				details: { id: running.id, name: running.name, status: "completed", outcome: "done", reportFile },
			}));
			const result = (await tool.execute("call-1", { sessionFile, task: "go on" }, undefined, undefined, {
				...parentToolCtx(dir, { hasUI: false }),
			})) as { content: { type: string; text: string }[]; details: { id: string } };
			const message = {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "subagent_resume",
				content: result.content,
				details: result.details,
				isError: false,
				timestamp: 1,
			};
			const entries = [
				{ type: "message", id: "e1", message: { role: "user", content: [{ type: "text", text: "resume" }] } },
				{ type: "message", id: "e2", message },
				{ type: "message", id: "e3", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
			];
			const runs = settleFold(entries, () => false, 100);
			assert.equal(runs.length, 1, "the waited resume commits its run");
			const folded = new Map(runs.map((run) => [run.id, run]));
			const [out] = foldMessages([message], folded) as (typeof message)[];
			const text = result.content[0].text;
			const head = text.slice(0, text.indexOf("\n\n"));
			assert.match(head, /This call waited for its children; each report follows below\.$/);
			assert.deepEqual(out.content, [{ type: "text", text: `${head}\n\n${runStub(runs[0])}` }]);
			const changed = { ...message, content: [{ type: "text", text: `${text}\n\nNOTE` }] };
			const list = [changed];
			assert.equal(foldMessages(list, folded), list, "a reply another extension changed stays full");
		});
	});
});
