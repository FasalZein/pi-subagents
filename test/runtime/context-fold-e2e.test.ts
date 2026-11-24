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
import { getSessionResultsDir } from "../../src/artifact-storage.ts";
import { registerContextFold } from "../../src/runtime/context-fold.ts";
import { registerDeliveryQueue } from "../../src/runtime/delivery-queue.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { publishedResultFields, publishRunResult, type WatchedEnd } from "../../src/runtime/run-result.ts";
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
import { sessionHeader, toolCall, toolResult, user } from "../support/result-fixtures.ts";

// The settle fold at the extension boundary: a real Pi parent session with a faux provider launches
// one async child through the real launch tool; the child is a fake that publishes its record and
// report as its watcher does. Delivery and the fold are production code. Each provider request is
// recorded as the model got it (message content and tool-call arguments; details stay local).

type ToolCall = ReturnType<typeof fauxToolCall>;

const BRIEF = "BRIEF-TEXT-OF-CHILD-ONE";
const REPORT = "CHILD-ONE-FULL-REPORT";
const FOLD_ENTRY = "subagent_context_fold";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block as { text?: string }).text ?? "").join("");
}

interface Parent {
	session: AgentSession;
	requests: string[];
	/** Ends the child as its watcher does after subagent_done: a published record and report file. */
	finish(report: string): void;
	runId(): string;
	foldEntries(): number;
	dispose(): Promise<void>;
}

