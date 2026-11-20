import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildChildLaunchPlan } from "../../src/launch/child-launch-plan.ts";
import { dropMissingExtensionEntries } from "../../src/launch/extension-entries.ts";
import { getExtensionLaunchArgs, getSubagentsExtensionPath } from "../../src/launch/prep.ts";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { RESULT_TEXT_MAX_CHARS } from "../../src/runtime/result-render.ts";
import { writeSubagentExitSidecar } from "../../src/session/exit-sidecar.ts";
import {
	type PersistedSubagentLaunchMetadata,
	writeSubagentLaunchMetadataEntry,
} from "../../src/session/session-files.ts";
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

async function resumeSavedSession(
	dir: string,
	extensions: string[],
	extra: Partial<PersistedSubagentLaunchMetadata> = {},
): Promise<{ reply: string; started: RunningSubagent[] }> {
	const bin = writeExecutable(dir, "quiet-pi", "#!/usr/bin/env bash\nexit 0\n");
	const sessionFile = join(dir, "child.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: dir })}\n`,
	);
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
		extensions,
		...extra,
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
		const result = (await tools
			.get("subagent_resume")!
			.execute("call-1", { sessionFile }, undefined, undefined, parentToolCtx(dir, { hasUI: false }))) as {
			content: Array<{ text: string }>;
		};
		return { reply: result.content.map((block) => block.text).join("\n\n"), started };
	} finally {
		if (originalCommand == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
		else process.env.PI_SUBAGENT_PI_COMMAND = originalCommand;
		if (originalRoot == null) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
		else process.env.PI_ARTIFACT_PROJECT_ROOT = originalRoot;
	}
}

