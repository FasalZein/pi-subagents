import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pendingRunEndCount, registerDeliveryQueue } from "../../src/runtime/delivery-queue.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { publishedResultFields, publishRunResult, type WatchedEnd } from "../../src/runtime/run-result.ts";
import { wireSubagentSteerBack } from "../../src/runtime/running-registry.ts";
import { isRunEndHeld } from "../../src/runtime/wait-holds.ts";
import { registerSubagentCoreTools, type SubagentToolRuntime } from "../../src/tools/subagent-tools.ts";
import { registerSubagentWaitTool } from "../../src/tools/wait-tool.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";
import {
	assert,
	createTestDir,
	describe,
	getLaunchedSubagentResultForTest,
	it,
	resetSubagentStateForTest,
	setRunningSubagentForTest,
} from "../support/index.ts";
import { sessionHeader, toolCall, toolResult, user } from "../support/result-fixtures.ts";

// T24 at the extension boundary: a real Pi parent session with a faux provider calls the real
// launch tool with two async children, then the real subagent_wait tool. The children are fakes;
// routing, the waits and the delivery queue are production code.

type ToolCall = ReturnType<typeof fauxToolCall>;

interface ChildState {
	root: string;
	store: ResultStore;
	finish: Map<string, (result: SubagentResult) => void>;
	runs: Map<string, RunningSubagent>;
}

function launchRuntime({ root, store, finish, runs }: ChildState): SubagentToolRuntime {
	return {
		loadAgentDefaults: () => ({ spawning: true, async: true, mode: "background" }) as never,
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		launchBackgroundSubagent: async (params) => {
			const running = {
				id: `id-${params.name}`,
				name: params.name,
				task: params.task,
				agent: "worker-a",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				blocking: false,
				async: true,
				startTime: Date.now(),
				sessionFile: join(root, `${params.name}.jsonl`),
				resultTarget: { store, reservation: store.reserve(), parentCwd: root, warnings: [] },
			} as RunningSubagent;
			setRunningSubagentForTest(running as never);
			runs.set(params.name, running);
			return running;
		},
		launchSubagent: async () => {
			throw new Error("no pane");
		},
		watchBackgroundSubagent: (running) =>
			new Promise<SubagentResult>((resolve) => {
				finish.set(running.name, resolve);
			}),
		watchSubagent: async () => new Promise<SubagentResult>(() => {}),
		getWatcherSignal: (_running, controller) => controller.signal,
		wireSubagentSteerBack: (pi, running, promise) => wireSubagentSteerBack(pi as never, running, promise, () => {}),
		startWidgetRefresh: () => {},
		getLaunchedSubagentResult: (running, signal) => getLaunchedSubagentResultForTest(running, signal),
		listLaunchableAgents: () => [],
		muxUnavailableResult: () => ({ content: [{ type: "text", text: "mux" }], details: {} }),
	};
}

interface Parent {
	session: AgentSession;
	/** What the model read on each request that answered a tool result or a message. */
	requests: string[];
	finish(name: string, summary: string): void;
	launched(name: string): boolean;
	/** Ends a child the way its watcher does after the child called subagent_done: a published record. */
	finishWithCall(name: string, args: Record<string, unknown>): void;
	/** Lets the test's gate tool return. */
	releaseGate(): void;
	waitReplies(): { text: string; details: Record<string, unknown>; isError: boolean }[];
	resultMessages(): number;
	dispose(): Promise<void>;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block as { text?: string }).text ?? "").join("");
}

