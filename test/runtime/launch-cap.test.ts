import type { AgentDefaults } from "../../src/agents/definitions.ts";
import {
	getLaunchCountUsed,
	LAUNCH_CAP_ENV,
	tryAcquireLaunchCapSlots,
} from "../../src/runtime/launch-cap.ts";
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

// D9: a parent starts at most 64 runs between two session starts; PI_SUBAGENT_LAUNCH_CAP changes
// the number. Expected values come from D9 and the T33 ticket text.

const ENV_KEYS = [LAUNCH_CAP_ENV, "PI_SUBAGENT_AGENT", "PI_SUBAGENT_PI_COMMAND", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_VF_RUN_DIR"];

function makeRunning(params: SubagentParamsInput): RunningSubagent {
	return {
		id: `run-${params.name}`,
		name: params.name,
		task: params.task,
		title: params.title,
		agent: params.agent,
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile: `/tmp/${params.name}.jsonl`,
	};
}

function report(running: RunningSubagent): SubagentResult {
	return { name: running.name, task: running.task, summary: "Done", summarySource: "subagent", exitCode: 0, elapsed: 0 };
}

/** The launch tool over a fake runtime; each child finishes at once, so spawn width never binds. */
function fakeLaunchTool(
	launch: (params: SubagentParamsInput) => Promise<RunningSubagent> = async (params) => makeRunning(params),
	defaults: Partial<AgentDefaults> = { spawning: true },
) {
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
		getLaunchedSubagentResult: async () => ({ content: [{ type: "text", text: "started" }], details: { status: "started" } }),
		stopRunningSubagent: async () => {},
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
	const ctx = { hasUI: false, cwd: process.cwd(), sessionManager: { getSessionFile: () => "/tmp/parent.jsonl", getSessionId: () => "parent" } };
	let calls = 0;
	return (count = 1) => {
		calls++;
		const children = Array.from({ length: count }, (_, index) => ({
			agent: "worker",
			name: `child-${calls}-${index}`,
			title: "Launch cap check",
			task: "Check the launch cap",
		}));
		return tool.execute(`call-${calls}`, { children }, undefined, undefined, ctx);
	};
}

const text = (result: any): string => (typeof result === "string" ? result : result.content[0].text);
const refused = (result: any): boolean => typeof result !== "string" && result.details?.error === "launch_cap";

describe("launch cap (D9)", () => {
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

	it("starts 64 runs and refuses the 65th with a text that names 64", async () => {
		const launch = fakeLaunchTool();
		for (let index = 0; index < 64; index++) {
			const result = await launch();
			assert.ok(!refused(result), `launch ${index + 1}: ${text(result)}`);
		}
		const result = await launch();
		assert.ok(refused(result), text(result));
		assert.match(text(result), /\b64 of 64\b/);
		assert.match(text(result), /PI_SUBAGENT_LAUNCH_CAP/);
	});

	it("refuses the third run when PI_SUBAGENT_LAUNCH_CAP is 2", async () => {
		process.env[LAUNCH_CAP_ENV] = "2";
		const launch = fakeLaunchTool();
		assert.ok(!refused(await launch()));
		assert.ok(!refused(await launch()));
		const third = await launch();
		assert.ok(refused(third), text(third));
		assert.match(text(third), /\b2 of 2\b/);
	});

	it("counts each child of a children list and refuses a batch over the cap before any launch", async () => {
		process.env[LAUNCH_CAP_ENV] = "3";
		let launches = 0;
		const launch = fakeLaunchTool(async (params) => {
			launches++;
			return makeRunning(params);
		});
		assert.ok(!refused(await launch(2)));
		const batch = await launch(2);
		assert.ok(refused(batch), text(batch));
		assert.equal(launches, 2, "the refused batch starts no child");
		assert.equal(getLaunchCountUsed(), 2);
	});

	it("lets only one of two batches admitted at the same time take the last slot", async () => {
		process.env[LAUNCH_CAP_ENV] = "1";
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const launch = fakeLaunchTool(async (params) => {
			await gate;
			return makeRunning(params);
		});
		const first = launch();
		const second = launch();
		release();
		const results = await Promise.all([first, second]);
		assert.deepEqual(results.map(refused).sort(), [false, true]);
		assert.equal(getLaunchCountUsed(), 1);
	});

	it("gives the slot back when a launch fails before the child starts", async () => {
		process.env[LAUNCH_CAP_ENV] = "1";
		let fail = true;
		const launch = fakeLaunchTool(async (params) => {
			if (fail) throw new Error("surface creation failed");
			return makeRunning(params);
		});
		await assert.rejects(launch(), /surface creation failed/);
		assert.equal(getLaunchCountUsed(), 0);
		fail = false;
		assert.ok(!refused(await launch()));
		assert.equal(getLaunchCountUsed(), 1);
	});

	it("counts a verified fan-out of 3 candidates as 3", async () => {
		process.env[LAUNCH_CAP_ENV] = "2";
		let launches = 0;
		const launch = fakeLaunchTool(
			async (params) => {
				launches++;
				return makeRunning(params);
			},
			{ spawning: true, llmAsVerifier: true, llmAsVerifierCandidates: 3 },
		);
		const result = await launch();
		assert.ok(refused(result), text(result));
		assert.match(text(result), /needs 3 more/);
		assert.equal(launches, 0);
		assert.equal(getLaunchCountUsed(), 0);
	});

	it("counts a resume, which the tool and the overlay share, and gives the slot back when it fails", async () => {
		process.env[LAUNCH_CAP_ENV] = "1";
		const input = {
			resultsDir: createTestDir(),
			parent: { parentCwd: process.cwd(), warnings: [] },
			sessionFile: join(createTestDir(), "missing.jsonl"),
		};
		await assert.rejects(resumeSubagentSession(input, {} as any), /Session file not found/);
		assert.equal(getLaunchCountUsed(), 0, "a resume that never starts gives its slot back");
		tryAcquireLaunchCapSlots(1)?.commit();
		await assert.rejects(resumeSubagentSession(input, {} as any), /Launch cap reached: .*1 of 1/);
	});

	it("keeps the count across a real reload and starts at 0 for a new, resumed or forked session", async () => {
		const cwd = createTestDir();
		const agentsDir = join(cwd, "agent-root", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "worker.md"),
			"---\nname: worker\ndescription: worker agent\nmode: background\nauto-exit: true\n---\n\nBody.",
		);
		process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-root");
		process.env[LAUNCH_CAP_ENV] = "1";
		useFakePi();
		const launchIn = async (extension: Awaited<ReturnType<typeof loadExtension>>, name: string) => {
			const tool = extension.tools.get("subagent");
			assert.ok(tool);
			const children = [{ agent: "worker", name, title: "Launch cap reload", task: "Check the cap" }];
			return tool.execute(`call-${name}`, { children }, undefined, undefined, extension.ctx);
		};
		const first = await loadExtension(cwd, "parent");
		await first.startSession("startup");
		const started = await launchIn(first, "before-reload");
		assert.ok(!refused(started), text(started));

		// Pi's /reload loads src/subagents.ts again as a fresh module instance in the same process.
		const reloaded = await loadExtension(cwd, "parent");
		await reloaded.startSession("reload");
		const afterReload = await launchIn(reloaded, "after-reload");
		assert.ok(refused(afterReload), text(afterReload));

		for (const reason of ["new", "resume", "fork"]) {
			await reloaded.startSession(reason);
			const result = await launchIn(reloaded, `after-${reason}`);
			assert.ok(!refused(result), `${reason}: ${text(result)}`);
		}
	});
});
