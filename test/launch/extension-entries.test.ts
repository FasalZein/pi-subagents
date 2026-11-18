import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { buildChildLaunchPlan } from "../../src/launch/child-launch-plan.ts";
import { dropMissingExtensionEntries } from "../../src/launch/extension-entries.ts";
import { getExtensionLaunchArgs } from "../../src/launch/prep.ts";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { RESULT_TEXT_MAX_CHARS } from "../../src/runtime/result-render.ts";
import { writeSubagentExitSidecar } from "../../src/session/exit-sidecar.ts";
import { writeSubagentLaunchMetadataEntry, type PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import { registerSubagentResumeTool } from "../../src/tools/resume-tool.ts";
import { registerSubagentCoreTools, type SubagentToolRuntime } from "../../src/tools/subagent-tools.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	afterEach,
	assert,
	createSessionFile,
	createTestDir,
	describe,
	getLaunchedSubagentResultForTest,
	it,
	mkdirSync,
	resetSubagentStateForTest,
	setRunningSubagentForTest,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";
import { assistantText, LONG_ANSWER } from "../support/result-delivery.ts";
import { parentToolCtx, testResultsDir } from "../support/result-fixtures.ts";

const GONE_GIT = "git:github.com/nobody/gone-extension";
const GONE_NPM = "npm:gone-extension-package";

function countOf(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

function planFor(cwd: string, extensions: string | undefined, agentDir = join(cwd, "agent-root")) {
	mkdirSync(agentDir, { recursive: true });
	return buildChildLaunchPlan({
		params: { name: "ext-check", task: "check", title: "Extension check", agent: "reviewer" },
		agentDefs: { ...(extensions !== undefined ? { extensions } : {}), env: `PI_CODING_AGENT_DIR=${agentDir}` },
		parentCwd: cwd,
		parentSessionDir: join(cwd, "parent-sessions"),
		mode: "background",
	});
}

describe("extension entries that are gone (D10)", () => {
	afterEach(() => resetSubagentStateForTest());

	it("drops a deleted local path, an uninstalled git entry and an uninstalled npm entry, and keeps the rest", async () => {
		const cwd = createTestDir();
		const present = join(cwd, "present.ts");
		writeFileSync(present, "export default () => {};\n");
		const gone = join(cwd, "deleted.ts");
		const plan = await planFor(cwd, [present, gone, GONE_GIT, GONE_NPM].join(","));
		assert.deepEqual(plan.capability.extensions, [present]);
		assert.deepEqual(plan.capability.droppedExtensions, [gone, GONE_GIT, GONE_NPM]);
	});

	it("keeps every entry that resolves, so the child arguments stay as before", async () => {
		const cwd = createTestDir();
		const agentDir = join(cwd, "agent-root");
		const npmRoot = join(agentDir, "npm", "node_modules", "pi-fancy-footer");
		const gitRoot = join(agentDir, "git", "github.com", "example", "footer-extension");
		mkdirSync(npmRoot, { recursive: true });
		mkdirSync(gitRoot, { recursive: true });
		writeFileSync(join(npmRoot, "package.json"), JSON.stringify({ name: "pi-fancy-footer", version: "1.4.0" }));
		writeFileSync(join(gitRoot, "package.json"), JSON.stringify({ name: "footer-extension", version: "2.0.0" }));
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["npm:pi-fancy-footer", "git:github.com/example/footer-extension@v2"] }),
		);
		const local = join(cwd, "local.ts");
		writeFileSync(local, "export default () => {};\n");
		const plan = await planFor(cwd, `npm:pi-fancy-footer,git:github.com/example/footer-extension@v2,${local}`, agentDir);
		assert.deepEqual(plan.capability.droppedExtensions, []);
		// A configured npm package and an exact git ref reuse their installation; the local path passes as written.
		assert.deepEqual(plan.capability.extensions, [npmRoot, gitRoot, local]);
		assert.deepEqual(getExtensionLaunchArgs(plan.capability.extensions, "/done.ts", false), [
			"--no-extensions", "-e", "/done.ts", "-e", npmRoot, "-e", gitRoot, "-e", local,
		]);
	});

	it("starts an empty explicit list with only the mandatory entry, and keeps the default without a list", async () => {
		const cwd = createTestDir();
		const empty = await planFor(cwd, "none");
		assert.deepEqual(empty.capability.extensions, []);
		assert.deepEqual(getExtensionLaunchArgs(empty.capability.extensions, "/done.ts", false), ["--no-extensions", "-e", "/done.ts"]);
		const none = await planFor(cwd, undefined);
		assert.equal(none.capability.extensions, undefined);
		assert.deepEqual(none.capability.droppedExtensions, []);
		assert.deepEqual(getExtensionLaunchArgs(none.capability.extensions, "/done.ts", false), ["-e", "/done.ts"]);
	});

	it("never drops the pi-subagents entry, so a missing one still fails the start in Pi", () => {
		const cwd = createTestDir();
		const mandatory = join(cwd, "gone", "pi-subagents", "src", "index.ts");
		const check = dropMissingExtensionEntries([mandatory, join(cwd, "gone.ts")], { cwd, agentDir: join(cwd, "agent") });
		assert.deepEqual(check.kept, [mandatory]);
		assert.deepEqual(check.dropped, [join(cwd, "gone.ts")]);
	});

	it("resumes a saved session whose list names gone entries and names each dropped entry in the reply", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "quiet-pi", "#!/usr/bin/env bash\nexit 0\n");
		const present = join(dir, "present.ts");
		writeFileSync(present, "export default () => {};\n");
		const gone = join(dir, "deleted-extension.ts");
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: dir })}\n`);
		writeSubagentLaunchMetadataEntry(sessionFile, {
			version: 1,
			timestamp: new Date().toISOString(),
			name: "ext-child",
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
			extensions: [present, gone, GONE_GIT, GONE_NPM],
		} as PersistedSubagentLaunchMetadata);
		const started: RunningSubagent[] = [];
		const empty = async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 });
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		registerSubagentResumeTool(
			{ registerTool: (definition: { name: string }) => tools.set(definition.name, definition as never) } as never,
			() => true,
			{
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
					started.push(running);
					return { content: [{ type: "text", text: "completed" }], details: { status: "completed" } };
				},
			} as never,
		);
		const originalCommand = process.env.PI_SUBAGENT_PI_COMMAND;
		const originalRoot = process.env.PI_ARTIFACT_PROJECT_ROOT;
		process.env.PI_SUBAGENT_PI_COMMAND = bin;
		process.env.PI_ARTIFACT_PROJECT_ROOT = dirname(bin);
		try {
			const result = (await tools.get("subagent_resume")!.execute("call-1", { sessionFile }, undefined, undefined, parentToolCtx(dir, { hasUI: false }))) as {
				content: Array<{ text: string }>;
			};
			const reply = result.content.map((block) => block.text).join("\n\n");
			for (const entry of [gone, GONE_GIT, GONE_NPM]) {
				assert.equal(countOf(reply, `dropped missing extension: ${entry}`), 1, reply);
			}
			const args = started[0].childProcess?.spawnargs ?? [];
			assert.ok(args.includes(present), args.join(" "));
			for (const entry of [gone, GONE_GIT, GONE_NPM]) assert.ok(!args.includes(entry), args.join(" "));
		} finally {
			if (originalCommand == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = originalCommand;
			if (originalRoot == null) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
			else process.env.PI_ARTIFACT_PROJECT_ROOT = originalRoot;
		}
	});

	it("names all 12 dropped entries of a waiting launch once and keeps its rendering within 1,900 characters", async () => {
		const cwd = createTestDir();
		const gone = Array.from({ length: 12 }, (_, index) => join(cwd, "removed-extensions", `gone-extension-${index + 1}.ts`));
		const plan = await planFor(cwd, gone.join(","));
		assert.deepEqual(plan.capability.droppedExtensions, gone);
		const sessionFile = createSessionFile(cwd, [assistantText(LONG_ANSWER)]);
		writeSubagentExitSidecar(sessionFile, { type: "done" });
		const child = new EventEmitter() as ChildProcess;
		const tools = new Map<string, any>();
		const runtime: SubagentToolRuntime = {
			loadAgentDefaults: () => ({ spawning: false, async: false, mode: "background" }),
			resolveEffectiveSessionMode: () => "lineage-only",
			resolveTaskSessionMode: () => "lineage-only",
			launchBackgroundSubagent: async (params) => {
				const store = new ResultStore(testResultsDir(), () => {});
				const reservation = store.reserve();
				const running: RunningSubagent = {
					id: reservation.runId,
					name: params.name,
					task: params.task,
					title: params.title,
					agent: params.agent,
					mode: "background",
					executionState: "running",
					deliveryState: "detached",
					parentClosePolicy: "terminate",
					blocking: params.blocking,
					async: params.async,
					startTime: Date.now(),
					sessionFile,
					childProcess: child,
					droppedExtensions: plan.capability.droppedExtensions,
					resultTarget: { store, reservation, parentCwd: cwd, warnings: [] },
				};
				setRunningSubagentForTest(running);
				return running;
			},
			launchSubagent: async () => {
				throw new Error("headless parents never open a pane");
			},
			watchBackgroundSubagent: (running, signal) => {
				const done = watchBackgroundSubagent(running, { cleanupNoSessionSessionFile() {}, terminateBackgroundChildProcess() {} }, signal);
				setImmediate(() => child.emit("exit", 0));
				return done;
			},
			watchSubagent: async () => new Promise(() => {}),
			getWatcherSignal: (_running, controller) => controller.signal,
			wireSubagentSteerBack: () => {},
			startWidgetRefresh: () => {},
			getLaunchedSubagentResult: (running, signal) => getLaunchedSubagentResultForTest(running, signal),
			stopRunningSubagent: async () => {},
			muxUnavailableResult: () => ({ content: [{ type: "text", text: "mux" }], details: {} }),
			listLaunchableAgents: () => [],
		};
		registerSubagentCoreTools(
			{ registerTool: (definition: any) => tools.set(definition.name, definition), getThinkingLevel: () => "low" } as any,
			() => true,
			runtime,
		);
		const result = await tools.get("subagent").execute(
			"call-1",
			{ children: [{ agent: "scout", name: "ext-scout", title: "Recon", task: "Recon", blocking: true }] },
			undefined,
			undefined,
			{ hasUI: false, cwd, sessionManager: { getSessionFile: () => join(cwd, "parent.jsonl"), getSessionId: () => "parent" } },
		);
		assert.equal(result.content.length, 1, "the launch emits one reply");
		const reply: string = result.content[0].text;
		for (const entry of gone) assert.equal(countOf(reply, `dropped missing extension: ${entry}`), 1, reply);
		const head = reply.slice(0, reply.indexOf("\n\n"));
		const rendering = reply.slice(head.length + 2);
		assert.ok(rendering.includes("run: "), rendering);
		assert.ok(!rendering.includes("dropped missing extension"), "the drop lines stay outside the result frame");
		assert.ok(rendering.length <= RESULT_TEXT_MAX_CHARS, `rendering is ${rendering.length} characters`);
		assert.equal(RESULT_TEXT_MAX_CHARS, 1900);
	});
});