/** A scripted model: each prompt text maps to the tool calls of one reply; anything else ends the turn. */
async function startParent(plan: Record<string, ToolCall[]>, options: { codemode?: boolean } = {}): Promise<Parent> {
	const root = createTestDir();
	const agentDir = join(root, "agent");
	const faux = fauxProvider();
	const requests: string[] = [];
	const step = (context: { messages: { role: string; content: unknown }[] }): AssistantMessage => {
		const last = context.messages.at(-1);
		const calls = last?.role === "user" ? plan[textOf(last.content)] : undefined;
		if (calls) return fauxAssistantMessage(calls, { stopReason: "toolUse" });
		requests.push(JSON.stringify(context.messages.map((message) => message.content)));
		return fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 20 }, () => step as never));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"),
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const children: ChildState = {
		root,
		store: new ResultStore(join(root, "results"), () => {}),
		finish: new Map(),
		runs: new Map(),
	};
	const { finish } = children;
	let releaseGate!: () => void;
	const gate = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});
	const extension: ExtensionFactory = (pi) => {
		registerDeliveryQueue(pi);
		registerSubagentCoreTools(pi, () => true, launchRuntime(children));
		registerSubagentWaitTool(pi, () => true, { mayLaunch: () => true });
		pi.registerTool({
			name: "gate",
			label: "Gate",
			description: "Returns when the test releases it.",
			parameters: Type.Object({}),
			execute: async () => {
				await gate;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		});
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		extensionFactories: options.codemode ? [extension, createCodemodeExtension({ mode: "on" })] : [extension],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: root,
		agentDir,
		modelRuntime,
		model: faux.getModel(),
		resourceLoader,
		settingsManager: SettingsManager.inMemory(options.codemode ? { defaultTools: ["+codemode"] } : {}),
		sessionManager: SessionManager.create(root, join(root, "sessions")),
	});
	// An interactive parent: a headless one awaits every launch, so no run would still be running.
	const ui = new Proxy({}, { get: () => () => undefined });
	await session.bindExtensions({ uiContext: ui as never });
	return {
		session,
		requests,
		finish: (name, summary) =>
			finish.get(name)?.({
				name,
				task: "t",
				summary,
				summarySource: "subagent",
				sessionFile: `/tmp/${name}.jsonl`,
				exitCode: 0,
				elapsed: 1,
			}),
		launched: (name) => finish.has(name),
		finishWithCall: (name, args) => {
			const running = children.runs.get(name);
			if (!running) assert.fail(`no child ${name}`);
			const entries = [
				sessionHeader(),
				user("task"),
				toolCall("subagent_done", args, "done-1"),
				toolResult("subagent_done", "done-1", "Result recorded."),
			];
			writeFileSync(running.sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
			const end: WatchedEnd = {
				exitCode: 0,
				operatorClosed: false,
				stopped: false,
				exitSignal: { reason: "done", exitCode: 0, acceptedCall: { toolCallId: "done-1", args } },
				contextUsage: {},
			};
			const published = publishRunResult(running, end);
			if (!published) assert.fail("the run published no record");
			finish.get(name)?.({
				name,
				task: "t",
				summary: published.summary,
				summarySource: published.summarySource,
				sessionFile: running.sessionFile,
				exitCode: 0,
				elapsed: 1,
				...publishedResultFields(published),
			});
		},
		releaseGate,
		waitReplies: () =>
			session.messages.flatMap((message) =>
				message.role === "toolResult" && message.toolName === "subagent_wait"
					? [
							{
								text: textOf(message.content),
								details: message.details as Record<string, unknown>,
								isError: message.isError,
							},
						]
					: [],
			),
		resultMessages: () =>
			session.messages.filter((message) => message.role === "custom" && message.customType === "subagent_result")
				.length,
		async dispose() {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			resetSubagentStateForTest();
		},
	};
}

const LAUNCH = [
	fauxToolCall(
		"subagent",
		{
			children: [
				{ name: "child-one", task: "a", title: "One", agent: "worker-a" },
				{ name: "child-two", task: "b", title: "Two", agent: "worker-a" },
			],
		},
		{ id: "launch-1" },
	),
];

function waitCall(id: string, args: Parameters<typeof fauxToolCall>[1]): ToolCall {
	return fauxToolCall("subagent_wait", args, { id });
}

async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!condition()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function launchBoth(parent: Parent): Promise<void> {
	await parent.session.prompt("delegate");
	await parent.session.waitForIdle();
	assert.ok(parent.launched("child-one") && parent.launched("child-two"), "both children run");
}

const BOTH = ["id-child-one", "id-child-two"];

