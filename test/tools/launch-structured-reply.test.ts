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
import { pendingRunEndCount, queuedRunEndIds, registerDeliveryQueue } from "../../src/runtime/delivery-queue.ts";
import { outstandingWork } from "../../src/runtime/outstanding-work.ts";
import { getSessionResultsDir } from "../../src/artifact-storage.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { publishedResultFields, publishRunResult, type WatchedEnd } from "../../src/runtime/run-result.ts";
import { wireSubagentSteerBack } from "../../src/runtime/running-registry.ts";
import { runDeliveryState } from "../../src/runtime/wait-holds.ts";
import { registerSubagentKillTool } from "../../src/tools/kill-tool.ts";
import { getIgnoredModelOverrideWarning } from "../../src/tools/policy.ts";
import { registerSubagentCoreTools, type SubagentToolRuntime } from "../../src/tools/subagent-tools.ts";
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
import { stopRequesterOf } from "../../src/runtime/run-phase.ts";

// T28 at the extension boundary: a real Pi parent session with a faux provider calls the real
// launch tool, directly or from a codemode script. The children are fakes; launch, routing, the
// waits, the stop by id and the delivery queue are production code.

// A synthetic model ref for the fake children; never a real provider.
const CHILD_MODEL = "stub/child-model";
const FAILING_CHILD = "child-three";

/** A child's data as a script reads it; record is set when the child ended. */
interface ScriptChild {
	runId: string;
	name: string;
	agent: string;
	state: string;
	record: { runId: string; outcome: string; summary: string };
}

interface Harness {
	session: AgentSession;
	runs: Map<string, RunningSubagent>;
	launched(name: string): boolean;
	/** Ends a child the way its watcher does after the child called subagent_done: a published record. */
	finishWithCall(name: string, summary: string): void;
	/** Ends a child the way its watcher does after the child called caller_ping. */
	finishWithPing(name: string, message: string): void;
	stopped: string[];
	/** What the model read on each request that ended a turn. */
	requests: string[];
	toolResults(name: string): { text: string; details: Record<string, unknown>; isError: boolean }[];
	dispose(): Promise<void>;
}

/** A launch that waits claims its run's end (D15); the run record carries no delivery state. */
function isClaimed(run: RunningSubagent | undefined): boolean {
	return run !== undefined && runDeliveryState(run) === "awaited";
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block as { text?: string }).text ?? "").join("");
}

