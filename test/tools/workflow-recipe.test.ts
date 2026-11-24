import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { registerDeliveryQueue } from "../../src/runtime/delivery-queue.ts";
import { sessionResultStore } from "../../src/runtime/result-files.ts";
import { publishedResultFields, publishRunResult, type WatchedEnd } from "../../src/runtime/run-result.ts";
import { wireSubagentSteerBack } from "../../src/runtime/running-registry.ts";
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
import { assistant, sessionHeader, toolCall, toolResult, user } from "../support/result-fixtures.ts";

// T51, amended by the owner 2026-11-24 (no subagent_wait): the workflow script recipe of the README,
// run as written in a real Pi parent with a faux provider and codemode. The script launches and
// returns; every run that ends reaches the parent as a subagent_result message that starts a turn.
// Children are fakes that end the way their watcher does (a published record); launch, delivery
// and the result store are production code.

type ToolCall = ReturnType<typeof fauxToolCall>;

const README = join(import.meta.dirname, "..", "..", "README.md");
/** The js block that follows `<!-- recipe: <name> -->` in the README. */
function readRecipe(name: string): string {
	const readme = readFileSync(README, "utf8");
	const start = readme.indexOf(`<!-- recipe: ${name} -->`);
	assert.ok(start >= 0, `the README marks the ${name} recipe`);
	const match = /```js\n([\s\S]*?)\n```/.exec(readme.slice(start));
	assert.ok(match?.[1], "a js block follows the marker");
	return match[1];
}

type BatchEntry = { agent: string; name: string; title: string; task: string };

/** The recipe with another batch. */
function recipe(options: { batch?: BatchEntry[] } = {}): string {
	let source = readRecipe("workflow-script");
	if (options.batch) {
		const start = source.indexOf("const BATCH = [");
		const end = source.indexOf("];", start) + 2;
		assert.ok(start >= 0 && end > start, "the recipe has a BATCH input");
		source = `${source.slice(0, start)}const BATCH = ${JSON.stringify(options.batch)};${source.slice(end)}`;
	}
	return source;
}

const NAMES = ["auth-audit", "billing-audit", "search-audit"];

function workers(count: number, prefix = "audit-worker"): BatchEntry[] {
	return Array.from({ length: count }, (_, index) => ({
		agent: "worker",
		name: `${prefix}-${index}`,
		title: `Audit worker ${index}`,
		task: "t",
	}));
}

/** How a fake child ends: subagent_done with data, subagent_done whose data failed the schema, or plain text. */
type ChildEnd =
	| { kind: "typed"; data?: unknown; outcome?: string; summary?: string }
	| { kind: "data-error"; error: string }
	| { kind: "untyped"; text: string };

function endChild(running: RunningSubagent, how: ChildEnd): SubagentResult {
	const entries = [sessionHeader(), user("task")];
	let exitSignal: WatchedEnd["exitSignal"] = null;
	if (how.kind === "untyped") {
		entries.push(assistant(how.text));
	} else {
		const args =
			how.kind === "typed"
				? {
						outcome: how.outcome ?? "done",
						summary: how.summary ?? `SUMMARY OF ${running.name}`,
						...(how.data === undefined ? {} : { data: how.data }),
					}
				: { outcome: "done", summary: `SUMMARY OF ${running.name}`, data: { wrong: true } };
		entries.push(toolCall("subagent_done", args, "d1"), toolResult("subagent_done", "d1", "ok"));
		exitSignal = {
			reason: "done",
			exitCode: 0,
			acceptedCall: {
				toolCallId: "d1",
				args,
				...(how.kind === "data-error" ? { dataError: how.error } : {}),
			},
		} as WatchedEnd["exitSignal"];
	}
	writeFileSync(running.sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	const published = publishRunResult(running, {
		exitCode: 0,
		operatorClosed: false,
		closedByPerson: false,
		stopped: false,
		exitSignal,
		contextUsage: {},
	});
	return {
		name: running.name,
		task: "t",
		summary: published?.summary ?? "",
		summarySource: published?.summarySource ?? "subagent",
		sessionFile: running.sessionFile,
		exitCode: 0,
		elapsed: 1,
		...(published ? publishedResultFields(published) : {}),
	};
}

interface Parent {
	session: AgentSession;
	/** Run ids in launch order; its length counts every launch. */
	runIds: string[];
	idOf(name: string): string;
	end(name: string, how: ChildEnd): void;
	run(text: string, calls: ToolCall[]): Promise<void>;
	toolResults(name: string): { text: string; details: Record<string, unknown>; isError: boolean }[];
	resultMessages(): number;
	dispose(): Promise<void>;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block as { text?: string }).text ?? "").join("");
}

