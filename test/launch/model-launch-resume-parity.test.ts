import { once } from "node:events";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildPersistedSubagentLaunchMetadata, prepareSubagentLaunch } from "../../src/launch/prep.ts";
import { writeSubagentLaunchMetadataEntry } from "../../src/session/session-files.ts";
import { registerSubagentResumeTool } from "../../src/tools/resume-tool.ts";
import { registerSubagentCoreTools, type SubagentToolRuntime } from "../../src/tools/subagent-tools.ts";
import type { RunningSubagent, SubagentParamsInput } from "../../src/types.ts";
import {
	assert,
	createTestDir,
	mkdirSync,
	readFileSync,
	resetSubagentStateForTest,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";

/**
 * D22 parity: the subagent tool and the subagent_resume tool resolve the same
 * call model to the same child ref for the same agent. Synthetic refs only.
 */
const KNOWN = [
	"synthetic-a/base",
	"synthetic-a/mini-v2",
	"synthetic-a/target",
	"synthetic-b/mini",
	"synthetic-b/mini-v3",
	"synthetic-c/advanced:rev1",
];
const modelRegistry = {
	getAvailable: () =>
		KNOWN.map((ref) => {
			const slash = ref.indexOf("/");
			return { provider: ref.slice(0, slash), id: ref.slice(slash + 1), reasoning: true };
		}),
};
const PARENT = { provider: "synthetic-a", id: "base" };

type Outcome = { modelRef?: string; refusal?: string };

function refusalOf(text: string): Outcome {
	const match = text.match(/(Model '|Unknown model override ')[^]*?subagent_agents/);
	if (!match) throw new Error(`Expected a D22 refusal, got: ${text}`);
	return { refusal: match[0] };
}

function emptyResult(name: string) {
	return { name, task: "", summary: "", exitCode: 0, elapsed: 0 };
}

/** Launch through the subagent tool; the fake runtime runs the real launch preparation and persists its metadata. */
async function launchThroughTool(dir: string, model: string | undefined): Promise<Outcome & { sessionFile?: string }> {
	const tools = new Map<string, any>();
	let launched: { modelRef?: string; sessionFile: string } | undefined;
	const launch = async (params: SubagentParamsInput, ctx: Parameters<SubagentToolRuntime["launchBackgroundSubagent"]>[1]) => {
		const prepared = await prepareSubagentLaunch(params, ctx);
		const sessionFile = join(dir, `child-${Date.now()}-${Math.random()}.jsonl`);
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: dir })}\n`);
		writeSubagentLaunchMetadataEntry(sessionFile, {
			...buildPersistedSubagentLaunchMetadata(prepared, params, "background", "lineage-only", false),
			cwd: dir,
			agentConfigDir: dir,
		});
		launched = { modelRef: prepared.effectiveModelRef, sessionFile };
		return {
			id: "picker-1",
			name: params.name,
			task: params.task,
			agent: params.agent,
			mode: "background",
			phase: "running",
			deliveryState: "detached",
			parentClosePolicy: "terminate",
			startTime: Date.now(),
			sessionFile,
		} as RunningSubagent;
	};
	const runtime: SubagentToolRuntime = {
		loadAgentDefaults: () => ({ mode: "background" }),
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		launchBackgroundSubagent: launch,
		launchSubagent: launch,
		watchBackgroundSubagent: async () => emptyResult("picker-1"),
		watchSubagent: async () => emptyResult("picker-1"),
		getWatcherSignal: (_running, controller) => controller.signal,
		wireSubagentSteerBack: () => {},
		startWidgetRefresh: () => {},
		getLaunchedSubagentResult: async () => ({ content: [{ type: "text", text: "completed" }], details: {} }),
		muxUnavailableResult: () => ({ content: [{ type: "text", text: "mux" }], details: {} }),
		listLaunchableAgents: () => [],
	};
	registerSubagentCoreTools(
		{ registerTool: (definition: any) => tools.set(definition.name, definition), getThinkingLevel: () => "low" } as any,
		() => true,
		runtime,
	);
	try {
		const result = await tools.get("subagent").execute(
			"call-1",
			{ children: [{ agent: "picker", name: "picker-1", title: "Pick", task: "t", ...(model ? { model } : {}) }] },
			undefined,
			undefined,
			{
				hasUI: false,
				cwd: dir,
				model: PARENT,
				modelRegistry,
				sessionManager: { getSessionFile: () => join(dir, "parent.jsonl"), getSessionId: () => "parent" },
			},
		);
		if (!launched) return refusalOf(result.content[0].text);
		return launched;
	} catch (error) {
		return refusalOf((error as Error).message);
	}
}

/** Resume through the subagent_resume tool; a fake pi records the child arguments. */
async function resumeThroughTool(dir: string, sessionFile: string, model: string): Promise<Outcome> {
	const argsFile = join(dir, `args-${Date.now()}-${Math.random()}.txt`);
	const bin = writeExecutable(dir, "record-pi", `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$ARGS_FILE"\n`);
	const tools = new Map<string, any>();
	const runningSubagents = new Map<string, RunningSubagent>();
	registerSubagentResumeTool(
		{ registerTool: (definition: any) => tools.set(definition.name, definition) } as any,
		() => true,
		{
			isMuxAvailable: () => true,
			getShellReadyDelayMs: () => 0,
			watchBackgroundSubagent: async () => emptyResult("picker-1"),
			watchSubagent: async () => emptyResult("picker-1"),
			getWatcherSignal: (_running: unknown, controller: AbortController) => controller.signal,
			startWidgetRefresh: () => {},
			getContextWindow: () => undefined,
			runningSubagents,
			wireSubagentSteerBack: () => {},
			getLaunchedSubagentResult: async () => ({ content: [{ type: "text", text: "completed" }], details: {} }),
			modelRegistry,
		} as any,
		{ mayLaunch: () => true },
	);
	const original = { command: process.env.PI_SUBAGENT_PI_COMMAND, args: process.env.ARGS_FILE };
	process.env.PI_SUBAGENT_PI_COMMAND = bin;
	process.env.ARGS_FILE = argsFile;
	try {
		// Since T06 a resume reserves its run folder under the parent session's results folder.
		const result = await tools.get("subagent_resume").execute("call-2", { sessionFile, model }, undefined, undefined, {
			hasUI: false,
			cwd: dir,
			sessionManager: { getSessionId: () => "parent-session" },
		});
		const child = [...runningSubagents.values()][0]?.childProcess;
		if (!child) return refusalOf(result.content[0].text);
		// The shell creates the file before printf writes it: read only after the fake pi exits.
		if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
		const args = readFileSync(argsFile, "utf8").split("\n");
		return { modelRef: args[args.indexOf("--model") + 1] };
	} catch (error) {
		return refusalOf((error as Error).message);
	} finally {
		for (const [key, value] of [["PI_SUBAGENT_PI_COMMAND", original.command], ["ARGS_FILE", original.args]] as const) {
			if (value == null) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function writeAgent(frontmatter: string): string {
	const dir = createTestDir();
	mkdirSync(join(dir, "agents"), { recursive: true });
	writeFileSync(join(dir, "agents", "picker.md"), `---\nname: picker\n${frontmatter}\n---\n\nPicker.`);
	return dir;
}

const CASES: Array<{ title: string; frontmatter: string; first?: string; model: string; expected: Outcome["modelRef"] | "refused" }> = [
	{
		title: "an unqualified id takes the agent default provider, not an exact id under another provider",
		frontmatter: "model: synthetic-a/base\nallowed-models: synthetic-a/mini-v2, synthetic-b/mini",
		model: "mini",
		expected: "synthetic-a/mini-v2:low",
	},
	{
		title: "an agent default written without a provider is the provider source",
		frontmatter: "model: base",
		model: "mini-v",
		expected: "synthetic-a/mini-v2:low",
	},
	{
		title: "without an agent default a fragment under several providers is refused",
		frontmatter: "description: no default",
		model: "mini-v",
		expected: "refused",
	},
	{
		title: "a model without a level takes the configured default level, not the previous run's",
		frontmatter: "thinking: high\nallowed-models: synthetic-a/target:low, synthetic-a/target:high",
		first: "synthetic-a/target:low",
		model: "synthetic-a/target",
		expected: "synthetic-a/target:high",
	},
	{
		title: "the agent default is accepted at its effective level only",
		frontmatter: "model: synthetic-a/base\nallowed-models: synthetic-b/mini",
		model: "synthetic-a/base:high",
		expected: "refused",
	},
	{
		title: "a registry id with a colon stays whole",
		frontmatter: "model: synthetic-a/base",
		model: "advanced",
		expected: "synthetic-c/advanced:rev1:low",
	},
];

describe("launch and resume model parity (D22)", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	afterEach(() => {
		resetSubagentStateForTest();
		if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	});

	for (const testCase of CASES) {
		it(testCase.title, async () => {
			const dir = writeAgent(testCase.frontmatter);
			process.env.PI_CODING_AGENT_DIR = dir;
			const launched = await launchThroughTool(dir, testCase.model);
			const first = await launchThroughTool(dir, testCase.first);
			assert.ok(first.sessionFile, `the first launch must start: ${first.refusal}`);
			const resumed = await resumeThroughTool(dir, first.sessionFile, testCase.model);
			if (testCase.expected === "refused") {
				assert.ok(launched.refusal, `launch must refuse, got ${launched.modelRef}`);
			} else {
				assert.equal(launched.modelRef, testCase.expected, launched.refusal);
			}
			assert.deepEqual(
				{ modelRef: resumed.modelRef, refusal: resumed.refusal },
				{ modelRef: launched.modelRef, refusal: launched.refusal },
			);
		});
	}
});