async function startParent(
	plan: Record<string, ReturnType<typeof fauxToolCall>[]>,
	options: {
		codemode?: boolean;
		beforeFailure?: (harness: Harness) => Promise<void>;
		/** The failing child's launch error; default "pane could not be created". */
		failError?: string;
		/** Runs before a child's launch returns, so a test can hold that launch. */
		beforeLaunch?: (name: string) => Promise<void>;
		/** A parent without a UI: every launch waits (shouldForceSynchronousLaunch), as in pi -p. */
		headless?: boolean;
		/** A model that answers every request; undefined falls back to the plan. */
		respond?: (messages: { role: string; content: unknown }[]) => AssistantMessage | undefined;
	} = {},
): Promise<Harness> {
	const root = createTestDir();
	const agentDir = join(root, "agent");
	const faux = fauxProvider();
	const step = (context: { messages: { role: string; content: unknown }[] }): AssistantMessage => {
		const answered = options.respond?.(context.messages);
		if (answered) return answered;
		const last = context.messages.at(-1);
		const calls = last?.role === "user" ? plan[textOf(last.content)] : undefined;
		if (calls) return fauxAssistantMessage(calls, { stopReason: "toolUse" });
		requests.push(JSON.stringify(context.messages.map((message) => message.content)));
		return fauxAssistantMessage("ok");
	};
	const requests: string[] = [];
	faux.setResponses(Array.from({ length: 20 }, () => step as never));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"),
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	// As the launch paths do: runs reserve their records in this parent session's results folder.
	const sessionManager = SessionManager.create(root, join(root, "sessions"));
	const store = new ResultStore(getSessionResultsDir(root, sessionManager.getSessionId()), () => {});
	const finish = new Map<string, (result: SubagentResult) => void>();
	const runs = new Map<string, RunningSubagent>();
	const stopped: string[] = [];
	let harness!: Harness;

	const finishWithCall = (name: string, summary: string, ping?: string) => {
		const running = runs.get(name);
		if (!running) assert.fail(`no child ${name}`);
		const args = ping === undefined ? { outcome: "done", summary } : { message: ping };
		const tool = ping === undefined ? "subagent_done" : "caller_ping";
		const entries = [
			sessionHeader(),
			user("task"),
			toolCall(tool, args, "done-1"),
			toolResult(tool, "done-1", "Result recorded."),
		];
		writeFileSync(running.sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const end: WatchedEnd = {
			exitCode: 0,
			operatorClosed: false,
			closedByPerson: false,
			stopped: false,
			...(ping === undefined ? {} : { ping: { message: ping } }),
			exitSignal:
				ping === undefined
					? { reason: "done", exitCode: 0, acceptedCall: { toolCallId: "done-1", args } }
					: { reason: "ping", exitCode: 0, ping: { name, message: ping } },
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
			...(ping === undefined ? {} : { ping: { name, message: ping } }),
			...publishedResultFields(published),
		});
	};

	const runtime: SubagentToolRuntime = {
		// worker-wait waits by its agent definition (async: false); worker-a reports later.
		// worker-locked ignores a model override, which gives its launch a warning.
		loadAgentDefaults: (agent) =>
			({
				spawning: true,
				async: agent !== "worker-wait",
				mode: "background",
				...(agent === "worker-locked" ? { allowModelOverride: false } : {}),
			}) as never,
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		launchBackgroundSubagent: async (params) => {
			if (params.name === FAILING_CHILD) {
				await options.beforeFailure?.(harness);
				throw new Error(options.failError ?? "pane could not be created");
			}
			await options.beforeLaunch?.(params.name);
			const reservation = store.reserve();
			const running = {
				id: reservation.runId,
				name: params.name,
				task: params.task,
				agent: params.agent,
				modelRef: CHILD_MODEL,
				mode: "background",
				phase: { kind: "running" },
				parentClosePolicy: "terminate",
				// worker-batch waits by the batch rule (blocking, not async: false), so Esc reaches its wait (D04a).
				blocking: params.agent === "worker-wait" || params.agent === "worker-batch",
				async: params.agent !== "worker-wait",
				startTime: Date.now(),
				sessionFile: join(root, `${params.name}.jsonl`),
				resultTarget: { store, reservation, parentCwd: root, warnings: [] },
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

	const extension: ExtensionFactory = (pi) => {
		registerDeliveryQueue(pi);
		registerSubagentCoreTools(pi, () => true, runtime);
		// A stop ends the fake child as its watcher would: with its own record.
		registerSubagentKillTool(
			pi,
			() => true,
			async (running) => {
				stopped.push(running.id);
				finishWithCall(running.name, `STOPPED ${running.name}`);
			},
		);
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
		sessionManager,
	});
	// An interactive parent: a headless one awaits every launch.
	// Pi spreads the UI context: a method that the parent calls (notify) must be an own key.
	const ui = new Proxy({ notify() {} }, { get: () => () => undefined });
	await session.bindExtensions(options.headless ? {} : { uiContext: ui as never });
	harness = {
		session,
		runs,
		launched: (name) => finish.has(name),
		finishWithCall,
		finishWithPing: (name, message) => finishWithCall(name, "", message),
		stopped,
		requests,
		toolResults: (name) =>
			session.messages.flatMap((message) =>
				message.role === "toolResult" && message.toolName === name
					? [
							{
								text: textOf(message.content),
								details: message.details as Record<string, unknown>,
								isError: message.isError,
							},
						]
					: [],
			),
		async dispose() {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			resetSubagentStateForTest();
		},
	};
	return harness;
}

function child(name: string, agent = "worker-a") {
	return { name, task: `work of ${name}`, title: `Title of ${name}`, agent };
}

const BATCH_OF_THREE = { children: [child("child-one"), child("child-two"), child(FAILING_CHILD)] };

async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!condition()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function scriptValue(harness: Harness): unknown {
	const [reply] = harness.toolResults("codemode");
	assert.ok(reply, "the script ran");
	const match = /JSON (.*)$/s.exec(reply.text);
	assert.ok(match, `the script returned JSON, got: ${reply.text}`);
	return JSON.parse(match[1]!);
}

function runOf(harness: Harness, name: string): RunningSubagent {
	const running = harness.runs.get(name);
	if (!running) assert.fail(`no child ${name}`);
	return running;
}

function launchScript(args: unknown): string {
	return [`const r = await tools.subagent(${JSON.stringify(args)});`, 'return "JSON " + JSON.stringify(r);'].join("\n");
}

describe("T28: structured launch replies", () => {
	it("check 1: a script receives each child's run id, name, agent, model ref, session file, pane and state", async () => {
		const harness = await startParent(
			{
				go: [
					fauxToolCall(
						"codemode",
						{ code: launchScript({ children: [child("child-one"), child("child-two")] }) },
						{ id: "script-1" },
					),
				],
			},
			{ codemode: true },
		);
		try {
			await harness.session.prompt("go");
			await harness.session.waitForIdle();
			const value = scriptValue(harness) as { status: string; children: Record<string, unknown>[] };
			assert.equal(value.status, "launched");
			assert.deepEqual(
				value.children,
				["child-one", "child-two"].map((name) => ({
					runId: runOf(harness, name).id,
					name,
					agent: "worker-a",
					modelRef: CHILD_MODEL,
					sessionFile: runOf(harness, name).sessionFile,
					where: "headless",
					state: "started",
				})),
			);
		} finally {
			await harness.dispose();
		}
	});

	it("check 1: the reply text names each child and run id but shows no session path", async () => {
		const harness = await startParent({
			go: [fauxToolCall("subagent", { children: [child("child-one"), child("child-two")] }, { id: "launch-1" })],
		});
		try {
			await harness.session.prompt("go");
			await harness.session.waitForIdle();
			const [reply] = harness.toolResults("subagent");
			for (const name of ["child-one", "child-two"]) {
				const running = runOf(harness, name);
				assert.match(reply?.text ?? "", new RegExp(`${name}.*run ${running.id}`));
				assert.equal(reply?.text.includes(running.sessionFile), false, "no session path in the text");
			}
			assert.equal(reply?.text.includes(".jsonl"), false);
		} finally {
			await harness.dispose();
		}
	});

	it("check 1: a waiting child is ended and carries its record", async () => {
		const harness = await startParent(
			{
				go: [
					fauxToolCall(
						"codemode",
						{ code: launchScript({ children: [child("child-wait", "worker-wait")] }) },
						{ id: "script-1" },
					),
				],
			},
			{ codemode: true },
		);
		try {
			const run = harness.session.prompt("go");
			await until(() => isClaimed(harness.runs.get("child-wait")), "the launch owns the wait");
			harness.finishWithCall("child-wait", "WAITED-SUMMARY");
			await run;
			await harness.session.waitForIdle();
			const value = scriptValue(harness) as { status: string; children: ScriptChild[] };
			const [only] = value.children;
			assert.equal(value.status, "launched");
			assert.equal(only?.state, "ended");
			assert.equal(only?.runId, runOf(harness, "child-wait").id);
			assert.equal(only?.record.outcome, "done");
			assert.equal(only?.record.summary, "WAITED-SUMMARY");
			assert.equal(only?.record.runId, runOf(harness, "child-wait").id);
		} finally {
			await harness.dispose();
		}
	});
});

// D05 (T78): the cf6dbf4 input forms through a real Pi session, so Pi's prepareArguments and argument
// validation run before execute. Expected values: cf6dbf4 getRequestedChildren and the D05 owner rule.
describe("D05: launch input forms through Pi validation", () => {
	const forms: Array<[string, unknown, string[]]> = [
		["the top-level single form", child("solo-worker"), ["solo-worker"]],
		["an empty children list with top-level fields", { ...child("solo-worker"), children: [] }, ["solo-worker"]],
		[
			"a children list sent as a JSON string",
			{ children: JSON.stringify([child("child-one"), child("child-two")]) },
			["child-one", "child-two"],
		],
	];
	for (const [what, args, names] of forms) {
		it(`${what} starts ${names.join(" and ")}`, async () => {
			const harness = await startParent({ go: [fauxToolCall("subagent", args as never, { id: "launch-1" })] });
			try {
				await harness.session.prompt("go");
				await harness.session.waitForIdle();
				const [reply] = harness.toolResults("subagent");
				assert.equal(reply?.isError, false, reply?.text);
				for (const name of names) assert.ok(harness.launched(name), `${name} started`);
			} finally {
				await harness.dispose();
			}
		});
	}

	it("a JSON-looking task string reaches the child as the same string", async () => {
		const task = '{"verdict":"approve"}';
		const harness = await startParent({
			go: [
				fauxToolCall("subagent", { children: JSON.stringify([{ ...child("child-one"), task }]) }, { id: "launch-1" }),
			],
		});
		try {
			await harness.session.prompt("go");
			await harness.session.waitForIdle();
			assert.equal(runOf(harness, "child-one").task, task);
		} finally {
			await harness.dispose();
		}
	});
});

describe("T28 fix round 1: a started reply does not deliver a queued result", () => {
	it("P1: child one ends while child two launches; its report reaches the model by message and stays owed until then", async () => {
		let releaseLaunch!: () => void;
		const launchGate = new Promise<void>((resolve) => {
			releaseLaunch = resolve;
		});
		const harness = await startParent(
			{
				go: [fauxToolCall("subagent", { children: [child("child-one"), child("child-two")] }, { id: "launch-1" })],
			},
			{ beforeLaunch: (name) => (name === "child-two" ? launchGate : Promise.resolve()) },
		);
		// A subscriber makes the runtime keep its outstanding-work count (as the Herdr sidebar does).
		const unsubscribe = outstandingWork.subscribe(() => {});
		const atLaunchReply: { queued: string[]; owed: number }[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolName === "subagent")
				atLaunchReply.push({ queued: queuedRunEndIds(), owed: outstandingWork.count });
		});
		try {
			const run = harness.session.prompt("go");
			await until(() => harness.launched("child-one"), "child one runs");
			harness.finishWithCall("child-one", "ONE-EARLY-REPORT");
			await until(() => pendingRunEndCount() === 1, "child one's end is queued");
			releaseLaunch();
			await run;
			await harness.session.waitForIdle();
			const one = runOf(harness, "child-one").id;
			const [reply] = harness.toolResults("subagent");
			assert.doesNotMatch(reply?.text ?? "", /ONE-EARLY-REPORT/, "the started reply holds no report");
			assert.deepEqual(atLaunchReply[0]?.queued, [one], "child one's end is still queued after the started reply");
			assert.ok((atLaunchReply[0]?.owed ?? 0) >= 1, "child one's report is still owed");
			assert.ok(
				harness.requests.some((request) => request.includes("ONE-EARLY-REPORT")),
				"child one's report reaches the model",
			);
			assert.equal(pendingRunEndCount(), 0, "the committed message delivered it");
		} finally {
			unsubscribe();
			await harness.dispose();
		}
	});
});

