import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	CONTEXT_FOLD_ENTRY,
	foldMessages,
	readFoldedRuns,
	registerContextFold,
} from "../../src/runtime/context-fold.ts";
import { registerDeliveryQueue } from "../../src/runtime/delivery-queue.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { wireSubagentSteerBack } from "../../src/runtime/running-registry.ts";
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

// The settle fold at the extension boundary: a real Pi parent session with a faux provider launches
// one async child through the real launch tool; the child is a fake, delivery and the fold are
// production code. Each provider request is recorded as the model got it.

type ToolCall = ReturnType<typeof fauxToolCall>;

const BRIEF = "BRIEF-TEXT-OF-CHILD-ONE";
const REPORT = "CHILD-ONE-FULL-REPORT";
const RUN = "id-child-one";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block as { text?: string }).text ?? "").join("");
}

interface Parent {
	session: AgentSession;
	requests: string[];
	finish(summary: string): void;
	dispose(): Promise<void>;
}

async function startParent(plan: Record<string, ToolCall[]>): Promise<Parent> {
	const root = createTestDir();
	const agentDir = join(root, "agent");
	const faux = fauxProvider();
	const requests: string[] = [];
	const step = (context: { messages: { role: string; content: unknown }[] }): AssistantMessage => {
		// The model-visible part: providers send content and tool-call arguments, not details.
		requests.push(JSON.stringify(context.messages.map((message) => message.content)));
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
	let finish: ((result: SubagentResult) => void) | undefined;
	const runtime: SubagentToolRuntime = {
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
				phase: "running",
				parentClosePolicy: "terminate",
				blocking: false,
				async: true,
				startTime: Date.now(),
				sessionFile: join(root, `${params.name}.jsonl`),
				resultTarget: { store, reservation: store.reserve(), parentCwd: root, warnings: [] },
			} as RunningSubagent;
			setRunningSubagentForTest(running as never);
			return running;
		},
		launchSubagent: async () => {
			throw new Error("no pane");
		},
		watchBackgroundSubagent: () =>
			new Promise<SubagentResult>((resolve) => {
				finish = resolve;
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
		registerContextFold(pi);
		registerSubagentCoreTools(pi, () => true, runtime);
		registerSubagentWaitTool(pi, () => true, { mayLaunch: () => true });
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
	// An interactive parent: a headless one awaits every launch. Pi spreads the UI context, so a
	// method the parent calls (notify) must be an own key.
	const ui = new Proxy({ notify() {} }, { get: () => () => undefined });
	await session.bindExtensions({ uiContext: ui as never });
	return {
		session,
		requests,
		finish: (summary) =>
			finish?.({
				name: "child-one",
				task: "t",
				summary,
				summarySource: "subagent",
				sessionFile: "/tmp/c.jsonl",
				exitCode: 0,
				elapsed: 1,
			}),
		async dispose() {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			resetSubagentStateForTest();
		},
	};
}

async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!condition()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const PLAN = {
	delegate: [
		fauxToolCall(
			"subagent",
			{ children: [{ name: "child-one", task: BRIEF, title: "One", agent: "worker-a" }] },
			{ id: "launch-1" },
		),
	],
	lookup: [fauxToolCall("subagent_wait", { runIds: [RUN] }, { id: "wait-1" })],
};

const foldEntries = (parent: Parent) =>
	parent.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === CONTEXT_FOLD_ENTRY);

describe("context fold in a real Pi session", () => {
	it("sends the full brief and result before the settle, stubs after it; subagent_wait still returns the result", async () => {
		const parent = await startParent(PLAN);
		try {
			await parent.session.prompt("delegate");
			await parent.session.waitForIdle();
			assert.equal(foldEntries(parent).length, 0, "a running run does not fold");
			const before = parent.requests.length;
			parent.finish(REPORT);
			// The idle parent gets the result at once with a new turn.
			await until(() => parent.requests.length > before, "the result turn");
			await parent.session.waitForIdle();
			const resultRequest = parent.requests.at(-1)!;
			assert.match(resultRequest, new RegExp(BRIEF), "before the settle the request holds the brief");
			assert.match(resultRequest, new RegExp(REPORT), "before the settle the request holds the result");
			await until(() => foldEntries(parent).length === 1, "the fold entry of the settle");

			await parent.session.prompt("next");
			await parent.session.waitForIdle();
			const after = parent.requests.at(-1)!;
			assert.doesNotMatch(after, new RegExp(BRIEF), "after the settle the brief is a stub");
			assert.doesNotMatch(after, new RegExp(REPORT), "after the settle the result is a stub");
			assert.match(after, /Folded subagent run id-child-one \(child-one\)/);
			assert.match(after, /subagent_wait\(\{ runIds: \[\\"id-child-one\\"\] \}\)/);
			// The session file keeps the full text.
			const file = parent.session.sessionManager.getSessionFile()!;
			const stored = JSON.stringify(SessionManager.open(file).getEntries());
			assert.match(stored, new RegExp(BRIEF));
			assert.match(stored, new RegExp(REPORT));

			await parent.session.prompt("lookup");
			await parent.session.waitForIdle();
			const reply = parent.session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "subagent_wait",
			);
			assert.match(
				textOf((reply as { content?: unknown } | undefined)?.content),
				new RegExp(REPORT),
				"the lookup returns the stored result",
			);
			assert.equal(foldEntries(parent).length, 1, "a settle with no newly used run appends no entry");
		} finally {
			await parent.dispose();
		}
	});

	it("keeps the fold set and the same provider messages in a reloaded session", async () => {
		const parent = await startParent(PLAN);
		try {
			await parent.session.prompt("delegate");
			await parent.session.waitForIdle();
			const before = parent.requests.length;
			parent.finish(REPORT);
			await until(() => parent.requests.length > before, "the result turn");
			await parent.session.waitForIdle();
			await until(() => foldEntries(parent).length === 1, "the fold entry");
			const live = parent.session.sessionManager;
			const reloaded = SessionManager.open(live.getSessionFile()!);
			const liveSet = readFoldedRuns(live.getBranch());
			assert.deepEqual([...readFoldedRuns(reloaded.getBranch()).entries()], [...liveSet.entries()]);
			assert.deepEqual([...liveSet.keys()], [RUN]);
			const messages = parent.session.messages;
			assert.notEqual(foldMessages(messages, liveSet), messages, "the folded run changes the messages");
			assert.deepEqual(foldMessages(messages, readFoldedRuns(reloaded.getBranch())), foldMessages(messages, liveSet));
		} finally {
			await parent.dispose();
		}
	});

	it("does not fold in a child session (PI_SUBAGENT_SESSION set)", async () => {
		const saved = process.env.PI_SUBAGENT_SESSION;
		process.env.PI_SUBAGENT_SESSION = "/tmp/child-session.jsonl";
		const parent = await startParent(PLAN);
		try {
			await parent.session.prompt("delegate");
			await parent.session.waitForIdle();
			const before = parent.requests.length;
			parent.finish(REPORT);
			await until(() => parent.requests.length > before, "the result turn");
			await parent.session.waitForIdle();
			await parent.session.prompt("next");
			await parent.session.waitForIdle();
			assert.equal(foldEntries(parent).length, 0);
			assert.match(parent.requests.at(-1)!, new RegExp(BRIEF));
		} finally {
			if (saved === undefined) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = saved;
			await parent.dispose();
		}
	});
});
