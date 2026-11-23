import { readdirSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentDefaults } from "../../src/agents/definitions.ts";
import { stripInternalLaunchOverrides } from "../../src/launch/launch-overrides.ts";
import { getLaunchCallChildren } from "../../src/runtime/batch-classifier.ts";
import {
	markInitialPromptLaunchComplete,
	registerSubagentCoreTools,
	type SubagentToolRuntime,
} from "../../src/tools/subagent-tools.ts";
import type { RunningSubagent, SubagentParamsInput, SubagentResult } from "../../src/types.ts";
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
import { upstreamUnknownAgentError } from "../support/upstream-wording.ts";

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

/**
 * A launch tool over a fake runtime: each agent name maps to its frontmatter defaults.
 * Each child finishes at once with the report "Report of <name>."; hasUI false is a one-shot parent.
 */
function fakeLaunchTool(agents: Record<string, Partial<AgentDefaults>>, { hasUI = true } = {}) {
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
			phase: "running",
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
		loadAgentDefaults: (agent) => (agent && agents[agent] ? (agents[agent] as AgentDefaults) : null),
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		launchBackgroundSubagent: start("background"),
		launchSubagent: start("interactive"),
		watchBackgroundSubagent: async (running) => report(running),
		watchSubagent: async (running) => report(running),
		getWatcherSignal: (_running, controller) => controller.signal,
		wireSubagentSteerBack: () => {},
		startWidgetRefresh: () => {},
		getLaunchedSubagentResult: (running, signal) => getLaunchedSubagentResultForTest(running, signal),
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
		hasUI,
		cwd: process.cwd(),
		sessionManager: { getSessionFile: () => "/tmp/parent.jsonl", getSessionId: () => "parent" },
	};
	const call = (children: SubagentParamsInput[]) => tool.execute("call-1", { children }, undefined, undefined, ctx);
	return {
		launched,
		call,
		callRaw: (params: unknown) => tool.execute("call-1", params, undefined, undefined, ctx),
		launch: async (children: SubagentParamsInput[]) => (await call(children)).content[0].text as string,
	};
}