describe("T28 fix round 1: launch facts and failure text", () => {
	it("P2: an interrupted wait leaves the child started, not ended without a record", async () => {
		const harness = await startParent({
			go: [fauxToolCall("subagent", { children: [child("child-wait", "worker-batch")] }, { id: "launch-1" })],
		});
		const structured: unknown[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolName === "subagent")
				structured.push((event.result as { structuredContent?: unknown }).structuredContent);
		});
		try {
			const run = harness.session.prompt("go");
			await until(() => isClaimed(harness.runs.get("child-wait")), "the launch owns the wait");
			await harness.session.abort();
			await run;
			const value = structured[0] as { children: ScriptChild[] } | undefined;
			assert.equal(value?.children[0]?.state, "started");
			assert.equal(value?.children[0]?.runId, runOf(harness, "child-wait").id);
			// D04a: as v2.9.2 (cf6dbf4), the launch wait that observed Esc stops the child.
			assert.equal(stopRequesterOf(runOf(harness, "child-wait")), "operator");
		} finally {
			await harness.dispose();
		}
	});

	it("P2: the failure text is state-neutral, names no session path and lists the started children's warnings", async () => {
		const sessionPath = "/tmp/t28/sessions/2026-11-19_child-three.jsonl";
		const lockedChild = { ...child("child-one", "worker-locked"), model: "stub/other-model" };
		const harness = await startParent(
			{
				go: [
					fauxToolCall(
						"subagent",
						{ children: [lockedChild, child("child-two"), child(FAILING_CHILD)] },
						{ id: "launch-1" },
					),
				],
			},
			{
				failError: `EACCES: permission denied, open '${sessionPath}'`,
				beforeFailure: async (h) => {
					h.finishWithCall("child-one", "ONE-DONE-EARLY");
				},
			},
		);
		try {
			await harness.session.prompt("go");
			await harness.session.waitForIdle();
			const [reply] = harness.toolResults("subagent");
			const text = reply?.text ?? "";
			assert.equal(reply?.isError, true);
			assert.match(text, /failed to launch: EACCES: permission denied, open '<path>'/);
			assert.equal(text.includes(sessionPath), false, "no session path in the text");
			assert.equal(text.includes(".jsonl"), false);
			assert.doesNotMatch(text, /keep running/, "an ended sibling is not said to keep running");
			const warning = getIgnoredModelOverrideWarning("worker-locked", false, lockedChild);
			assert.ok(warning, "the locked agent's model override gives a warning");
			assert.ok(text.includes(warning), "the started child's launch warning is in the failure text");
			const failed = (reply?.details as { failed?: { error: string } } | undefined)?.failed;
			assert.equal(failed?.error.includes(sessionPath), false, "no session path in the data either");
		} finally {
			await harness.dispose();
		}
	});
});

