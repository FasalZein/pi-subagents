import {
	afterEach,
	assert,
	createTestDir,
	describe,
	getCompletedSubagentResultForTest,
	getLaunchedSubagentResultForTest,
	getSubagentBatchStopMetadataForTest,
	it,
	markSubagentBatchBlockingForTest,
	requestSubagentBatchStopForTest,
	resetSubagentStateForTest,
	routeDetachedSubagentCompletionForTest,
	setRunningSubagentForTest,
	waitForSubagentForTest,
} from "../support/index.ts";
import { registerSubagentCoreTools, type SubagentToolRuntime } from "../../src/tools/subagent-tools.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";

describe("subagent launch result delivery", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("marks async detached launch results as terminating the current tool batch", async () => {
		const running = {
			id: "child-terminate",
			name: "Child",
			task: "Do work",
			mode: "background" as const,
			phase: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-terminate.jsonl",
		};

		const result = (await getLaunchedSubagentResultForTest(running as any)) as any;
		assert.equal((result.details as any).status, "started");
		assert.equal(result.terminate, true);
	});

	it("does not terminate async launch results when coordinator-only turn stop is disabled", async () => {
		process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = "1";
		const running = {
			id: "child-no-terminate-opt-out",
			name: "Child",
			task: "Do work",
			mode: "background" as const,
			phase: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-no-terminate-opt-out.jsonl",
		};

		const result = (await getLaunchedSubagentResultForTest(running as any)) as any;
		assert.equal((result.details as any).status, "started");
		assert.equal((result.details as any).async, true);
		assert.equal(result.terminate, undefined);
	});

	it("does not defer same-turn detached async completion when coordinator-only turn stop is disabled", async () => {
		process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = "1";
		const sent: Array<{ message: any; options: any }> = [];
		const running = {
			id: "child-no-defer-opt-out",
			name: "Async child",
			task: "Start work",
			mode: "background" as const,
			phase: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-no-defer-opt-out.jsonl",
		};

		setRunningSubagentForTest(running as any);
		const asyncResult = (await getLaunchedSubagentResultForTest(running as any)) as any;
		routeDetachedSubagentCompletionForTest(
			{
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running as any,
			{
				name: running.name,
				task: running.task,
				summary: "Async done",
				sessionFile: running.sessionFile,
				exitCode: 0,
				elapsed: 1,
			},
		);

		assert.equal(asyncResult.terminate, undefined);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].options.deliverAs, "steer");
	});

	it("steers a same-turn detached async completion in a terminating batch instead of parking it for the next prompt", async () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = {
			id: "child-deferred-steer",
			name: "Async child",
			task: "Start work",
			mode: "background" as const,
			phase: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-deferred-steer.jsonl",
		};

		setRunningSubagentForTest(running as any);
		const asyncResult = (await getLaunchedSubagentResultForTest(running as any)) as any;
		routeDetachedSubagentCompletionForTest(
			{
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running as any,
			{
				name: running.name,
				task: running.task,
				summary: "Async done",
				sessionFile: running.sessionFile,
				exitCode: 0,
				elapsed: 1,
			},
		);

		assert.equal(asyncResult.terminate, true);
		assert.equal(sent.length, 1);
		// D15: Pi drains queued steers after a terminating batch, so the result reaches the next request.
		assert.equal(sent[0].options.deliverAs, "steer");
		assert.equal(sent[0].options.triggerTurn, true);
		assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "steer");
	});

	it("awaits async children when the current subagent batch has a sync child", async () => {
		markSubagentBatchBlockingForTest();
		const asyncRunning = {
			id: "child-mixed-async-awaited",
			name: "Async child",
			task: "Start work",
			mode: "background" as const,
			phase: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-mixed-async-awaited.jsonl",
			completionPromise: Promise.resolve({
				name: "Async child",
				task: "Start work",
				summary: "Async done",
				sessionFile: "/tmp/child-mixed-async-awaited.jsonl",
				exitCode: 0,
				elapsed: 1,
			}),
		};

		setRunningSubagentForTest(asyncRunning as any);
		const asyncResult = (await getLaunchedSubagentResultForTest(asyncRunning as any)) as any;
		assert.equal((asyncResult.details as any).status, "completed");
		assert.equal((asyncResult.details as any).deliveryState, "awaited");
		assert.equal((asyncResult.details as any).async, true);
		assert.equal(asyncResult.terminate, undefined);
		assert.equal(getCompletedSubagentResultForTest(asyncRunning.id)?.deliveredTo, "wait");
	});

	it("does not mark mixed async and sync launch results as terminating when coordinator-only turn stop is disabled", async () => {
		process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = "1";
		const asyncRunning = {
			id: "child-mixed-async-opt-out",
			name: "Async child",
			task: "Start work",
			mode: "background" as const,
			phase: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-mixed-async-opt-out.jsonl",
		};
		const syncRunning = {
			id: "child-mixed-sync-opt-out",
			name: "Sync child",
			task: "Gate work",
			mode: "background" as const,
			phase: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: true,
			async: false,
			startTime: Date.now(),
			sessionFile: "/tmp/child-mixed-sync-opt-out.jsonl",
			completionPromise: Promise.resolve({
				name: "Sync child",
				task: "Gate work",
				summary: "Done",
				sessionFile: "/tmp/child-mixed-sync-opt-out.jsonl",
				exitCode: 0,
				elapsed: 1,
			}),
		};

		setRunningSubagentForTest(asyncRunning as any);
		setRunningSubagentForTest(syncRunning as any);
		const asyncResult = (await getLaunchedSubagentResultForTest(asyncRunning as any)) as any;
		const syncResult = (await getLaunchedSubagentResultForTest(syncRunning as any)) as any;
		assert.equal(asyncResult.terminate, undefined);
		assert.equal((syncResult.details as any).status, "completed");
		assert.equal(syncResult.terminate, undefined);
	});

	it("does not mark sync launch results as terminating the current tool batch", async () => {
		const running = {
			id: "child-sync-no-terminate",
			name: "Child",
			task: "Do work",
			mode: "background" as const,
			phase: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: true,
			async: false,
			startTime: Date.now(),
			sessionFile: "/tmp/child-sync-no-terminate.jsonl",
			completionPromise: Promise.resolve({
				name: "Child",
				task: "Do work",
				summary: "Done",
				sessionFile: "/tmp/child-sync-no-terminate.jsonl",
				exitCode: 0,
				elapsed: 1,
			}),
		};

		setRunningSubagentForTest(running as any);
		const result = (await getLaunchedSubagentResultForTest(running as any)) as any;
		assert.equal((result.details as any).status, "completed");
		assert.equal(result.terminate, undefined);
	});

	it("never terminates an awaited result even when the batch stop was requested from frontmatter", async () => {
		// The tool_call hook classifies a launch from frontmatter (`async: true`)
		// and requests the coordinator-only turn stop before execute runs. When
		// the launch is then awaited anyway, the completed report is already in
		// this tool result; a stop mark here would end the turn unread.
		requestSubagentBatchStopForTest();
		const running = {
			id: "child-awaited-after-stop",
			name: "Child",
			task: "Do work",
			mode: "background" as const,
			phase: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: true,
			async: false,
			startTime: Date.now(),
			sessionFile: "/tmp/child-awaited-after-stop.jsonl",
			completionPromise: Promise.resolve({
				name: "Child",
				task: "Do work",
				summary: "## Findings",
				sessionFile: "/tmp/child-awaited-after-stop.jsonl",
				exitCode: 0,
				elapsed: 687,
			}),
		};

		setRunningSubagentForTest(running as any);
		const result = (await getLaunchedSubagentResultForTest(running as any)) as any;
		assert.equal((result.details as any).status, "completed");
		assert.equal((result.details as any).deliveryState, "awaited");
		assert.equal(result.terminate, undefined);
	});

	it("records a headless forced-sync launch as a blocking batch so the completed report is read", async () => {
		// Replays the failing nested run: a `pi -p` parent (no UI) launches an
		// `async: true` agent. The tool_call hook already requested the batch
		// stop; the launch itself must be awaited and must not end the turn.
		requestSubagentBatchStopForTest();
		const launchedParams: Array<{ async?: boolean; blocking?: boolean }> = [];
		const tools = new Map<string, any>();
		const runtime: SubagentToolRuntime = {
			loadAgentDefaults: () => ({ spawning: false, async: true, mode: "background" }),
			resolveEffectiveSessionMode: () => "lineage-only",
			resolveTaskSessionMode: () => "lineage-only",
			launchBackgroundSubagent: async (params) => {
				launchedParams.push({ async: params.async, blocking: params.blocking });
				const running: RunningSubagent = {
					id: "scout-1",
					name: params.name,
					task: params.task,
					title: params.title,
					agent: params.agent,
					mode: "background",
					phase: "running",
					deliveryState: "detached",
					parentClosePolicy: "terminate",
					blocking: params.blocking,
					async: params.async,
					startTime: Date.now(),
					sessionFile: "/tmp/scout-1.jsonl",
				};
				setRunningSubagentForTest(running);
				return running;
			},
			launchSubagent: async () => {
				throw new Error("headless parents never open a pane");
			},
			watchBackgroundSubagent: async () =>
				({
					name: "scout-1",
					task: "Recon",
					summary: "## Findings",
					summarySource: "subagent",
					sessionFile: "/tmp/scout-1.jsonl",
					exitCode: 0,
					elapsed: 687,
				}) satisfies SubagentResult,
			watchSubagent: async () => new Promise<SubagentResult>(() => {}),
			getWatcherSignal: (_running, controller) => controller.signal,
			wireSubagentSteerBack: () => {},
			startWidgetRefresh: () => {},
			getLaunchedSubagentResult: (running, signal) => getLaunchedSubagentResultForTest(running, signal),
			muxUnavailableResult: () => ({ content: [{ type: "text", text: "mux" }], details: {} }),
			listLaunchableAgents: () => [],
		};
		registerSubagentCoreTools(
			{
				registerTool(definition: any) {
					tools.set(definition.name, definition);
					return definition;
				},
				getThinkingLevel: () => "low",
			} as any,
			() => true,
			runtime,
		);

		const result = await tools.get("subagent").execute(
			"call-1",
			{ children: [{ agent: "scout", name: "scout-1", title: "Recon", task: "Recon" }] },
			undefined,
			undefined,
			{
				hasUI: false,
				cwd: process.cwd(),
				sessionManager: { getSessionFile: () => "/tmp/parent.jsonl", getSessionId: () => "parent" },
			},
		);

		assert.deepEqual(launchedParams, [{ async: false, blocking: true }]);
		assert.deepEqual(getSubagentBatchStopMetadataForTest(), {});
		assert.equal((result.details as any).status, "completed");
		assert.equal((result.details as any).deliveryState, "awaited");
		assert.match(result.content[0].text, /## Findings/);
		assert.equal(result.terminate, undefined);
	});

	it("keeps parent tools available after waiting for detached children", async () => {
		const running = {
			id: "child-guard",
			name: "Child",
			task: "Do work",
			mode: "background" as const,
			phase: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/child-guard.jsonl",
			completionPromise: Promise.resolve({
				name: "Child",
				task: "Do work",
				summary: "Done",
				sessionFile: "/tmp/child-guard.jsonl",
				exitCode: 0,
				elapsed: 1,
			}),
		};

		setRunningSubagentForTest(running);
		const waited = await waitForSubagentForTest({ id: "Child" });
		assert.equal((waited.details as any).status, "completed");
		assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "wait");
	});
});