/** deepCwd: a long working directory, so each report path is about 200 characters. */
async function startParent(options: { deepCwd?: boolean } = {}): Promise<Parent> {
	const root = options.deepCwd ? join(createTestDir(), "d".repeat(100)) : createTestDir();
	mkdirSync(root, { recursive: true });
	const agentDir = join(root, "agent");
	const sessionManager = SessionManager.create(root, join(root, "sessions"));
	const resultsDir = getSessionResultsDir(root, sessionManager.getSessionId());
	const plan: Record<string, ToolCall[]> = {};
	const faux = fauxProvider();
	const step = (context: { messages: { role: string; content: unknown }[] }): AssistantMessage => {
		const last = context.messages.at(-1);
		const calls = last?.role === "user" ? plan[textOf(last.content)] : undefined;
		return calls ? fauxAssistantMessage(calls, { stopReason: "toolUse" }) : fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 30 }, () => step as never));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"),
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const runIds: string[] = [];
	const runs = new Map<string, RunningSubagent>();
	const finish = new Map<string, (result: SubagentResult) => void>();
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
				agent: params.agent,
				mode: "background",
				phase: { kind: "running" },
				parentClosePolicy: "terminate",
				blocking: false,
				async: true,
				startTime: Date.now(),
				sessionFile: join(root, `${params.name}.jsonl`),
				resultTarget: { store, reservation, parentCwd: root, warnings: [] },
			} as RunningSubagent;
			setRunningSubagentForTest(running as never);
			runIds.push(running.id);
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
	// An interactive parent: a headless one awaits every launch, so no run would still be running.
	// Pi spreads the UI context: a method that the parent calls (notify) must be an own key.
	const ui = new Proxy({ notify() {} }, { get: () => () => undefined });
	await session.bindExtensions({ uiContext: ui as never });
	const toolResults = (name: string) =>
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
		);
	return {
		session,
		runIds,
		idOf: (name) => runs.get(name)?.id ?? assert.fail(`no child ${name}`),
		end: (name, how) => {
			const running = runs.get(name);
			const resolve = finish.get(name);
			if (!running || !resolve) assert.fail(`no running child ${name}`);
			resolve(endChild(running, how));
		},
		run: async (text, calls) => {
			plan[text] = calls;
			await session.prompt(text);
			await session.waitForIdle();
		},
		toolResults,
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

async function until(condition: () => boolean, what: string, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function scriptCall(code: string, id = "workflow-1"): ToolCall[] {
	return [fauxToolCall("codemode", { code }, { id })];
}

/** The JSON object the recipe returns. */
function replyOf(text: string): Record<string, unknown> {
	const start = text.indexOf("{");
	assert.ok(start >= 0, `the script returned an object: ${text}`);
	return JSON.parse(text.slice(start)) as Record<string, unknown>;
}

describe("T51 (owner 2026-11-24): the README workflow script recipe in a real Pi session", () => {
	it("the script launches and returns; every ended run reaches the parent as a result message that starts a turn", async () => {
		const parent = await startParent();
		try {
			await parent.run("work", scriptCall(recipe()));
			const [script] = parent.toolResults("codemode");
			assert.ok(script && !script.isError, `the script completed: ${script?.text}`);
			const reply = replyOf(script.text) as { runs: { id: string; name: string; state: string }[]; note: string };
			assert.deepEqual(
				reply.runs.map((run) => [run.name, run.state]),
				NAMES.map((name) => [name, "started"]),
			);
			assert.deepEqual(
				reply.runs.map((run) => run.id),
				parent.runIds,
			);
			assert.match(reply.note, /arrives as a message/);
			assert.equal(parent.resultMessages(), 0, "no run ended yet");
			const turnsBefore = parent.session.messages.filter((message) => message.role === "assistant").length;
			parent.end("auth-audit", { kind: "typed", data: { module: "auth" } });
			parent.end("billing-audit", { kind: "untyped", text: "billing is fine" });
			parent.end("search-audit", { kind: "data-error", error: "data/module must be string" });
			const delivered = () =>
				parent.session.messages
					.filter((message) => message.role === "custom" && message.customType === "subagent_result")
					.map((message) => textOf((message as { content: unknown }).content))
					.join("\n");
			await until(() => parent.runIds.every((id) => delivered().includes(id)), "every run reports by message");
			await parent.session.waitForIdle();
			for (const name of NAMES) assert.match(delivered(), new RegExp(name), `${name} is in a result message`);
			assert.match(delivered(), /report/i, "a result message names the report");
			const turnsAfter = parent.session.messages.filter((message) => message.role === "assistant").length;
			assert.ok(turnsAfter > turnsBefore, "a result message started a parent turn");
			assert.equal(parent.toolResults("subagent_wait").length, 0);
			assert.equal(parent.runIds.length, 3, "nothing launched again");
		} finally {
			await parent.dispose();
		}
	});
});