describe("T28: a batch whose later child fails to launch", () => {
	it("check 2: a direct call gets an error result whose text names the failed child and both started run ids", async () => {
		const harness = await startParent({ go: [fauxToolCall("subagent", BATCH_OF_THREE, { id: "launch-1" })] });
		try {
			await harness.session.prompt("go");
			await harness.session.waitForIdle();
			const [reply] = harness.toolResults("subagent");
			assert.ok(reply, "the launch tool replied");
			assert.equal(reply.isError, true);
			assert.match(
				reply.text,
				/child 3 of 3, child-three \(agent worker-a\), failed to launch: pane could not be created/,
			);
			for (const name of ["child-one", "child-two"]) assert.match(reply.text, new RegExp(runOf(harness, name).id));
			assert.equal(reply.text.includes(".jsonl"), false, "no session path in the text");
			assert.equal(reply.details.status, "launch_failed");
		} finally {
			await harness.dispose();
		}
	});

	it("checks 2 to 4: a script gets the object, recovers on it alone with one sibling already ended, then stops the started children by id; their results arrive by message", async () => {
		// The script uses only the launch object: the ended sibling's record, the started sibling's run id.
		const script = [
			"let r;",
			"try { r = await tools.subagent(" +
				JSON.stringify(BATCH_OF_THREE) +
				'); } catch (e) { return "THROWN " + e.message; }',
			'if (typeof r !== "object" || r.status !== "launch_failed") return "JSON " + JSON.stringify({ notFailure: r });',
			'const ended = r.children.filter((c) => c.state === "ended");',
			'const running = r.children.filter((c) => c.state === "started");',
			"const stops = [];",
			"for (const c of running) stops.push(await tools.subagent_kill({ runId: c.runId }));",
			'return "JSON " + JSON.stringify({ launch: r, ended: ended.map((c) => c.record.summary), stops });',
		].join("\n");
		const harness = await startParent(
			{ go: [fauxToolCall("codemode", { code: script }, { id: "script-1" })] },
			{
				codemode: true,
				// child-one ends before child-three's launch fails.
				beforeFailure: async (h) => {
					h.finishWithCall("child-one", "ONE-DONE-EARLY");
					await new Promise((resolve) => setImmediate(resolve));
				},
			},
		);
		try {
			await harness.session.prompt("go");
			await harness.session.waitForIdle();
			const value = scriptValue(harness) as {
				launch: { status: string; failed: unknown; children: ScriptChild[] };
				ended: string[];
			};
			const one = runOf(harness, "child-one").id;
			const two = runOf(harness, "child-two").id;
			assert.equal(value.launch.status, "launch_failed");
			assert.deepEqual(value.launch.failed, {
				position: 3,
				name: FAILING_CHILD,
				agent: "worker-a",
				error: "pane could not be created",
			});
			assert.deepEqual(
				value.launch.children.map((c) => [c.runId, c.name, c.agent, c.state]),
				[
					[one, "child-one", "worker-a", "ended"],
					[two, "child-two", "worker-a", "started"],
				],
			);
			assert.deepEqual(value.ended, ["ONE-DONE-EARLY"], "the ended sibling carries its record");
			assert.deepEqual(harness.stopped, [two], "the started child was stopped by its run id");
			// Owner 2026-11-24 (no wait tool): the stopped child's result reaches the parent as a message.
			const messages = harness.session.messages
				.filter((message) => message.role === "custom" && message.customType === "subagent_result")
				.map((message) => JSON.stringify((message as { content: unknown }).content))
				.join("\n");
			assert.match(messages, new RegExp(two));
			assert.match(messages, /STOPPED child-two/);
			assert.equal(harness.launched(FAILING_CHILD), false, "the failed child never ran");
		} finally {
			await harness.dispose();
		}
	});
});