function report(running: RunningSubagent): SubagentResult {
	return {
		name: running.name,
		task: running.task,
		summary: `Report of ${running.name}.`,
		sessionFile: running.sessionFile,
		exitCode: 0,
		elapsed: 1,
	};
}

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_SUBAGENT_AGENT",
	"PI_SUBAGENT_SPAWNABLE",
	"PI_SUBAGENT_SPAWN_BUDGET",
	"PI_SUBAGENT_PI_COMMAND",
	"PI_SUBAGENT_MUX",
	"TMUX",
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
		const one = fakeLaunchTool({ scout: { mode: "background" } });
		await one.launch([child("scout", "solo-scout")]);
		assert.deepEqual(one.launched, ["solo-scout"]);
		resetSubagentStateForTest();
		const three = fakeLaunchTool({ scout: { mode: "background" } });
		await three.launch([child("scout", "scout-one"), child("scout", "scout-two"), child("scout", "scout-three")]);
		assert.deepEqual(three.launched, ["scout-one", "scout-two", "scout-three"]);
	});

	it("replies for two children with two child lines, one batch line and each resolved model ref", async () => {
		// Pin a fake tmux: with no multiplexer the pane child would fall back to headless.
		process.env.PI_SUBAGENT_MUX = "tmux";
		process.env.TMUX = "fake-tmux-socket";
		const tool = fakeLaunchTool({ viewer: { mode: "interactive" }, scout: { mode: "background" } });
		const text = await tool.launch([child("viewer", "pane-viewer"), child("scout", "bg-scout")]);
		const lines = text.split("\n");
		assert.equal(lines.length, 3, text);
		assert.equal(lines[0], "- pane-viewer (agent viewer): run run-pane-viewer, model stub/pane-viewer, pane");
		assert.equal(lines[1], "- bg-scout (agent scout): run run-bg-scout, model stub/bg-scout, headless");
		assert.match(lines[2], /report arrives later/);
	});

	it("gives a forced wait for two async children the child lines, one batch line and both reports", async () => {
		const tool = fakeLaunchTool({ scout: { mode: "background", async: true } }, { hasUI: false });
		const result = await tool.call([child("scout", "scout-one"), child("scout", "scout-two")]);
		const text = result.content[0].text as string;
		const lines = text.split("\n");
		assert.equal(lines[0], "- scout-one (agent scout): run run-scout-one, model stub/scout-one, headless", text);
		assert.equal(lines[1], "- scout-two (agent scout): run run-scout-two, model stub/scout-two, headless", text);
		assert.match(lines[2], /reports? follows? below/i, text);
		assert.doesNotMatch(text, /arrives later/);
		assert.ok(text.indexOf("Report of scout-one.") > lines[2].length, text);
		assert.ok(text.includes("Report of scout-two."), text);
		// The TUI shows the reports of a batch only when its status says they were delivered.
		assert.equal(result.details.status, "batch");
	});

	it("gives a mixed list with one blocking child the child lines, one batch line and both reports", async () => {
		const tool = fakeLaunchTool({
			scout: { mode: "background", async: true },
			worker: { mode: "background", async: false },
		});
		const result = await tool.call([child("scout", "bg-scout"), child("worker", "fg-worker")]);
		const text = result.content[0].text as string;
		const lines = text.split("\n");
		assert.equal(lines[0], "- bg-scout (agent scout): run run-bg-scout, model stub/bg-scout, headless", text);
		assert.equal(lines[1], "- fg-worker (agent worker): run run-fg-worker, model stub/fg-worker, headless", text);
		assert.match(lines[2], /reports? follows? below/i, text);
		assert.ok(text.includes("Report of bg-scout.") && text.includes("Report of fg-worker."), text);
		assert.equal(result.details.status, "batch");
	});

	it("gives one waiting child its child line and batch line before its report", async () => {
		const tool = fakeLaunchTool({ worker: { mode: "background", async: false } });
		const result = await tool.call([child("worker", "fg-worker")]);
		const text = result.content[0].text as string;
		const lines = text.split("\n");
		assert.equal(lines[0], "- fg-worker (agent worker): run run-fg-worker, model stub/fg-worker, headless", text);
		assert.match(lines[1], /reports? follows? below/i, text);
		assert.ok(text.includes("Report of fg-worker."), text);
		assert.equal(result.details.status, "completed");
	});

	it("makes an async child in one call wait for a blocking child in a separate call of the same message", async () => {
		const cwd = createTestDir();
		const agentsDir = join(cwd, "agent-root", "agents");
		mkdirSync(agentsDir, { recursive: true });
		for (const [name, async] of [
			["blocker", false],
			["slow", true],
		] as const) {
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

	it("makes an async project agent wait beside a direct tool when the session cwd is not the process cwd", async () => {
		// The hooks resolve definitions from the session cwd, as the executor does (B1 review, subagents.ts:298).
		const cwd = createTestDir();
		const projectAgents = join(cwd, ".pi", "agents");
		mkdirSync(projectAgents, { recursive: true });
		writeFileSync(
			join(projectAgents, "project-scout.md"),
			"---\nname: project-scout\ndescription: project agent\nmode: background\nauto-exit: true\nasync: true\n---\n\nBody.",
		);
		mkdirSync(join(cwd, "agent-root", "agents"), { recursive: true });
		process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-root");
		useFakePi("sleep 0.3");
		const extension = await loadExtension(cwd);
		await extension.startSession("startup");
		assert.notEqual(process.cwd(), cwd);
		const launch = {
			type: "toolCall",
			id: "call-launch",
			name: "subagent",
			arguments: { children: [child("project-scout", "project-one")] },
		};
		const read = { type: "toolCall", id: "call-read", name: "read", arguments: { path: "README.md" } };
		await extension.emit("message_end", { message: { role: "assistant", content: [launch, read] } });
		await extension.emit("tool_call", { toolName: launch.name, toolCallId: launch.id, input: launch.arguments });
		const tool = extension.tools.get("subagent");
		assert.ok(tool);
		const result = await tool.execute(launch.id, launch.arguments, undefined, undefined, extension.ctx);
		assert.equal(result.details.status, "completed", result.content[0].text);
	});

	// F-M12-1 (owner rule 2026-11-23T20:09Z, diverges from cf6dbf4): a steer or follow-up typed while the
	// tools of a mixed batch run keeps the batch blocking. Pi emits "input" after the tool_call hooks.
	async function loadBatchAgents(agents: Record<string, boolean>) {
		const cwd = createTestDir();
		const agentsDir = join(cwd, "agent-root", "agents");
		mkdirSync(agentsDir, { recursive: true });
		for (const [name, async] of Object.entries(agents)) {
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
		return extension;
	}

	it("keeps an async child awaited beside a direct tool when the person types during the launch", async () => {
		const extension = await loadBatchAgents({ slow: true });
		const launch = {
			type: "toolCall",
			id: "call-launch",
			name: "subagent",
			arguments: { children: [child("slow", "slow-one")] },
		};
		const read = { type: "toolCall", id: "call-read", name: "read", arguments: { path: "README.md" } };
		await extension.emit("message_end", { message: { role: "assistant", content: [launch, read] } });
		await extension.emit("tool_call", { toolName: launch.name, toolCallId: launch.id, input: launch.arguments });
		await extension.emit("input", { source: "interactive", text: "Also check the tests." });
		const tool = extension.tools.get("subagent");
		assert.ok(tool);
		const result = await tool.execute(launch.id, launch.arguments, undefined, undefined, extension.ctx);
		assert.equal(result.details.status, "completed", result.content[0].text);
		assert.equal(result.terminate, undefined);
	});

	it("keeps sibling async children awaited and every reply without terminate when the person types", async () => {
		const extension = await loadBatchAgents({ blocker: false, slow: true });
		const calls = [[child("blocker", "blocker-one"), child("slow", "slow-one")], [child("slow", "slow-two")]].map(
			(children, index) => ({ type: "toolCall", id: `call-${index}`, name: "subagent", arguments: { children } }),
		);
		await extension.emit("message_end", { message: { role: "assistant", content: calls } });
		for (const call of calls) {
			await extension.emit("tool_call", { toolName: call.name, toolCallId: call.id, input: call.arguments });
		}
		const tool = extension.tools.get("subagent");
		assert.ok(tool);
		// Both calls start; the person types while the children run (B4 of the m12 model: the reply with
		// two children holds their reports, and the single async child must not detach and ask for a stop).
		const pending = calls.map((call) => tool.execute(call.id, call.arguments, undefined, undefined, extension.ctx));
		await extension.emit("input", { source: "interactive", text: "Also check the tests." });
		const results = await Promise.all(pending);
		assert.deepEqual(
			results.map((result) => [result.details.status, result.terminate]),
			[
				["batch", undefined],
				["completed", undefined],
			],
		);
	});

	// D06: the refusal is the v2.9.2 error, read from cf6dbf4 (differential), and suggests no other agent.
	it("refuses an unknown agent name with the cf6dbf4 error: the name and the search locations", async () => {
		const launch = realLaunchTool({ reviewer: "", scout: "", worker: "" });
		const expected = upstreamUnknownAgentError("reviwer", process.env.PI_CODING_AGENT_DIR ?? "");
		await assert.rejects(launch("reviwer"), (error: Error) => {
			assert.equal(error.message, expected);
			assert.doesNotMatch(error.message, /reviewer|scout|worker/);
			return true;
		});
	});

	it("names no agent a restricted caller may not launch", async () => {
		const launch = realLaunchTool({ coordinator: "spawning: helper\n", helper: "", secret: "", secrets: "" });
		process.env.PI_SUBAGENT_AGENT = "coordinator";
		process.env.PI_SUBAGENT_SPAWNABLE = "helper";
		process.env.PI_SUBAGENT_SPAWN_BUDGET = "1";
		const expected = upstreamUnknownAgentError("secrat", process.env.PI_CODING_AGENT_DIR ?? "");
		await assert.rejects(launch("secrat"), (error: Error) => {
			assert.equal(error.message, expected);
			assert.doesNotMatch(error.message, /secrets\b|coordinator|helper/);
			return true;
		});
	});
});

/**
 * D05 oracle: getRequestedChildren verbatim from `git show cf6dbf4:src/tools/subagent-tools.ts`.
 * The one intended difference: the fork's single form drops the empty children key from the child.
 */
function cf6dbf4RequestedChildren(params: Partial<SubagentParamsInput> & { children?: SubagentParamsInput[] }) {
	if (Array.isArray(params.children) && params.children.length > 0) {
		return params.children.map((child) => stripInternalLaunchOverrides(child));
	}
	return [stripInternalLaunchOverrides(params as SubagentParamsInput)];
}

describe("D05: both v2.9.2 launch input forms", () => {
	beforeEach(() => resetSubagentStateForTest());
	afterEach(() => resetSubagentStateForTest());
	const agents = { worker: { spawning: true, async: true } as Partial<AgentDefaults> };

	it("a top-level single-form launch starts its child", async () => {
		const tool = fakeLaunchTool(agents);
		const result = await tool.callRaw(child("worker", "solo-worker"));
		assert.deepEqual(tool.launched, ["solo-worker"]);
		assert.notEqual(result.isError, true);
	});

	it("a single-form launch without task is refused before any child starts", async () => {
		const tool = fakeLaunchTool(agents);
		const { task: _task, ...noTask } = child("worker", "solo-worker");
		await assert.rejects(tool.callRaw(noTask), /task is required/);
		assert.deepEqual(tool.launched, []);
	});

	it("an empty children list with top-level fields starts the top-level child", async () => {
		const tool = fakeLaunchTool(agents);
		await tool.callRaw({ ...child("worker", "solo-worker"), children: [] });
		assert.deepEqual(tool.launched, ["solo-worker"]);
	});

	it("normalizes the launch inputs as cf6dbf4 did (differential)", () => {
		const a = child("worker", "first-worker");
		const b = { ...child("worker", "second-worker"), model: "stub/m", thinking: "high" };
		const inputs: Array<Partial<SubagentParamsInput> & { children?: SubagentParamsInput[] }> = [
			a,
			{ children: [a, b] },
			{ ...a, children: [] },
			{ ...a, children: [b] },
			{ ...a, forcedCwd: "/tmp/x", launchEnv: { A: "1" } } as never,
			{ children: [{ ...b, forcedCwd: "/tmp/y" } as never] },
			{},
		];
		for (const input of inputs) {
			const expected = cf6dbf4RequestedChildren(input).map((entry) => {
				const { children: _children, ...rest } = entry as SubagentParamsInput & { children?: unknown };
				return rest;
			});
			const actual = getLaunchCallChildren(input).map((entry) =>
				stripInternalLaunchOverrides(entry as SubagentParamsInput),
			);
			assert.deepEqual(actual, expected, JSON.stringify(input));
		}
	});

	it("a children list sent as a JSON string normalizes like the native list", () => {
		const list = [child("worker", "first-worker")];
		assert.deepEqual(getLaunchCallChildren({ children: JSON.stringify(list) }), list);
	});
});
