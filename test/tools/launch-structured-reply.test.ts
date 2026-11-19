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
import { registerDeliveryQueue } from "../../src/runtime/delivery-queue.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { publishedResultFields, publishRunResult, type WatchedEnd } from "../../src/runtime/run-result.ts";
import { wireSubagentSteerBack } from "../../src/runtime/running-registry.ts";
import { registerSubagentKillTool } from "../../src/tools/kill-tool.ts";
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
	stopped: string[];
	toolResults(name: string): { text: string; details: Record<string, unknown>; isError: boolean }[];
	dispose(): Promise<void>;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block as { text?: string }).text ?? "").join("");
}

async function startParent(
	plan: Record<string, ReturnType<typeof fauxToolCall>[]>,
	options: { codemode?: boolean; beforeFailure?: (harness: Harness) => Promise<void> } = {},
): Promise<Harness> {
	const root = createTestDir();
	const agentDir = join(root, "agent");
	const faux = fauxProvider();
	const step = (context: { messages: { role: string; content: unknown }[] }): AssistantMessage => {
		const last = context.messages.at(-1);
		const calls = last?.role === "user" ? plan[textOf(last.content)] : undefined;
		if (calls) return fauxAssistantMessage(calls, { stopReason: "toolUse" });
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
	const store = new ResultStore(join(root, "results"), () => {});
	const finish = new Map<string, (result: SubagentResult) => void>();
	const runs = new Map<string, RunningSubagent>();
	const stopped: string[] = [];
	let harness!: Harness;

	const finishWithCall = (name: string, summary: string) => {
		const running = runs.get(name);
		if (!running) assert.fail(`no child ${name}`);
		const args = { outcome: "done", summary };
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
	};

	const runtime: SubagentToolRuntime = {
		// worker-wait waits by its agent definition (async: false); worker-a reports later.
		loadAgentDefaults: (agent) => ({ spawning: true, async: agent !== "worker-wait", mode: "background" }) as never,
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		launchBackgroundSubagent: async (params) => {
			if (params.name === FAILING_CHILD) {
				await options.beforeFailure?.(harness);
				throw new Error("pane could not be created");
			}
			const reservation = store.reserve();
			const running = {
				id: reservation.runId,
				name: params.name,
				task: params.task,
				agent: params.agent,
				modelRef: CHILD_MODEL,
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				blocking: params.agent === "worker-wait",
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
		registerSubagentWaitTool(pi, () => true, { mayLaunch: () => true });
		// A stop ends the fake child as its watcher would: with its own record.
		registerSubagentKillTool(
			pi,
			() => true,
			async (running) => {
				stopped.push(running.id);
				finishWithCall(running.name, `STOPPED ${running.name}`);
			},
			{ mayLaunch: () => true },
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
		sessionManager: SessionManager.create(root, join(root, "sessions")),
	});
	// An interactive parent: a headless one awaits every launch.
	const ui = new Proxy({}, { get: () => () => undefined });
	await session.bindExtensions({ uiContext: ui as never });
	harness = {
		session,
		runs,
		launched: (name) => finish.has(name),
		finishWithCall,
		stopped,
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
			await until(() => harness.launched("child-wait"), "the waiting child runs");
			await new Promise((resolve) => setTimeout(resolve, 20));
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

	it("checks 2 to 4: a script gets the object, recovers on it alone with one sibling already ended, then waits for and stops the started children by id", async () => {
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
			"for (const c of running) stops.push(await tools.subagent_kill({ id: c.runId }));",
			"const waited = await tools.subagent_wait({ ids: r.children.map((c) => c.runId), timeout: 5 });",
			'return "JSON " + JSON.stringify({ launch: r, ended: ended.map((c) => c.record.summary), stops, waited });',
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
				waited: { status: string; results: { id: string; text: string }[]; pending: string[] };
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
			assert.equal(value.waited.status, "complete");
			assert.deepEqual(value.waited.pending, []);
			// The wait tool reads records from the session's results folder, not this harness's store,
			// so the check reads each returned rendering.
			const waitedText = new Map(value.waited.results.map((result) => [result.id, result.text]));
			assert.deepEqual([...waitedText.keys()].sort(), [one, two].sort());
			assert.match(waitedText.get(one) ?? "", /ONE-DONE-EARLY/);
			assert.match(waitedText.get(two) ?? "", /STOPPED child-two/);
			assert.equal(harness.launched(FAILING_CHILD), false, "the failed child never ran");
		} finally {
			await harness.dispose();
		}
	});
});