describe("g3 P1: a launch refused before any child starts", () => {
	const ENV_KEYS = ["PI_SUBAGENT_SPAWN_WIDTH"] as const;

	/** Runs the second launch of a script; the first launch takes the only slot when one is given. */
	async function refusedInScript(
		env: Partial<Record<(typeof ENV_KEYS)[number], string>>,
		first: unknown,
		second: unknown,
	) {
		const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
		Object.assign(process.env, env);
		resetSubagentStateForTest();
		const script = [
			first === undefined ? "" : `await tools.subagent(${JSON.stringify(first)});`,
			`try { const r = await tools.subagent(${JSON.stringify(second)}); return "JSON " + JSON.stringify({ resolved: r }); }`,
			'catch (e) { return "JSON " + JSON.stringify({ rejected: e.message }); }',
		].join("\n");
		const harness = await startParent(
			{ go: [fauxToolCall("codemode", { code: script }, { id: "script-1" })] },
			{ codemode: true },
		);
		try {
			await harness.session.prompt("go");
			await harness.session.waitForIdle();
			return scriptValue(harness) as { resolved?: unknown; rejected?: string };
		} finally {
			await harness.dispose();
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			resetSubagentStateForTest();
		}
	}

	const one = { children: [child("child-one")] };
	const two = { children: [child("child-two")] };

	it("rejects the script call for a batch wider than the spawn width", async () => {
		const value = await refusedInScript({ PI_SUBAGENT_SPAWN_WIDTH: "1" }, undefined, {
			children: [child("child-one"), child("child-two")],
		});
		assert.equal(value.resolved, undefined, "the refusal is not a successful value");
		assert.match(value.rejected ?? "", /exceeds the spawn width limit of 1/);
	});

	it("rejects the script call when every spawn slot is busy", async () => {
		const value = await refusedInScript({ PI_SUBAGENT_SPAWN_WIDTH: "1" }, one, two);
		assert.equal(value.resolved, undefined, "the refusal is not a successful value");
		assert.match(value.rejected ?? "", /Spawn width limit reached/);
	});
});

