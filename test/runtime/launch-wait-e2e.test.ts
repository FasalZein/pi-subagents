import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { pendingRunEndCount, registerDeliveryQueue } from "../../src/runtime/delivery-queue.ts";
import { wireSubagentSteerBack } from "../../src/runtime/running-registry.ts";
import { runningSubagents } from "../../src/runtime/state.ts";
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
import { stopRequesterOf } from "../../src/runtime/run-phase.ts";

// T23 at the extension boundary: a real Pi parent session with a faux provider calls the real
// public launch tool with two waiting (async: false) children. The children are fakes; routing,
// the waits and the delivery queue are production code, so the next model request shows what the
// parent received.

/** The D15 cap on every copy of a result that enters the parent. */
const COPY_CAP = 1_900;
const REPORT_HEAD = "CHILD-ONE-REPORT-HEAD";
const REPORT_TAIL = "CHILD-ONE-REPORT-TAIL";
/** A 20,000-character report whose tail must never enter the parent. */
const LONG_REPORT = `${REPORT_HEAD} ${"x".repeat(20_000 - REPORT_HEAD.length - REPORT_TAIL.length - 2)} ${REPORT_TAIL}`;

interface Children {
	/** Ends a child with a report; the child's watch resolves. */
	finish(name: string, summary: string): void;
	/** Lets the launch of child-two return. */
	releaseSecondLaunch(): void;
	launched(name: string): boolean;
}

