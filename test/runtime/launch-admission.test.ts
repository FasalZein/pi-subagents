import type { AgentDefaults } from "../../src/agents/definitions.ts";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
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
	it,
	join,
	mkdirSync,
	resetSubagentStateForTest,
	writeFileSync,
} from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";
import { loadExtension, useFakePi } from "../support/extension-host.ts";

// D17 (parity decisions, 2026-11-20): admission limits concurrent spawn width only, as upstream does.
// Expected values come from cf6dbf4 (`git show cf6dbf4:src/tools/subagent-tools.ts` and
// `git show cf6dbf4:src/runtime/resume-service.ts`): neither takes a cumulative count, so a run
// after any number of finished runs starts, and a resume of a missing file fails with
// "Session file not found".

const ENV_KEYS = [
	"PI_SUBAGENT_LAUNCH_CAP",
	"PI_SUBAGENT_AGENT",
	"PI_SUBAGENT_PI_COMMAND",
	"PI_CODING_AGENT_DIR",
	"PI_SUBAGENT_VF_RUN_DIR",
];

function makeRunning(params: SubagentParamsInput): RunningSubagent {
	return {
		id: `run-${params.name}`,
		name: params.name,
		task: params.task,
		title: params.title,
		agent: params.agent,
		mode: "background",
		phase: { kind: "running" },
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile: `/tmp/${params.name}.jsonl`,
	};
}

function report(running: RunningSubagent): SubagentResult {
	return {
		name: running.name,
		task: running.task,
		summary: "Done",
		summarySource: "subagent",
		exitCode: 0,
		elapsed: 0,
	};
}

/** The launch tool over a fake runtime; each child finishes at once, so spawn width never binds. */
function fakeLaunchTool(defaults: Partial<AgentDefaults> = { spawning: true }) {
	const launch = async (params: SubagentParamsInput) => makeRunning(params);
	let tool: any;
	const runtime: SubagentToolRuntime = {
		loadAgentDefaults: () => defaults as AgentDefaults,
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		launchBackgroundSubagent: launch,
		launchSubagent: launch,
		watchBackgroundSubagent: async (running) => report(running),
		watchSubagent: async (running) => report(running),
		getWatcherSignal: (_running, controller) => controller.signal,
		wireSubagentSteerBack: () => {},
		startWidgetRefresh: () => {},
		getLaunchedSubagentResult: async () => ({
			content: [{ type: "text", text: "started" }],
			details: { status: "started" },
		}),
		muxUnavailableResult: () => ({ content: [{ type: "text", text: "mux" }], details: {} }),
		listLaunchableAgents: () => [],
	};
	registerSubagentCoreTools(
		{
			registerTool(definition: any) {
				if (definition.name === "subagent") tool = definition;
				return definition;
			},
			getThinkingLevel: () => "low",
		} as any,
		() => true,
		runtime,
	);
	const ctx = {
		hasUI: false,
		cwd: process.cwd(),
		sessionManager: { getSessionFile: () => "/tmp/parent.jsonl", getSessionId: () => "parent" },
	};
	let calls = 0;
	return () => {
		calls++;
		const children = [
			{ agent: "worker", name: `child-${calls}`, title: "Launch admission check", task: "Check launch admission" },
		];
		return tool.execute(`call-${calls}`, { children }, undefined, undefined, ctx);
	};
}

const text = (result: any): string => (typeof result === "string" ? result : result.content[0].text);
/** An admitted launch started its child: a refusal has no started or completed status. */
const assertStarted = (result: any, label = "launch"): void =>
	assert.ok(["started", "completed"].includes(result.details?.status), `${label}: ${text(result)}`);

describe("launch admission without a cumulative cap (D17)", () => {
	const saved = new Map<string, string | undefined>();
	beforeEach(() => {
		for (const key of ENV_KEYS) saved.set(key, process.env[key]);
		for (const key of ENV_KEYS) delete process.env[key];
		markInitialPromptLaunchComplete();
		resetSubagentStateForTest();
	});
	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = saved.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetSubagentStateForTest();
	});

	it("starts a 65th sequential launch", async () => {
		const launch = fakeLaunchTool();
		for (let index = 0; index < 65; index++) assertStarted(await launch(), `launch ${index + 1}`);
	});

	it("ignores PI_SUBAGENT_LAUNCH_CAP", async () => {
		process.env.PI_SUBAGENT_LAUNCH_CAP = "1";
		const launch = fakeLaunchTool();
		assertStarted(await launch(), "first launch");
		assertStarted(await launch(), "second launch");
	});

	it("admits a verified fan-out of 3 candidates after 64 finished runs", async () => {
		const sequential = fakeLaunchTool();
		for (let index = 0; index < 64; index++) assertStarted(await sequential(), `launch ${index + 1}`);
		const verified = fakeLaunchTool({ spawning: true, llmAsVerifier: true, llmAsVerifierCandidates: 3 });
		// Admitted: the fan-out reaches its own launch, which this fixture leaves without a verifier model.
		await assert.rejects(verified(), /verifier model is not configured/);
	});

	it("lets a resume after 65 launches reach its own checks", async () => {
		const launch = fakeLaunchTool();
		for (let index = 0; index < 65; index++) assertStarted(await launch(), `launch ${index + 1}`);
		const input = {
			resultsDir: createTestDir(),
			parent: { parentCwd: process.cwd(), warnings: [] },
			sessionFile: join(createTestDir(), "missing.jsonl"),
		};
		await assert.rejects(
			resumeSubagentSession(input, { runningSubagents: new Map() } as any),
			/Session file not found/,
		);
	});

	it("starts launches across a real reload and a new session", async () => {
		const cwd = createTestDir();
		const agentsDir = join(cwd, "agent-root", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "worker.md"),
			"---\nname: worker\ndescription: worker agent\nmode: background\nasync: false\nauto-exit: true\n---\n\nBody.",
		);
		process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-root");
		process.env.PI_SUBAGENT_LAUNCH_CAP = "1";
		useFakePi();
		const launchIn = async (extension: Awaited<ReturnType<typeof loadExtension>>, name: string) => {
			const tool = extension.tools.get("subagent");
			assert.ok(tool);
			const children = [{ agent: "worker", name, title: "Launch admission reload", task: "Check admission" }];
			return tool.execute(`call-${name}`, { children }, undefined, undefined, extension.ctx);
		};
		const first = await loadExtension(cwd, "parent");
		await first.startSession("startup");
		assertStarted(await launchIn(first, "before-reload"), "before reload");
		const reloaded = await loadExtension(cwd, "parent");
		await reloaded.startSession("reload");
		assertStarted(await launchIn(reloaded, "after-reload"), "after reload");
		await reloaded.startSession("new");
		assertStarted(await launchIn(reloaded, "after-new"), "after new");
	});
});