describe("T89b, amended 2026-11-24: a parent that follows a spawn-width refusal literally", () => {
	/** The next step a refusal names: how many children to launch now, and the holders whose end frees slots. */
	function nextStep(refusal: string): { launchNow: number; holders: string[] } {
		const fit = /The first (\d+) child(?:ren)? \(\d+ slots?\) fits? now/.exec(refusal);
		const held =
			/end this turn \(a codemode script returns\); when one of the runs (\S+(?:, \S+)*) ends it frees its slots/.exec(
				refusal,
			);
		return { launchNow: fit ? Number(fit[1]) : 0, holders: held?.[1]?.split(", ") ?? [] };
	}

	it("gets every child of a refused batch admitted by launching what fits, ending the turn and retrying after a result message", async () => {
		const saved = process.env.PI_SUBAGENT_SPAWN_WIDTH;
		process.env.PI_SUBAGENT_SPAWN_WIDTH = "2";
		resetSubagentStateForTest();
		const attempt = (batch: unknown) =>
			[
				`try { await tools.subagent(${JSON.stringify({ children: batch })}); return "JSON " + JSON.stringify({ admitted: true }); }`,
				'catch (e) { return "JSON " + JSON.stringify({ refusal: e.message }); }',
			].join("\n");
		let pending = [child("child-b"), child("child-c"), child("child-d")];
		const plan: Record<string, ReturnType<typeof fauxToolCall>[]> = {
			go: [
				fauxToolCall(
					"codemode",
					{ code: `await tools.subagent(${JSON.stringify({ children: [child("child-a")] })});\n${attempt(pending)}` },
					{ id: "script-0" },
				),
			],
		};
		const harness = await startParent(plan, { codemode: true });
		const lastValue = () => {
			const reply = harness.toolResults("codemode").at(-1);
			const match = /JSON (.*)$/s.exec(reply?.text ?? "");
			assert.ok(match, `the script returned JSON, got: ${reply?.text}`);
			return JSON.parse(match[1] as string) as { admitted?: true; refusal?: string };
		};
		const resultMessages = () =>
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "subagent_result",
			).length;
		try {
			await harness.session.prompt("go");
			await harness.session.waitForIdle();
			let value = lastValue();
			const refusals: string[] = [];
			for (let round = 1; value.refusal !== undefined; round++) {
				assert.ok(round <= 3, `admitted within 3 rounds; refusals: ${refusals.join(" | ")}`);
				refusals.push(value.refusal);
				assert.doesNotMatch(value.refusal, /subagent_wait/);
				const step = nextStep(value.refusal);
				assert.ok(step.holders.length > 0, `the refusal names the runs whose end frees slots: ${value.refusal}`);
				const now = pending.slice(0, step.launchNow);
				pending = pending.slice(step.launchNow);
				if (now.length > 0) {
					plan[`launch-${round}`] = [
						fauxToolCall(
							"codemode",
							{ code: `await tools.subagent(${JSON.stringify({ children: now })});\nreturn "launched";` },
							{ id: `launch-${round}` },
						),
					];
					await harness.session.prompt(`launch-${round}`);
					await harness.session.waitForIdle();
					for (const entry of now) assert.ok(harness.launched(entry.name), entry.name);
				}
				// The turn ended. One named run ends, as a child does on its own: its slots free and its
				// result arrives as a message.
				const before = resultMessages();
				const name = [...harness.runs.values()].find((running) => running.id === step.holders[0])?.name;
				assert.ok(name, `the named run ${step.holders[0]} is a launched child`);
				harness.finishWithCall(name, `${name} DONE`);
				await until(() => resultMessages() > before, `the result message of ${name}`);
				await harness.session.waitForIdle();
				plan[`retry-${round}`] = [fauxToolCall("codemode", { code: attempt(pending) }, { id: `retry-${round}` })];
				await harness.session.prompt(`retry-${round}`);
				await harness.session.waitForIdle();
				value = lastValue();
			}
			assert.equal(value.admitted, true);
			for (const name of ["child-a", "child-b", "child-c", "child-d"]) assert.ok(harness.launched(name), name);
			assert.ok(refusals.length >= 1, "the first batch was refused");
		} finally {
			await harness.dispose();
			if (saved === undefined) delete process.env.PI_SUBAGENT_SPAWN_WIDTH;
			else process.env.PI_SUBAGENT_SPAWN_WIDTH = saved;
			resetSubagentStateForTest();
		}
	});
});

