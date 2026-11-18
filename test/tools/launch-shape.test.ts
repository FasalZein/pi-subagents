import { readdirSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentDefaults } from "../../src/agents/definitions.ts";
import {
	markInitialPromptLaunchComplete,
	registerSubagentCoreTools,
	type SubagentToolRuntime,
} from "../../src/tools/subagent-tools.ts";
import type { RunningSubagent, SubagentParamsInput } from "../../src/types.ts";
import {
	afterEach,
	assert,
	beforeEach,
	createTestDir,
	describe,
	getLaunchedSubagentResultForTest,
	it,
	join,
	mkdirSync,
	resetSubagentStateForTest,
	setRunningSubagentForTest,
	subagentsExtension,
	writeFileSync,
} from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";
import { loadExtension, useFakePi } from "../support/extension-host.ts";

// D21 and D23: the launch tool takes only a children list; its reply has one
// line per child, one line on how results return, and an unknown agent is
// refused with the closest names the caller may launch.

type LaunchTool = {
	execute(id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown): Promise<any>;
};

const SRC = join(import.meta.dirname, "../../src");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? sourceFiles(join(dir, entry.name))
			: entry.name.endsWith(".ts")
				? [join(dir, entry.name)]
				: [],
	);
}

function child(agent: string, name: string): SubagentParamsInput {
	return { agent, name, title: "Launch shape check", task: "Check the launch shape" };
}

/** A launch tool over a fake runtime: each agent name maps to its pane or headless mode. */
function fakeLaunchTool(modes: Record<string, "interactive" | "background">) {
	const launched: string[] = [];
	const start = (mode: "interactive" | "background") => async (params: SubagentParamsInput) => {
		launched.push(params.name);
		const running: RunningSubagent = {
			id: `run-${params.name}`,
			name: params.name,
			task: params.task,
			title: params.title,
			agent: params.agent,
			mode,
			executionState: "running",
			deliveryState: "detached",
			parentClosePolicy: "terminate",
			blocking: params.blocking,
			async: params.async,
			startTime: Date.now(),
			sessionFile: `/tmp/${params.name}.jsonl`,
			// A placeholder in the provider/model shape; the runtime reports whatever ref runs.
			modelRef: `stub/${params.name}`,
		};
		setRunningSubagentForTest(running);
		return running;
	};
	const runtime: SubagentToolRuntime = {
		loadAgentDefaults: (agent) => (agent && modes[agent] ? ({ mode: modes[agent] } as AgentDefaults) : null),
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		launchBackgroundSubagent: start("background"),
		launchSubagent: start("interactive"),
		watchBackgroundSubagent: () => new Promise(() => {}),
		watchSubagent: () => new Promise(() => {}),
		getWatcherSignal: (_running, controller) => controller.signal,
		wireSubagentSteerBack: () => {},
		startWidgetRefresh: () => {},
		getLaunchedSubagentResult: (running, signal) => getLaunchedSubagentResultForTest(running, signal),
		stopRunningSubagent: async () => {},
		muxUnavailableResult: () => ({ content: [{ type: "text", text: "mux" }], details: {} }),
		listLaunchableAgents: () => [],
	};
	const tools = new Map<string, LaunchTool>();
	registerSubagentCoreTools(
		{ registerTool: (definition: any) => tools.set(definition.name, definition), getThinkingLevel: () => "low" } as any,
		() => true,
		runtime,
	);
	const tool = tools.get("subagent");
	assert.ok(tool);
	const ctx = {
		hasUI: true,
		cwd: process.cwd(),
		sessionManager: { getSessionFile: () => "/tmp/parent.jsonl", getSessionId: () => "parent" },
	};
	return {
		launched,
		launch: async (children: SubagentParamsInput[]) =>
			(await tool.execute("call-1", { children }, undefined, undefined, ctx)).content[0].text as string,
	};
}

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_SUBAGENT_AGENT",
	"PI_SUBAGENT_SPAWNABLE",
	"PI_SUBAGENT_SPAWN_BUDGET",
	"PI_SUBAGENT_PI_COMMAND",
] as const;

/** The real extension over a config root holding the named agent files; returns a launch caller. */
function realLaunchTool(agents: Record<string, string>) {
	const cwd = createTestDir();
	const configDir = join(cwd, "agent-root");
	mkdirSync(join(configDir, "agents"), { recursive: true });
	for (const [name, extra] of Object.entries(agents)) {
		writeFileSync(
			join(configDir, "agents", `${name}.md`),
			`---\nname: ${name}\ndescription: Does ${name} work\n${extra}---\n\nBody.`,
		);
	}
	process.env.PI_CODING_AGENT_DIR = configDir;
	const tools = new Map<string, LaunchTool & { name: string }>();
	const api = {
		getAllTools: () => [...tools.keys()].map((name) => ({ name })),
		getActiveTools: () => [...tools.keys()],
		getThinkingLevel: () => "off",
		on() {},
		registerTool: (tool: LaunchTool & { name: string }) => tools.set(tool.name, tool),
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		sendMessage() {},
	} as unknown as ExtensionAPI;
	const previous = process.cwd();
	process.chdir(cwd);
	try {
		subagentsExtension(api);
	} finally {
		process.chdir(previous);
	}
	const tool = tools.get("subagent");
	assert.ok(tool);
	const ctx = { cwd, hasUI: true, sessionManager: { getSessionFile: () => null, getSessionId: () => "parent" } };
	return (agent: string) =>
		tool.execute("call-1", { children: [child(agent, "typo-check")] }, undefined, undefined, ctx);
}

