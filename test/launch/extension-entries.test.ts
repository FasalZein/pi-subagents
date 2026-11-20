import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChildLaunchPlan } from "../../src/launch/child-launch-plan.ts";
import { getExtensionLaunchArgs, getSubagentsExtensionPath } from "../../src/launch/prep.ts";
import {
	type PersistedSubagentLaunchMetadata,
	writeSubagentLaunchMetadataEntry,
} from "../../src/session/session-files.ts";
import { registerSubagentResumeTool } from "../../src/tools/resume-tool.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	mkdirSync,
	resetSubagentStateForTest,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";
import { parentToolCtx } from "../support/result-fixtures.ts";

const GONE_GIT = "git:github.com/nobody/gone-extension";
const GONE_NPM = "npm:gone-extension-package";

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

/** The extension arguments cf6dbf4 (v2.9.2) gives a list: no pruning, every entry in order after the mandatory one. */
function cf6dbf4ExtensionArgs(entries: string[], mandatory: string): string[] {
	return ["--no-extensions", "-e", mandatory, ...entries.flatMap((entry) => ["-e", entry])];
}

describe("configured extension entries pass through (D10 as amended by D18)", () => {
	afterEach(() => resetSubagentStateForTest());

	it("launches with a deleted local path, an uninstalled git entry and an uninstalled npm entry, as cf6dbf4 does", async () => {
		const cwd = createTestDir();
		const present = join(cwd, "present.ts");
		writeFileSync(present, "export default () => {};\n");
		const gone = join(cwd, "deleted.ts");
		const list = [present, gone, GONE_GIT, GONE_NPM];
		const plan = await planFor(cwd, list.join(","));
		assert.deepEqual(plan.capability.extensions, list);
		assert.deepEqual(
			getExtensionLaunchArgs(plan.capability.extensions, "/done.ts", false),
			cf6dbf4ExtensionArgs(list, "/done.ts"),
		);
	});

	it("reuses the installation of a configured npm package and an exact git ref; a local path passes as written", async () => {
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
		assert.deepEqual(plan.capability.extensions, [npmRoot, gitRoot, local]);
		assert.deepEqual(
			getExtensionLaunchArgs(plan.capability.extensions, "/done.ts", false),
			cf6dbf4ExtensionArgs([npmRoot, gitRoot, local], "/done.ts"),
		);
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
		assert.deepEqual(getExtensionLaunchArgs(none.capability.extensions, "/done.ts", false), ["-e", "/done.ts"]);
	});

	it("resumes a saved list with gone entries with the extension arguments cf6dbf4 gives it", async () => {
		const dir = createTestDir();
		const present = join(dir, "present.ts");
		writeFileSync(present, "export default () => {};\n");
		const gone = join(dir, "deleted-extension.ts");
		const list = [present, gone, GONE_GIT, GONE_NPM];
		const { reply, started } = await resumeSavedSession(dir, list);
		assert.ok(!reply.includes("dropped missing extension"), reply);
		const args = started[0].childProcess?.spawnargs ?? [];
		// cf6dbf4 resume-service.ts:336-340: --no-extensions, the subagent-done helper, then the saved list.
		const helper = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/tools/subagent-done.ts");
		const extensionArgs = args.flatMap((arg, index) =>
			arg === "--no-extensions" ? [arg] : arg === "-e" ? [arg, args[index + 1]] : [],
		);
		assert.deepEqual(extensionArgs, cf6dbf4ExtensionArgs(list, helper));
	});

	it("keeps the saved list in the resumed launch metadata, which a time-limit wrap-up restart reuses", async () => {
		const dir = createTestDir();
		const present = join(dir, "present.ts");
		writeFileSync(present, "export default () => {};\n");
		const list = [present, join(dir, "deleted-extension.ts")];
		const { started } = await resumeSavedSession(dir, list);
		assert.deepEqual(started[0].launchMetadata?.extensions, list);
	});
});

describe("pi-subagents package identity (D18 keeps the exact check)", () => {
	it("still force-loads pi-subagents for a spawning child whose list only has a lookalike path", () => {
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

	it("does not let a non-main package whose name contains pi-subagents suppress the spawning extension", () => {
		for (const lookalike of ["npm:pi-subagents-extra", "npm:@someone/pi-subagents"]) {
			assert.deepEqual(getExtensionLaunchArgs([lookalike], "/done.ts", true), [
				"--no-extensions",
				"-e",
				"/done.ts",
				"-e",
				lookalike,
				"-e",
				getSubagentsExtensionPath(),
			]);
		}
		assert.deepEqual(getExtensionLaunchArgs(["npm:pi-subagents@1.0.0"], "/done.ts", true), [
			"--no-extensions",
			"-e",
			"/done.ts",
			"-e",
			"npm:pi-subagents@1.0.0",
		]);
	});
});