function launchRuntime(children: {
	gate: Promise<void>;
	finish: Map<string, (result: SubagentResult) => void>;
	names: Set<string>;
	explicitSync: boolean;
}): SubagentToolRuntime {
	return {
		loadAgentDefaults: () => ({ spawning: true, async: false, mode: "background" }) as never,
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		launchBackgroundSubagent: async (params) => {
			if (params.name === "child-two") await children.gate;
			const running = {
				id: `id-${params.name}`,
				name: params.name,
				task: params.task,
				agent: "worker-a",
				mode: "background",
				phase: { kind: "running" },
				parentClosePolicy: "terminate",
				blocking: true,
				// D04a: an explicitly synchronous run (async: false) ignores Esc; a run that waits by the
				// batch rule (async: true, blocking) is stopped by it, as in v2.9.2 (cf6dbf4).
				async: !children.explicitSync,
				startTime: Date.now(),
				sessionFile: `/tmp/${params.name}.jsonl`,
			} as RunningSubagent;
			setRunningSubagentForTest(running as never);
			children.names.add(params.name);
			return running;
		},
		launchSubagent: async () => {
			throw new Error("no pane");
		},
		watchBackgroundSubagent: (running) =>
			new Promise<SubagentResult>((resolve) => {
				children.finish.set(running.name, resolve);
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
	requests: string[];
	children: Children;
	dispose(): Promise<void>;
}

async function startParent(
	replies: (requests: string[]) => FauxResponseStep[],
	explicitSync = true,
): Promise<Parent> {
	const root = createTestDir();
	const agentDir = join(root, "agent");
	const faux = fauxProvider();
	const requests: string[] = [];
	faux.setResponses(replies(requests));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"),
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	let releaseSecondLaunch!: () => void;
	const state = {
		gate: new Promise<void>((resolve) => {
			releaseSecondLaunch = resolve;
		}),
		finish: new Map<string, (result: SubagentResult) => void>(),
		names: new Set<string>(),
		explicitSync,
	};
	const extension: ExtensionFactory = (pi) => {
		registerDeliveryQueue(pi);
		registerSubagentCoreTools(pi, () => true, launchRuntime(state));
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		extensionFactories: [extension],
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
		settingsManager: SettingsManager.inMemory({}),
		sessionManager: SessionManager.create(root, join(root, "sessions")),
	});
	await session.bindExtensions({});
	return {
		session,
		requests,
		children: {
			finish: (name, summary) =>
				state.finish.get(name)?.({
					name,
					task: "t",
					summary,
					summarySource: "subagent",
					sessionFile: `/tmp/${name}.jsonl`,
					exitCode: 0,
					elapsed: 1,
				}),
			releaseSecondLaunch,
			launched: (name) => state.finish.has(name),
		},
		async dispose() {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			resetSubagentStateForTest();
		},
	};
}

const launchBoth = fauxAssistantMessage(
	[
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
	],
	{ stopReason: "toolUse" },
);

function recording(requests: string[], text: string): FauxResponseStep {
	return (context) => {
		// What the model reads: the content of every message, not tool details or the system prompt.
		requests.push(JSON.stringify(context.messages.map((message) => message.content)));
		return fauxAssistantMessage(text);
	};
}

async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!condition()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Every rendered copy of child 1's result in a request (JSON-escaped text). */
function childOneCopies(request: string): string[] {
	return request.split(REPORT_HEAD).slice(1);
}

function assertCapped(request: string): void {
	assert.ok(!request.includes(REPORT_TAIL), "the 20,000-character report never enters the parent");
	for (const copy of childOneCopies(request)) {
		// Each copy ends before the next JSON string ends; its text is the capped rendering.
		const text = copy.split('"}')[0] ?? "";
		assert.ok(text.length <= COPY_CAP, `copy of child 1 is ${text.length} chars`);
	}
}

describe("T23: a launch that waits takes its results through the queue (real Pi session)", () => {
	it("replay 1: child 1 ends while child 2 launches; the next request holds child 1 exactly once, capped", async () => {
		const parent = await startParent((requests) => [launchBoth, recording(requests, "Read both.")]);
		try {
			const run = parent.session.prompt("delegate");
			await until(() => parent.children.launched("child-one"), "child 1 launched");
			parent.children.finish("child-one", LONG_REPORT);
			await new Promise((resolve) => setTimeout(resolve, 20));
			parent.children.releaseSecondLaunch();
			await until(() => parent.children.launched("child-two"), "child 2 launched");
			parent.children.finish("child-two", "CHILD-TWO-REPORT");
			await run;
			await parent.session.waitForIdle();
			assert.equal(parent.requests.length, 1, "no extra turn carries child 1 again");
			const request = parent.requests[0]!;
			assert.equal(childOneCopies(request).length, 1, "child 1 enters the next request exactly once");
			assert.match(request, /CHILD-TWO-REPORT/);
			assertCapped(request);
			assert.equal(pendingRunEndCount(), 0);
		} finally {
			await parent.dispose();
		}
	});

	it("R4 and D04a: Esc while child 2 is still waited for stops child 2; child 1's result reaches the first request", async () => {
		const parent = await startParent((requests) => [launchBoth, recording(requests, "Read child 1.")], false);
		try {
			const run = parent.session.prompt("delegate");
			await until(() => parent.children.launched("child-one"), "child 1 launched");
			parent.children.finish("child-one", LONG_REPORT);
			await new Promise((resolve) => setTimeout(resolve, 20));
			parent.children.releaseSecondLaunch();
			await until(() => parent.children.launched("child-two"), "child 2 launched");
			await new Promise((resolve) => setTimeout(resolve, 20));
			await parent.session.abort();
			await run;
			// D04a: as v2.9.2 (cf6dbf4), the launch wait that observed Esc stops the child it waited for.
			assert.equal(
				stopRequesterOf(runningSubagents.get("id-child-two") ?? assert.fail("child 2 is missing")),
				"operator",
				"child 2 was stopped",
			);
			// The queue hands child 1 over as its own message, so it does not depend on the aborted
			// reply: a codemode bridge discards that reply after an abort.
			const messages = parent.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "subagent_result",
			);
			assert.equal(messages.length, 1, "child 1's result is handed over as a message");
			// Esc while the turn settles: the message committed in the aborted turn enters the next request.
			if (parent.requests.length === 0) await parent.session.prompt("continue");
			const request = parent.requests[0]!;
			assert.ok(childOneCopies(request).length >= 1, "the first request after the batch holds child 1");
			assertCapped(request);
		} finally {
			await parent.dispose();
		}
	});
});