// Review of 4f7000d (P1): a parent whose launches wait (pi -p, a background coordinator child) has no
// later turn and gets no result message. A model that follows the refusal literally: it ends its turn
// when told to, else it launches what fits now and retries the rest after that launch returns.
describe("D9: a parent whose launches wait follows a spawn-width refusal literally", () => {
	it("launches the whole refused batch within one turn of a parent without a UI", async () => {
		const saved = process.env.PI_SUBAGENT_SPAWN_WIDTH;
		process.env.PI_SUBAGENT_SPAWN_WIDTH = "1";
		resetSubagentStateForTest();
		const batch = [child("child-a"), child("child-b"), child("child-c")];
		let pending = batch;
		let launchedNow = 0;
		let call = 0;
		const launch = (children: ReturnType<typeof child>[]) =>
			fauxAssistantMessage([fauxToolCall("subagent", { children }, { id: `launch-${++call}` })], {
				stopReason: "toolUse",
			});
		const respond = (messages: { role: string; content: unknown }[]): AssistantMessage | undefined => {
			const last = messages.at(-1) as { role: string; content: unknown; isError?: boolean } | undefined;
			if (last?.role === "user" && textOf(last.content) === "go") return launch(pending);
			if (last?.role !== "toolResult") return undefined;
			const text = textOf(last.content);
			if (last.isError) {
				// The literal reading: "end this turn" ends it; else launch only the children that fit now.
				if (/end this turn/.test(text)) return fauxAssistantMessage("ended as told");
				const fit = /The first (\d+) child(?:ren)? \(\d+ slots?\) fits? now/.exec(text);
				if (
					!fit ||
					!/when (it|that call) returns, call subagent again with the children that have not started/.test(text)
				)
					return fauxAssistantMessage(`no step to follow: ${text}`);
				launchedNow = Number(fit[1]);
				return launch(pending.slice(0, launchedNow));
			}
			// The waited launch returned: those children ended and freed their slots. Retry the rest.
			pending = pending.slice(launchedNow);
			launchedNow = pending.length;
			return pending.length > 0 ? launch(pending) : fauxAssistantMessage("all launched");
		};
		const harness = await startParent({}, { headless: true, respond });
		// Each launched child ends on its own while its launch waits.
		let stop = false;
		const ender = (async () => {
			const done = new Set<string>();
			while (!stop) {
				for (const name of harness.runs.keys())
					if (harness.launched(name) && !done.has(name)) {
						done.add(name);
						harness.finishWithCall(name, `${name} DONE`);
					}
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		})();
		try {
			await harness.session.prompt("go");
			await harness.session.waitForIdle();
			for (const { name } of batch) assert.ok(harness.launched(name), `${name} launched`);
			const replies = harness.toolResults("subagent");
			assert.ok(
				replies.some((reply) => reply.isError),
				"the first batch was refused",
			);
			const last = harness.session.messages.at(-1) as { role: string; content: unknown };
			assert.equal(textOf(last.content), "all launched");
		} finally {
			stop = true;
			await ender;
			await harness.dispose();
			if (saved === undefined) delete process.env.PI_SUBAGENT_SPAWN_WIDTH;
			else process.env.PI_SUBAGENT_SPAWN_WIDTH = saved;
			resetSubagentStateForTest();
		}
	});
});

describe("g9 P2: a launch error names no session path, also one with spaces", () => {
	const cases = [
		["quoted", "EACCES: permission denied, open '/tmp/My Sessions/child three.jsonl'"],
		["unquoted", "EACCES: permission denied, mkdir /tmp/My Sessions/child three.jsonl"],
	] as const;
	for (const [kind, failError] of cases) {
		it(`scrubs the whole ${kind} path and keeps the reason`, async () => {
			const harness = await startParent(
				{ go: [fauxToolCall("subagent", BATCH_OF_THREE, { id: "launch-1" })] },
				{ failError },
			);
			try {
				await harness.session.prompt("go");
				await harness.session.waitForIdle();
				const [reply] = harness.toolResults("subagent");
				const failed = (reply?.details as { failed?: { error: string } } | undefined)?.failed;
				for (const text of [reply?.text ?? "", failed?.error ?? ""]) {
					for (const part of ["/tmp", "Sessions", "three.jsonl"]) {
						assert.equal(text.includes(part), false, `no "${part}" in: ${text}`);
					}
				}
				assert.match(failed?.error ?? "", /^EACCES: permission denied, (open|mkdir) /);
			} finally {
				await harness.dispose();
			}
		});
	}
});