/** An npm command that records each call in `marker` and fails, so any run of it is visible. */
function writeNpmRecorder(dir: string, marker: string): string {
	return writeExecutable(dir, "npm-recorder", `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(marker)}\nexit 1\n`);
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
		const plan = await planFor(
			cwd,
			`npm:pi-fancy-footer,git:github.com/example/footer-extension@v2,${local}`,
			agentDir,
		);
		assert.deepEqual(plan.capability.droppedExtensions, []);
		// A configured npm package and an exact git ref reuse their installation; the local path passes as written.
		assert.deepEqual(plan.capability.extensions, [npmRoot, gitRoot, local]);
		assert.deepEqual(getExtensionLaunchArgs(plan.capability.extensions, "/done.ts", false), [
			"--no-extensions",
			"-e",
			"/done.ts",
			"-e",
			npmRoot,
			"-e",
			gitRoot,
			"-e",
			local,
		]);
	});

	it("starts an empty explicit list with only the mandatory entry, and keeps the default without a list", async () => {
		const cwd = createTestDir();
		const empty = await planFor(cwd, "none");
		assert.deepEqual(empty.capability.extensions, []);
		assert.deepEqual(getExtensionLaunchArgs(empty.capability.extensions, "/done.ts", false), [
			"--no-extensions",
			"-e",
			"/done.ts",
		]);
		const none = await planFor(cwd, undefined);
		assert.equal(none.capability.extensions, undefined);
		assert.deepEqual(none.capability.droppedExtensions, []);
		assert.deepEqual(getExtensionLaunchArgs(none.capability.extensions, "/done.ts", false), ["-e", "/done.ts"]);
	});

	it("resumes a saved session whose list names gone entries and names each dropped entry in the reply", async () => {
		const dir = createTestDir();
		const present = join(dir, "present.ts");
		writeFileSync(present, "export default () => {};\n");
		const gone = join(dir, "deleted-extension.ts");
		const { reply, started } = await resumeSavedSession(dir, [present, gone, GONE_GIT, GONE_NPM]);
		for (const entry of [gone, GONE_GIT, GONE_NPM]) {
			assert.equal(countOf(reply, `dropped missing extension: ${entry}`), 1, reply);
		}
		const args = started[0].childProcess?.spawnargs ?? [];
		assert.ok(args.includes(present), args.join(" "));
		for (const entry of [gone, GONE_GIT, GONE_NPM]) assert.ok(!args.includes(entry), args.join(" "));
	});

	it("keeps the filtered list in the resumed launch metadata, which a time-limit wrap-up restart reuses", async () => {
		const dir = createTestDir();
		const present = join(dir, "present.ts");
		writeFileSync(present, "export default () => {};\n");
		const { started } = await resumeSavedSession(dir, [present, join(dir, "deleted-extension.ts")]);
		assert.deepEqual(started[0].launchMetadata?.extensions, [present]);
	});

	it("discovers named skills of a resume without the dropped entries, so no package install runs", async () => {
		const dir = createTestDir();
		const present = join(dir, "present.ts");
		writeFileSync(present, "export default () => {};\n");
		mkdirSync(join(dir, "skills", "demo"), { recursive: true });
		writeFileSync(join(dir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill.\n---\nDemo.\n");
		const marker = join(dir, "npm-calls.txt");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ npmCommand: [writeNpmRecorder(dir, marker)] }));
		await resumeSavedSession(dir, [present, GONE_NPM], { skills: "demo" });
		const calls = existsSync(marker) ? readFileSync(marker, "utf8") : "";
		assert.ok(!calls.includes("install"), calls);
	});

	it("checks a package entry without running the npm command an unapproved project sets", () => {
		const cwd = createTestDir();
		const marker = join(cwd, "project-npm-ran.txt");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ npmCommand: [writeNpmRecorder(cwd, marker)] }));
		const check = dropMissingExtensionEntries([GONE_NPM], { cwd, agentDir: join(cwd, "agent") });
		assert.deepEqual(check.dropped, [GONE_NPM]);
		assert.equal(existsSync(marker), false, "the project npm command ran");
	});

	it("keeps only the exact pi-subagents entry and drops lookalikes", () => {
		const cwd = createTestDir();
		const goneInsideCheckout = join(cwd, "pi-subagents", ".pi", "extensions", "gone.ts");
		const check = dropMissingExtensionEntries(
			["npm:pi-subagents-extra", goneInsideCheckout, "npm:pi-subagents@1.0.0", getSubagentsExtensionPath()],
			{ cwd, agentDir: join(cwd, "agent") },
		);
		assert.deepEqual(check.kept, ["npm:pi-subagents@1.0.0", getSubagentsExtensionPath()]);
		assert.deepEqual(check.dropped, ["npm:pi-subagents-extra", goneInsideCheckout]);
	});

	it("still force-loads pi-subagents for a spawning child whose list only has a lookalike", () => {
		const cwd = createTestDir();
		const lookalike = join(cwd, "pi-subagents", ".pi", "extensions", "present.ts");
		mkdirSync(dirname(lookalike), { recursive: true });
		writeFileSync(lookalike, "export default () => {};\n");
		assert.deepEqual(getExtensionLaunchArgs([lookalike], "/done.ts", true), [
			"--no-extensions",
			"-e",
			"/done.ts",
			"-e",
			lookalike,
			"-e",
			getSubagentsExtensionPath(),
		]);
		assert.deepEqual(getExtensionLaunchArgs([getSubagentsExtensionPath()], "/done.ts", true), [
			"--no-extensions",
			"-e",
			"/done.ts",
			"-e",
			getSubagentsExtensionPath(),
		]);
	});

	it("names all 12 dropped entries of a waiting launch once and keeps its rendering within 1,900 characters", async () => {
		const cwd = createTestDir();
		const gone = Array.from({ length: 12 }, (_, index) =>
			join(cwd, "removed-extensions", `gone-extension-${index + 1}.ts`),
		);
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
					phase: "running",
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
				const done = watchBackgroundSubagent(
					running,
					{ cleanupNoSessionSessionFile() {}, terminateBackgroundChildProcess() {} },
					signal,
				);
				setImmediate(() => child.emit("exit", 0));
				return done;
			},
			watchSubagent: async () => new Promise(() => {}),
			getWatcherSignal: (_running, controller) => controller.signal,
			wireSubagentSteerBack: () => {},
			startWidgetRefresh: () => {},
			getLaunchedSubagentResult: (running, signal) => getLaunchedSubagentResultForTest(running, signal),
			muxUnavailableResult: () => ({ content: [{ type: "text", text: "mux" }], details: {} }),
			listLaunchableAgents: () => [],
		};
		registerSubagentCoreTools(
			{
				registerTool: (definition: any) => tools.set(definition.name, definition),
				getThinkingLevel: () => "low",
			} as any,
			() => true,
			runtime,
		);
		const result = await tools
			.get("subagent")
			.execute(
				"call-1",
				{ children: [{ agent: "scout", name: "ext-scout", title: "Recon", task: "Recon", blocking: true }] },
				undefined,
				undefined,
				{
					hasUI: false,
					cwd,
					sessionManager: { getSessionFile: () => join(cwd, "parent.jsonl"), getSessionId: () => "parent" },
				},
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
