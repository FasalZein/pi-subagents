import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { pendingRunEndCount, registerDeliveryQueue } from "../../src/runtime/delivery-queue.ts";
import { sessionResultStore, setResultStorageNotice } from "../../src/runtime/result-files.ts";
import { publishedResultFields, publishRunResult, type WatchedEnd } from "../../src/runtime/run-result.ts";
import { wireSubagentSteerBack } from "../../src/runtime/running-registry.ts";
import { registerSubagentCoreTools, type SubagentToolRuntime } from "../../src/tools/subagent-tools.ts";
import { registerSubagentWaitTool, type SubagentWaitStructured } from "../../src/tools/wait-tool.ts";
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

// T25 at the extension boundary: a real Pi parent with a faux provider runs a codemode script that
// launches children, waits for them and throws. The parent then recovers with subagent_wait's
// recent list and a lookup by run id (D15, D16). Children are fakes that end the way a watcher does
// after subagent_done (a published record in the parent session's results folder); routing, waits,
// the delivery queue, the result store and the storage notice are production code.

type ToolCall = ReturnType<typeof fauxToolCall>;

/** A child ends this long after its launch, so each wait meets a run that is still running or queued. */
const CHILD_RUN_MS = 15;

interface Parent {
	session: AgentSession;
	/** Each prompt text maps to the tool calls of one reply; a test may add entries before it prompts. */
	plan: Record<string, ToolCall[]>;
	runIds: string[];
	notices: string[];
	resultsDir: string;
	toolResults(name: string): { text: string; details: Record<string, unknown>; isError: boolean }[];
	resultMessages(): number;
	dispose(): Promise<void>;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block as { text?: string }).text ?? "").join("");
}

function endChild(running: RunningSubagent, summary: string): SubagentResult {
	const args = { outcome: "done", summary };
	const entries = [
		sessionHeader(),
		user("task"),
		toolCall("subagent_done", args, "d1"),
		toolResult("subagent_done", "d1", "ok"),
	];
	writeFileSync(running.sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	const end: WatchedEnd = {
		exitCode: 0,
		operatorClosed: false, closedByPerson: false,
		stopped: false,
		exitSignal: { reason: "done", exitCode: 0, acceptedCall: { toolCallId: "d1", args } },
		contextUsage: {},
	};
	const published = publishRunResult(running, end);
	return {
		name: running.name,
		task: "t",
		summary,
		summarySource: "subagent",
		sessionFile: running.sessionFile,
		exitCode: 0,
		elapsed: 1,
		...publishedResultFields(published),
	};
}

async function startParent(options: { unwritableResults?: boolean } = {}): Promise<Parent> {
	const root = createTestDir();
	const agentDir = join(root, "agent");
	const sessionManager = SessionManager.create(root, join(root, "sessions"));
	const resultsDir = getSessionResultsDir(root, sessionManager.getSessionId());
	if (options.unwritableResults) {
		mkdirSync(dirname(resultsDir), { recursive: true });
		writeFileSync(resultsDir, "a file where the results folder belongs");
	}
	const plan: Record<string, ToolCall[]> = {};
	const faux = fauxProvider();
	const step = (context: { messages: { role: string; content: unknown }[] }): AssistantMessage => {
		const last = context.messages.at(-1);
		const calls = last?.role === "user" ? plan[textOf(last.content)] : undefined;
		return calls ? fauxAssistantMessage(calls, { stopReason: "toolUse" }) : fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 20 }, () => step as never));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"),
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const runIds: string[] = [];
	const runtime: SubagentToolRuntime = {
		loadAgentDefaults: () => ({ spawning: true, async: true, mode: "background" }) as never,
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		launchBackgroundSubagent: async (params) => {
			// As the launch paths do: the run id is reserved in this parent session's results folder.
			const store = sessionResultStore(resultsDir);
			const reservation = store.reserve();
			const running = {
				id: reservation.runId,
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
				resultTarget: { store, reservation, parentCwd: root, warnings: [] },
			} as RunningSubagent;
			setRunningSubagentForTest(running as never);
			runIds.push(running.id);
			return running;
		},
		launchSubagent: async () => {
			throw new Error("no pane");
		},
		watchBackgroundSubagent: (running) =>
			new Promise<SubagentResult>((resolve) => {
				setTimeout(() => resolve(endChild(running, `REPORT OF ${running.name}`)), CHILD_RUN_MS);
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
		// The production wiring of the storage notice (src/subagents.ts, session_start).
		pi.on("session_start", (_event, ctx) => setResultStorageNotice((message) => ctx.ui.notify(message, "warning")));
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		extensionFactories: [extension, createCodemodeExtension({ mode: "on" })],
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
		settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode"] }),
		sessionManager,
	});
	const notices: string[] = [];
	// An interactive parent whose notices the test records: the person sees them outside any script.
	const ui = new Proxy(
		{ notify: (message: string) => notices.push(message) },
		{ get: (target, key) => (key === "notify" ? target.notify : () => undefined) },
	);
	await session.bindExtensions({ uiContext: ui as never });
	return {
		session,
		plan,
		runIds,
		notices,
		resultsDir,
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
		resultMessages: () =>
			session.messages.filter((message) => message.role === "custom" && message.customType === "subagent_result")
				.length,
		async dispose() {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			setResultStorageNotice(() => {});
			resetSubagentStateForTest();
		},
	};
}