describe("T24: subagent_wait in a real Pi session", () => {
	it("check 1: a later call joins two running children; both results come back in the reply, no message", async () => {
		const parent = await startParent({ delegate: LAUNCH, join: [waitCall("wait-1", { ids: BOTH })] });
		try {
			await launchBoth(parent);
			const run = parent.session.prompt("join");
			await until(() => isRunEndHeld("id-child-one") && isRunEndHeld("id-child-two"), "the wait holds both runs");
			parent.finish("child-one", "CHILD-ONE-REPORT");
			await new Promise((resolve) => setTimeout(resolve, 20));
			parent.finish("child-two", "CHILD-TWO-REPORT");
			await run;
			await parent.session.waitForIdle();
			const [reply] = parent.waitReplies();
			assert.match(reply!.text, /CHILD-ONE-REPORT/);
			assert.match(reply!.text, /CHILD-TWO-REPORT/);
			assert.equal(reply!.details.status, "complete");
			assert.deepEqual(reply!.details.pending, []);
			assert.equal(parent.resultMessages(), 0, "no message is sent for a result the wait returned");
			assert.equal(pendingRunEndCount(), 0);
			const last = parent.requests.at(-1)!;
			assert.equal(last.split("CHILD-ONE-REPORT").length - 1, 1, "the next request holds child 1 once");
		} finally {
			await parent.dispose();
		}
	});

	it("check 3: mode any with two simultaneous ends returns both", async () => {
		const parent = await startParent({ delegate: LAUNCH, join: [waitCall("wait-1", { mode: "any" })] });
		try {
			await launchBoth(parent);
			const run = parent.session.prompt("join");
			await until(() => isRunEndHeld("id-child-two"), "the wait holds the runs");
			parent.finish("child-one", "CHILD-ONE-REPORT");
			parent.finish("child-two", "CHILD-TWO-REPORT");
			await run;
			await parent.session.waitForIdle();
			const [reply] = parent.waitReplies();
			assert.match(reply!.text, /CHILD-ONE-REPORT/);
			assert.match(reply!.text, /CHILD-TWO-REPORT/);
			assert.deepEqual(reply!.details.pending, []);
			assert.equal(parent.resultMessages(), 0);
		} finally {
			await parent.dispose();
		}
	});

	it("check 3: mode any with one end returns it and lists the other as pending; the other reports by message", async () => {
		const parent = await startParent({ delegate: LAUNCH, join: [waitCall("wait-1", { ids: BOTH, mode: "any" })] });
		try {
			await launchBoth(parent);
			const run = parent.session.prompt("join");
			await until(() => isRunEndHeld("id-child-one"), "the wait holds the runs");
			parent.finish("child-one", "CHILD-ONE-REPORT");
			await run;
			await parent.session.waitForIdle();
			const [reply] = parent.waitReplies();
			assert.match(reply!.text, /CHILD-ONE-REPORT/);
			assert.doesNotMatch(reply!.text, /CHILD-TWO-REPORT/);
			assert.deepEqual(reply!.details.pending, ["id-child-two"]);
			assert.equal(isRunEndHeld("id-child-two"), false, "the returned wait holds nothing");
			parent.finish("child-two", "CHILD-TWO-REPORT");
			await until(() => parent.resultMessages() === 1, "child 2 reports by message");
			await parent.session.waitForIdle();
			assert.match(parent.requests.at(-1)!, /CHILD-TWO-REPORT/);
		} finally {
			await parent.dispose();
		}
	});

	it("check 3: a time limit returns the finished result and the pending id; the pending run reports by message", async () => {
		const parent = await startParent({
			delegate: LAUNCH,
			join: [waitCall("wait-1", { ids: BOTH, timeout: 0.3 })],
		});
		try {
			await launchBoth(parent);
			const run = parent.session.prompt("join");
			await until(() => isRunEndHeld("id-child-one"), "the wait holds the runs");
			parent.finish("child-one", "CHILD-ONE-REPORT");
			await run;
			await parent.session.waitForIdle();
			const [reply] = parent.waitReplies();
			assert.equal(reply!.details.status, "timeout");
			assert.match(reply!.text, /CHILD-ONE-REPORT/);
			assert.deepEqual(reply!.details.pending, ["id-child-two"]);
			assert.equal(parent.resultMessages(), 0, "the returned result sends no message");
			parent.finish("child-two", "CHILD-TWO-REPORT");
			await until(() => parent.resultMessages() === 1, "child 2 reports by message");
		} finally {
			await parent.dispose();
		}
	});

	it("check 6 (fix round 1, P1): a codemode script receives each run's published record as an object", async () => {
		const script = [
			'const r = await tools.subagent_wait({ ids: ["id-child-one", "id-child-two"] });',
			'if (typeof r !== "object") return `TEXT ${r}`;',
			'const one = r.results.find((x) => x.id === "id-child-one").record;',
			"return `OBJECT ${r.status} answer=${one.data?.answer} outcome=${one.outcome} typed=${one.typed} summary=${one.summary} saved=${one.report?.saved} resumable=${one.resume?.resumable}`;",
		].join("\n");
		const parent = await startParent(
			{ delegate: LAUNCH, join: [fauxToolCall("codemode", { code: script }, { id: "script-1" })] },
			{ codemode: true },
		);
		try {
			await launchBoth(parent);
			const run = parent.session.prompt("join");
			await until(() => isRunEndHeld("id-child-two"), "the script's wait holds the runs");
			parent.finishWithCall("child-one", { outcome: "done", summary: "Finished", data: { answer: 42 } });
			parent.finishWithCall("child-two", { outcome: "partial", summary: "Half" });
			await run;
			await parent.session.waitForIdle();
			const [scriptText] = parent.session.messages.flatMap((message) =>
				message.role === "toolResult" && message.toolName === "codemode" ? [textOf(message.content)] : [],
			);
			assert.ok(scriptText, "the script ran");
			assert.match(
				scriptText,
				/OBJECT complete answer=42 outcome=done typed=true summary=Finished saved=true resumable=true/,
			);
			assert.equal(parent.resultMessages(), 0, "the script's returned wait delivered both");
		} finally {
			await parent.dispose();
		}
	});

	it("check 2 (fix round 1): a no-ids wait takes an end queued before it started and skips an observed verified run", async () => {
		const script = [
			"await tools.gate({});",
			"const r = await tools.subagent_wait({});",
			'return `IDS ${r.results.map((x) => x.id).sort().join(",")} PENDING ${r.pending.join(",")} STATUS ${r.status}`;',
		].join("\n");
		const parent = await startParent(
			{ delegate: LAUNCH, join: [fauxToolCall("codemode", { code: script }, { id: "script-1" })] },
			{ codemode: true },
		);
		try {
			await launchBoth(parent);
			// Another session's verified run that this session only observes (D18): never its to receive.
			setRunningSubagentForTest({
				id: "foreign",
				name: "foreign",
				task: "t",
				agent: "worker-a",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "continue",
				async: true,
				startTime: Date.now(),
				sessionFile: "",
				verifiedRunId: "run-foreign",
				verifiedRunCancelDenied: true,
				completionPromise: new Promise<SubagentResult>(() => {}),
			} as RunningSubagent);
			const run = parent.session.prompt("join");
			await until(() => parent.session.isStreaming, "the script runs");
			await new Promise((resolve) => setTimeout(resolve, 20));
			parent.finish("child-one", "CHILD-ONE-REPORT");
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(pendingRunEndCount(), 1, "child 1's end is queued while the script runs");
			parent.releaseGate();
			await until(() => isRunEndHeld("id-child-two"), "the no-ids wait holds child 2");
			parent.finish("child-two", "CHILD-TWO-REPORT");
			await run;
			await parent.session.waitForIdle();
			const [scriptText] = parent.session.messages.flatMap((message) =>
				message.role === "toolResult" && message.toolName === "codemode" ? [textOf(message.content)] : [],
			);
			assert.match(scriptText ?? "", /IDS id-child-one,id-child-two PENDING {2}STATUS complete/);
			assert.equal(parent.resultMessages(), 0, "the wait delivered child 1's queued end; no message");
			assert.equal(pendingRunEndCount(), 0);
		} finally {
			await parent.dispose();
		}
	});

	it("check 4: two overlapping waits on one run both return its result, no message", async () => {
		const parent = await startParent({
			delegate: LAUNCH,
			join: [waitCall("wait-a", { ids: ["id-child-one"] }), waitCall("wait-b", { ids: ["id-child-one"] })],
		});
		try {
			await launchBoth(parent);
			const started: string[] = [];
			parent.session.subscribe((event) => {
				if (event.type === "tool_execution_start") started.push(event.toolCallId);
			});
			const run = parent.session.prompt("join");
			await until(() => started.length === 2 && isRunEndHeld("id-child-one"), "both waits run");
			await new Promise((resolve) => setTimeout(resolve, 20));
			parent.finish("child-one", "CHILD-ONE-REPORT");
			await run;
			await parent.session.waitForIdle();
			const replies = parent.waitReplies();
			assert.equal(replies.length, 2);
			for (const reply of replies) assert.match(reply.text, /CHILD-ONE-REPORT/);
			assert.equal(parent.resultMessages(), 0);
			assert.equal(pendingRunEndCount(), 0);
		} finally {
			await parent.dispose();
		}
	});

	it("check 4: one wait returns child 1, the overlapping wait is aborted: child 1 comes from the returned reply only, child 2 reports by message", async () => {
		const parent = await startParent({
			delegate: LAUNCH,
			join: [waitCall("wait-a", { ids: ["id-child-one"] }), waitCall("wait-b", { ids: BOTH })],
		});
		try {
			await launchBoth(parent);
			const ended: string[] = [];
			parent.session.subscribe((event) => {
				if (event.type === "tool_execution_end") ended.push(event.toolCallId);
			});
			const run = parent.session.prompt("join");
			await until(() => isRunEndHeld("id-child-two"), "wait b holds child 2");
			await new Promise((resolve) => setTimeout(resolve, 20));
			parent.finish("child-one", "CHILD-ONE-REPORT");
			await until(() => ended.includes("wait-a"), "wait a returned");
			assert.equal(ended.includes("wait-b"), false, "wait b still waits for child 2");
			await parent.session.abort();
			await run;
			const replies = parent.waitReplies();
			const returned = replies.find((reply) => !reply.isError)!;
			const aborted = replies.find((reply) => reply.isError)!;
			assert.match(returned.text, /CHILD-ONE-REPORT/);
			assert.equal(aborted.details.status, "interrupted");
			assert.doesNotMatch(aborted.text, /CHILD-ONE-REPORT/);
			assert.equal(parent.resultMessages(), 0, "child 1 is delivered by the returned wait, not again");
			assert.equal(pendingRunEndCount(), 0, "nothing of child 1 is left in the queue");
			parent.finish("child-two", "CHILD-TWO-REPORT");
			await until(() => parent.resultMessages() === 1, "child 2 keeps running and reports by message");
		} finally {
			await parent.dispose();
		}
	});
});