describe("launch shape, launch reply and closest names (T18)", () => {
	const saved = new Map<string, string | undefined>();
	beforeEach(() => {
		for (const key of ENV_KEYS) saved.set(key, process.env[key]);
		delete process.env.PI_SUBAGENT_AGENT;
		markInitialPromptLaunchComplete();
	});
	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = saved.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetSubagentStateForTest();
	});

	it("states the rule about leaving the model unset once across all model-facing source strings", () => {
		const rule = /leave (?:it |model\S* )?unset|omit unless|unset unless/gi;
		const hits = sourceFiles(SRC).flatMap((file) =>
			[...readFileSync(file, "utf8").matchAll(rule)].map((match) => `${file}: ${match[0]}`),
		);
		assert.equal(hits.length, 1, hits.join("\n"));
	});

	it("launches one child and three children through the children list", async () => {
		const one = fakeLaunchTool({ scout: "background" });
		await one.launch([child("scout", "solo-scout")]);
		assert.deepEqual(one.launched, ["solo-scout"]);
		resetSubagentStateForTest();
		const three = fakeLaunchTool({ scout: "background" });
		await three.launch([child("scout", "scout-one"), child("scout", "scout-two"), child("scout", "scout-three")]);
		assert.deepEqual(three.launched, ["scout-one", "scout-two", "scout-three"]);
	});

	it("replies for two children with two child lines, one batch line and each resolved model ref", async () => {
		const tool = fakeLaunchTool({ viewer: "interactive", scout: "background" });
		const text = await tool.launch([child("viewer", "pane-viewer"), child("scout", "bg-scout")]);
		const lines = text.split("\n");
		assert.equal(lines.length, 3, text);
		assert.match(lines[0], /pane-viewer/);
		assert.match(lines[0], /viewer/);
		assert.match(lines[0], /run-pane-viewer/);
		assert.match(lines[0], /stub\/pane-viewer/);
		assert.match(lines[0], /\bpane\b/);
		assert.match(lines[1], /bg-scout/);
		assert.match(lines[1], /run-bg-scout/);
		assert.match(lines[1], /stub\/bg-scout/);
		assert.match(lines[1], /\bheadless\b/);
		assert.match(lines[2], /report arrives later/);
	});

	it("makes an async child in one call wait for a blocking child in a separate call of the same message", async () => {
		const cwd = createTestDir();
		const agentsDir = join(cwd, "agent-root", "agents");
		mkdirSync(agentsDir, { recursive: true });
		for (const [name, async] of [["blocker", false], ["slow", true]] as const) {
			writeFileSync(
				join(agentsDir, `${name}.md`),
				`---\nname: ${name}\ndescription: ${name} agent\nmode: background\nauto-exit: true\nasync: ${async}\n---\n\nBody.`,
			);
		}
		process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-root");
		// Each child runs a little while, so a detached child would still be running when its call returns.
		useFakePi("sleep 0.3");
		const extension = await loadExtension(cwd);
		await extension.startSession("startup");
		const calls = [child("blocker", "blocker-one"), child("slow", "slow-one")].map((entry, index) => ({
			type: "toolCall",
			id: `call-${index}`,
			name: "subagent",
			arguments: { children: [entry] },
		}));
		// Pi runs message_end and every tool_call hook of the message before any parallel call executes.
		await extension.emit("message_end", { message: { role: "assistant", content: calls } });
		for (const call of calls) {
			await extension.emit("tool_call", { toolName: call.name, toolCallId: call.id, input: call.arguments });
		}
		const tool = extension.tools.get("subagent");
		assert.ok(tool);
		const results = await Promise.all(
			calls.map((call) => tool.execute(call.id, call.arguments, undefined, undefined, extension.ctx)),
		);
		assert.deepEqual(
			results.map((result) => result.details.status),
			["completed", "completed"],
		);
	});

	it("refuses a misspelled agent name and names the intended agent", async () => {
		const launch = realLaunchTool({ reviewer: "", scout: "", worker: "" });
		await assert.rejects(launch("reviwer"), (error: Error) => {
			assert.match(error.message, /no agent named "reviwer"/);
			assert.match(error.message, /Closest: reviewer\b/);
			return true;
		});
	});

	it("never suggests an agent a restricted caller may not launch", async () => {
		const launch = realLaunchTool({ coordinator: "spawning: helper\n", helper: "", secret: "", secrets: "" });
		process.env.PI_SUBAGENT_AGENT = "coordinator";
		process.env.PI_SUBAGENT_SPAWNABLE = "helper";
		process.env.PI_SUBAGENT_SPAWN_BUDGET = "1";
		await assert.rejects(launch("secrat"), (error: Error) => {
			assert.match(error.message, /Closest: helper\.$/);
			assert.doesNotMatch(error.message, /secret\b|secrets\b|coordinator/);
			return true;
		});
	});
});