/** A workflow script: launches `count` children one after another, waits for each, then throws. */
function sequentialScript(count: number): string {
	return [
		`for (let i = 0; i < ${count}; i++) {`,
		"  const launched = await tools.subagent({ children: [{ name: `seq-${i}`, task: 't', title: 'Seq', agent: 'worker-a' }] });",
		"  await tools.subagent_wait({ runIds: [launched.children[0].runId] });",
		"}",
		"throw new Error('workflow failed after its waits');",
	].join("\n");
}

async function prompt(parent: Parent, text: string, calls: ToolCall[]): Promise<void> {
	parent.plan[text] = calls;
	await parent.session.prompt(text);
	await parent.session.waitForIdle();
}

describe("T25: recovery by recent and lookup after a failed workflow script", () => {
	it("check 3: 21 sequential completions, then a throw: recent shows the newest 20, the first is found by its run id", async () => {
		const parent = await startParent();
		try {
			await prompt(parent, "work", [fauxToolCall("codemode", { code: sequentialScript(21) }, { id: "s1" })]);
			const [script] = parent.toolResults("codemode");
			assert.ok(script?.isError, "the script failed");
			assert.match(script.text, /workflow failed after its waits/);
			assert.equal(parent.runIds.length, 21);
			assert.equal(parent.resultMessages(), 0, "every result went to its wait: nothing comes back by itself");

			await prompt(parent, "recover", [fauxToolCall("subagent_wait", { recent: true }, { id: "r1" })]);
			const [recent] = parent.toolResults("subagent_wait");
			const listed = (recent!.details as unknown as SubagentWaitStructured).recent?.map((run) => run.runId);
			assert.deepEqual(listed, parent.runIds.slice(1).reverse(), "the newest 20, newest first");
			assert.equal(recent!.text.split("\n").length, 20);
			assert.ok(recent!.text.length <= 1900);

			const first = parent.runIds[0]!;
			await prompt(parent, "look up", [fauxToolCall("subagent_wait", { runIds: [first] }, { id: "l1" })]);
			const lookup = parent.toolResults("subagent_wait")[1]!;
			assert.match(lookup.text, /REPORT OF seq-0/);
			assert.match(lookup.text, new RegExp(`run: ${first}`));
			assert.equal(parent.runIds.length, 21, "recovery launched nothing");
			assert.equal(parent.resultMessages(), 0);
			assert.equal(pendingRunEndCount(), 0);
		} finally {
			await parent.dispose();
		}
	});

	it("check 4: unwritable results folder: a script waits and throws without printing; recent and lookup come from memory", async () => {
		const parent = await startParent({ unwritableResults: true });
		try {
			await prompt(parent, "work", [fauxToolCall("codemode", { code: sequentialScript(1) }, { id: "s1" })]);
			const [script] = parent.toolResults("codemode");
			assert.ok(script?.isError);
			assert.doesNotMatch(script.text, /kept in memory/, "the script output does not carry the notice");
			assert.equal(parent.notices.length, 1, "the storage failure was shown to the person once");
			assert.match(parent.notices[0]!, /^Subagent results are kept in memory only: /);
			const [runId] = parent.runIds;

			await prompt(parent, "recover", [fauxToolCall("subagent_wait", { recent: true }, { id: "r1" })]);
			const [recent] = parent.toolResults("subagent_wait");
			assert.match(recent!.text, new RegExp(`^${runId} · seq-0 · done · `));

			await prompt(parent, "look up", [fauxToolCall("subagent_wait", { runIds: [runId] }, { id: "l1" })]);
			const lookup = parent.toolResults("subagent_wait")[1]!;
			assert.match(lookup.text, /REPORT OF seq-0[\s\S]*report not saved/);
			assert.equal(parent.runIds.length, 1, "recovery launched nothing");
			assert.equal(parent.resultMessages(), 0);
		} finally {
			await parent.dispose();
		}
	});
});