async function startParent(
	plan: Record<string, ToolCall[]>,
	options: { api?: string; resumeFile?: string; root?: string; codemode?: boolean; blocking?: boolean } = {},
): Promise<Parent> {
	const root = options.root ?? createTestDir();
	const agentDir = join(root, "agent");
	const faux = fauxProvider({ api: options.api ?? "anthropic-messages" });
	const requests: string[] = [];
	const step = (context: { messages: { role: string; content: unknown }[] }): AssistantMessage => {
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
	// The session's own results folder, written through a store that subagent_wait does not use:
	// a lookup must read the files, as a fresh process does.
	let store: ResultStore | undefined;
	const sessionStore = () => {
		store ??= new ResultStore(getSessionResultsDir(root, session.sessionManager.getSessionId()), () => {});
		return store;
	};
	let finish: ((result: SubagentResult) => void) | undefined;
	let child: RunningSubagent | undefined;
	const runtime: SubagentToolRuntime = {
		loadAgentDefaults: () => ({ spawning: true, async: true, mode: "background" }) as never,
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		launchBackgroundSubagent: async (params) => {
			// As in production, the run id is the reserved result id (D16).
			const reservation = sessionStore().reserve();
			const running = {
				id: reservation.runId,
				name: params.name,
				task: params.task,
				agent: "worker-a",
				mode: "background",
				phase: { kind: "running" },
				parentClosePolicy: "terminate",
				// A blocking child makes the launch call wait for its report (a synchronous launch).
				blocking: options.blocking ?? false,
				async: !options.blocking,
				startTime: Date.now(),
				sessionFile: join(root, `${params.name}.jsonl`),
				resultTarget: { store: sessionStore(), reservation, parentCwd: root, warnings: [] },
			} as RunningSubagent;
			setRunningSubagentForTest(running as never);
			child = running;
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
		sessionManager: options.resumeFile
			? SessionManager.open(options.resumeFile)
			: SessionManager.create(root, join(root, "sessions")),
	});
	// An interactive parent: a headless one awaits every launch. Pi spreads the UI context, so a
	// method the parent calls (notify) must be an own key.
	const ui = new Proxy({ notify() {} }, { get: () => () => undefined });
	await session.bindExtensions({ uiContext: ui as never });
	return {
		session,
		requests,
		finish: (report) => {
			if (!child) assert.fail("no child");
			const args = { outcome: "done", summary: report };
			const entries = [
				sessionHeader(),
				user("task"),
				toolCall("subagent_done", args, "done-1"),
				toolResult("subagent_done", "done-1", "Result recorded."),
			];
			writeFileSync(child.sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
			const end: WatchedEnd = {
				exitCode: 0,
				operatorClosed: false,
				closedByPerson: false,
				stopped: false,
				exitSignal: { reason: "done", exitCode: 0, acceptedCall: { toolCallId: "done-1", args } },
				contextUsage: {},
			};
			const published = publishRunResult(child, end);
			if (!published) assert.fail("the run published no record");
			finish?.({
				name: "child-one",
				task: "t",
				summary: published.summary,
				summarySource: published.summarySource,
				sessionFile: child.sessionFile,
				exitCode: 0,
				elapsed: 1,
				...publishedResultFields(published),
			});
		},
		runId: () => child?.id ?? assert.fail("no child"),
		foldEntries: () =>
			session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === FOLD_ENTRY)
				.length,
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
	// The live finding (cpa/gpt-6.2-sol): a model that fills every optional field sends the top-level
	// form with an empty children list; the launch normalizer treats it as the single form.
	delegate: [
		fauxToolCall(
			"subagent",
			{ name: "child-one", task: BRIEF, title: "One", agent: "worker-a", children: [] },
			{ id: "launch-1" },
		),
	],
};
const lookupPlan = (runId: string) => ({
	...PLAN,
	lookup: [fauxToolCall("subagent_wait", { runIds: [runId] }, { id: "wait-1" })],
});

/** Launch, let the idle parent take the result in a new turn, and settle. */
async function useOneRun(parent: Parent): Promise<void> {
	await parent.session.prompt("delegate");
	await parent.session.waitForIdle();
	assert.equal(parent.foldEntries(), 0, "a running run does not fold");
	const before = parent.requests.length;
	parent.finish(REPORT);
	await until(() => parent.requests.length > before, "the result turn");
	await parent.session.waitForIdle();
	const resultRequest = parent.requests.at(-1) ?? "";
	assert.match(resultRequest, new RegExp(BRIEF), "before the settle the request holds the brief");
	assert.match(resultRequest, new RegExp(REPORT), "before the settle the request holds the result");
}

describe("context fold in a real Pi session", () => {
	it("folds brief and result after the settle; a reloaded session keeps the stubs and the lookup reads the file", async () => {
		const parent = await startParent(PLAN);
		let file = "";
		let root = "";
		let runId = "";
		try {
			await useOneRun(parent);
			await until(() => parent.foldEntries() === 1, "the fold entry of the settle");
			await parent.session.prompt("next");
			await parent.session.waitForIdle();
			const after = parent.requests.at(-1) ?? "";
			assert.doesNotMatch(after, new RegExp(BRIEF), "after the settle the brief is a stub");
			assert.doesNotMatch(after, new RegExp(REPORT), "after the settle the result is a stub");
			runId = parent.runId();
			assert.match(after, new RegExp(`Folded subagent run ${runId} \\(child-one\\): done, report /[^ ]+\\.md\\.`));
			assert.match(after, new RegExp(`subagent_wait\\(\\{ runIds: \\[\\\\"${runId}\\\\"\\] \\}\\)`));
			file = parent.session.sessionManager.getSessionFile() ?? assert.fail("no session file");
			root = parent.session.sessionManager.getCwd();
			const stored = JSON.stringify(SessionManager.open(file).getEntries());
			assert.match(stored, new RegExp(BRIEF), "the session file keeps the brief");
			assert.match(stored, new RegExp(REPORT), "the session file keeps the result");
		} finally {
			await parent.dispose();
		}
		// A freshly bound session on the same file: no runtime state, a new result store.
		const reloaded = await startParent(lookupPlan(runId), { resumeFile: file, root });
		try {
			await reloaded.session.prompt("again");
			await reloaded.session.waitForIdle();
			const request = reloaded.requests.at(-1) ?? "";
			assert.doesNotMatch(request, new RegExp(BRIEF));
			assert.doesNotMatch(request, new RegExp(REPORT));
			assert.match(request, new RegExp(`Folded subagent run ${runId}`));
			await reloaded.session.prompt("lookup");
			await reloaded.session.waitForIdle();
			const reply = reloaded.session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "subagent_wait",
			);
			assert.match(
				textOf((reply as { content?: unknown } | undefined)?.content),
				new RegExp(REPORT),
				"the lookup returns the stored result",
			);
			assert.match(reloaded.requests.at(-1) ?? "", new RegExp(REPORT), "in its own turn the lookup reply is full");
			// D3: the settle after the turn that saw the lookup refolds the run, so the reply folds too.
			await until(() => reloaded.foldEntries() === 2, "the refold entry of the settle");
			await reloaded.session.prompt("next");
			await reloaded.session.waitForIdle();
			const after = reloaded.requests.at(-1) ?? "";
			assert.doesNotMatch(after, new RegExp(REPORT), "after the next settle the lookup reply is a stub");
			assert.equal(after.split(`Folded subagent run ${runId}`).length - 1, 3, "brief, result and lookup are stubs");
			assert.equal(reloaded.foldEntries(), 2, "a settle with no newly used reply appends no entry");
		} finally {
			await reloaded.dispose();
		}
	});

	it("folds a real launch-only codemode script as a whole after the settle", async () => {
		const code = `const r = await tools.subagent({ name: "child-one", task: "${BRIEF}", title: "One", agent: "worker-a" });\nreturn r.children[0].runId;`;
		const parent = await startParent(
			{ ...PLAN, delegate: [fauxToolCall("codemode", { code }, { id: "script-1" })] },
			{ codemode: true },
		);
		try {
			await useOneRun(parent);
			await until(() => parent.foldEntries() === 1, "the fold entry");
			await parent.session.prompt("next");
			await parent.session.waitForIdle();
			const after = parent.requests.at(-1) ?? "";
			assert.doesNotMatch(after, new RegExp(BRIEF), "the script's brief is gone");
			assert.doesNotMatch(after, new RegExp(REPORT));
			assert.match(after, new RegExp(`Folded launch script of runs ${parent.runId()}\\.`));
		} finally {
			await parent.dispose();
		}
	});

	it("folds a used subagent_wait join reply to its stub after the settle (fold-waits S2)", async () => {
		const plan: Record<string, ToolCall[]> = { ...PLAN };
		const parent = await startParent(plan);
		try {
			await parent.session.prompt("delegate");
			await parent.session.waitForIdle();
			plan.join = [fauxToolCall("subagent_wait", { runIds: [parent.runId()] }, { id: "wait-1" })];
			const joined = parent.session.prompt("join");
			await until(
				() =>
					parent.session.messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("wait-1")),
				"the wait call",
			);
			parent.finish(REPORT);
			await joined;
			await parent.session.waitForIdle();
			const reply = parent.session.messages.find((m) => m.role === "toolResult" && m.toolName === "subagent_wait");
			assert.match(textOf((reply as { content?: unknown } | undefined)?.content), new RegExp(REPORT));
			assert.match(parent.requests.at(-1) ?? "", new RegExp(REPORT), "before the settle the reply is full");
			await until(() => parent.foldEntries() === 1, "the fold entry of the settle");
			await parent.session.prompt("next");
			await parent.session.waitForIdle();
			const after = parent.requests.at(-1) ?? "";
			assert.doesNotMatch(after, new RegExp(REPORT), "after the settle the wait reply is a stub");
			assert.doesNotMatch(after, new RegExp(BRIEF));
			assert.match(after, new RegExp(`Folded subagent run ${parent.runId()} \\(child-one\\): done`));
		} finally {
			await parent.dispose();
		}
	});

	it("folds a used waited launch reply to its head lines and stub after the settle (fold-waits S3)", async () => {
		const parent = await startParent(PLAN, { blocking: true });
		try {
			const delegated = parent.session.prompt("delegate");
			await until(
				() =>
					parent.session.messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("launch-1")),
				"the launch call",
			);
			parent.finish(REPORT);
			await delegated;
			await parent.session.waitForIdle();
			const reply = parent.session.messages.find((m) => m.role === "toolResult" && m.toolName === "subagent");
			assert.match(
				textOf((reply as { content?: unknown } | undefined)?.content),
				new RegExp(REPORT),
				"the call waited",
			);
			assert.match(parent.requests.at(-1) ?? "", new RegExp(REPORT), "before the settle the reply is full");
			await until(() => parent.foldEntries() === 1, "the fold entry of the settle");
			await parent.session.prompt("next");
			await parent.session.waitForIdle();
			const after = parent.requests.at(-1) ?? "";
			assert.doesNotMatch(after, new RegExp(REPORT), "after the settle the launch reply is a stub");
			assert.doesNotMatch(after, new RegExp(BRIEF));
			assert.match(
				after,
				new RegExp(`- child-one \\(agent worker-a\\): run ${parent.runId()}`),
				"the child line stays",
			);
			assert.match(after, /This call waited for its children; each report follows below\./, "the return line stays");
			assert.match(after, new RegExp(`Folded subagent run ${parent.runId()} \\(child-one\\): done`));
		} finally {
			await parent.dispose();
		}
	});

	it("does not fold for a provider API that binds earlier messages (Bedrock Converse)", async () => {
		const parent = await startParent(PLAN, { api: "bedrock-converse-stream" });
		try {
			await useOneRun(parent);
			await parent.session.prompt("next");
			await parent.session.waitForIdle();
			const after = parent.requests.at(-1) ?? "";
			assert.match(after, new RegExp(BRIEF));
			assert.match(after, new RegExp(REPORT));
		} finally {
			await parent.dispose();
		}
	});

	it("does not fold in a child session (PI_SUBAGENT_SESSION set)", async () => {
		const saved = process.env.PI_SUBAGENT_SESSION;
		process.env.PI_SUBAGENT_SESSION = "/tmp/child-session.jsonl";
		const parent = await startParent(PLAN);
		try {
			await useOneRun(parent);
			await parent.session.prompt("next");
			await parent.session.waitForIdle();
			assert.equal(parent.foldEntries(), 0);
			assert.match(parent.requests.at(-1) ?? "", new RegExp(BRIEF));
		} finally {
			if (saved === undefined) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = saved;
			await parent.dispose();
		}
	});
});
