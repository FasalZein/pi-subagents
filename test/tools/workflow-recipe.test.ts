import { readFileSync, writeFileSync } from "node:fs";
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
import { isRunEndHeld } from "../../src/runtime/wait-holds.ts";
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
import { assistant, sessionHeader, toolCall, toolResult, user } from "../support/result-fixtures.ts";

// T51: the workflow script recipe of the README, run as written in a real Pi parent with a faux
// provider and codemode. Only the time limits are shortened, each by one exact substitution, so a
// README edit that drops a substituted line fails this test. Children are fakes that end the way
// their watcher does (a published record); launch, waits, delivery and the result store are
// production code.

type ToolCall = ReturnType<typeof fauxToolCall>;

const README = join(import.meta.dirname, "..", "..", "README.md");
const RECIPE_MARKER = "<!-- recipe: workflow-script -->";

function readRecipe(): string {
	const readme = readFileSync(README, "utf8");
	const start = readme.indexOf(RECIPE_MARKER);
	assert.ok(start >= 0, "the README marks the workflow script recipe");
	const match = /```js\n([\s\S]*?)\n```/.exec(readme.slice(start));
	assert.ok(match, "a js block follows the marker");
	return match[1]!;
}

function replaceOnce(source: string, from: string, to: string): string {
	assert.equal(source.split(from).length - 1, 1, `the recipe has exactly one ${JSON.stringify(from)}`);
	return source.replace(from, to);
}

/** The recipe with a shorter wait and, for a forced failure, a script deadline shorter than the wait. */
function recipe(options: { waitSeconds?: number; scriptTimeoutMs?: number } = {}): string {
	let source = readRecipe();
	if (options.waitSeconds !== undefined)
		source = replaceOnce(source, "const WAIT_SECONDS = 1500;", `const WAIT_SECONDS = ${options.waitSeconds};`);
	if (options.scriptTimeoutMs !== undefined)
		source = replaceOnce(source, '"timeout_ms": 1800000', `"timeout_ms": ${options.scriptTimeoutMs}`);
	return source;
}

const NAMES = ["auth-audit", "billing-audit", "search-audit"];

/** How a fake child ends: subagent_done with data, subagent_done whose data failed the schema, or plain text. */
type ChildEnd =
	| { kind: "typed"; data: unknown }
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
				? { outcome: "done", summary: `SUMMARY OF ${running.name}`, data: how.data }
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

async function startParent(): Promise<Parent> {
	const root = createTestDir();
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
				executionState: "running",
				deliveryState: "detached",
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
		registerSubagentWaitTool(pi, () => true, { mayLaunch: () => true });
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
	const ui = new Proxy({}, { get: () => () => undefined });
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

function scriptCall(code: string): ToolCall[] {
	return [fauxToolCall("codemode", { code }, { id: "workflow-1" })];
}

/** The digest the recipe returns: the JSON text after the Run ids line. */
function digestOf(text: string): Record<string, unknown> {
	const start = text.indexOf("{");
	assert.ok(start >= 0, `the script returned an object: ${text}`);
	return JSON.parse(text.slice(start)) as Record<string, unknown>;
}

const TOKEN_CHARS = 4;
const DIGEST_TOKEN_LIMIT = 1500;

describe("T51: the README workflow script recipe in a real Pi session", () => {
	it("check 1: the digest names outcome, data, the data error and the untyped run with report paths", async () => {
		const parent = await startParent();
		try {
			const work = parent.run("work", scriptCall(recipe()));
			await until(
				() => parent.runIds.length === 3 && parent.runIds.every(isRunEndHeld),
				"the script waits for three runs",
			);
			parent.end("auth-audit", { kind: "typed", data: { findings: 2 } });
			parent.end("billing-audit", { kind: "data-error", error: "DATA-ERROR: /findings must be integer" });
			parent.end("search-audit", { kind: "untyped", text: "UNTYPED REPORT OF search-audit" });
			await work;
			const [script] = parent.toolResults("codemode");
			assert.ok(script && !script.isError, `the script completed: ${script?.text}`);
			assert.match(script.text, new RegExp(`Run ids: ${parent.runIds.join(", ")}`));
			const digest = digestOf(script.text);
			assert.equal(digest.ok, false, "a data error and an untyped run make the batch not ok");
			assert.ok(script.text.length / TOKEN_CHARS <= DIGEST_TOKEN_LIMIT, "the digest stays within about 1,500 tokens");
			const runs = digest.runs as Record<string, unknown>[];
			const byName = Object.fromEntries(runs.map((run) => [run.name, run]));
			assert.deepEqual(Object.keys(byName).sort(), [...NAMES].sort());
			assert.equal(byName["auth-audit"]!.outcome, "done");
			assert.equal(byName["auth-audit"]!.data, JSON.stringify({ findings: 2 }));
			assert.equal(byName["auth-audit"]!.check, undefined);
			assert.match(String(byName["billing-audit"]!.check), /^data error: DATA-ERROR/);
			assert.equal(byName["billing-audit"]!.data, undefined);
			assert.match(String(byName["search-audit"]!.check), /^untyped/);
			for (const run of runs) {
				assert.equal(run.id, parent.idOf(String(run.name)));
				assert.match(String(run.report), /\.md$/, "each entry names its report file");
			}
			assert.equal(parent.resultMessages(), 0, "the wait delivered every result");
		} finally {
			await parent.dispose();
		}
	});

	it("check 1: on the wait time limit the digest returns the pending ids and says not to redo them", async () => {
		const parent = await startParent();
		try {
			const work = parent.run("work", scriptCall(recipe({ waitSeconds: 0.5 })));
			await until(() => parent.runIds.length === 3 && parent.runIds.every(isRunEndHeld), "the script waits");
			parent.end("auth-audit", { kind: "typed", data: { findings: 0 } });
			await work;
			const [script] = parent.toolResults("codemode");
			assert.ok(script && !script.isError, `the script completed: ${script?.text}`);
			const digest = digestOf(script.text);
			assert.equal(digest.ok, false);
			const pending = digest.pending as { ids: string[]; note: string };
			assert.deepEqual(pending.ids.sort(), [parent.idOf("billing-audit"), parent.idOf("search-audit")].sort());
			assert.match(pending.note, /Do not redo their work/);
			assert.equal(parent.runIds.length, 3);
			parent.end("billing-audit", { kind: "typed", data: {} });
			parent.end("search-audit", { kind: "typed", data: {} });
			await until(() => parent.resultMessages() === 2, "the pending runs report by message");
			await parent.session.waitForIdle();
		} finally {
			await parent.dispose();
		}
	});

	it("check 1: after a forced script failure, recent and a lookup by run id recover every result; nothing is launched again", async () => {
		const parent = await startParent();
		try {
			const work = parent.run("work", scriptCall(recipe({ scriptTimeoutMs: 1500 })));
			await until(() => parent.runIds.length === 3 && parent.runIds.every(isRunEndHeld), "the script waits");
			await work;
			const [script] = parent.toolResults("codemode");
			assert.ok(script?.isError, "the script failed on its deadline");
			assert.match(script.text, /timed out/i);
			assert.match(
				script.text,
				new RegExp(`Run ids: ${parent.runIds.join(", ")}`),
				"the partial output names every run",
			);
			for (const name of NAMES) parent.end(name, { kind: "typed", data: { module: name } });
			await until(() => parent.resultMessages() >= 1, "the children report after the failed script");
			await parent.session.waitForIdle();

			await parent.run("recover", [fauxToolCall("subagent_wait", { recent: true }, { id: "recent-1" })]);
			const [recent] = parent.toolResults("subagent_wait");
			const listed = (recent!.details as unknown as SubagentWaitStructured).recent?.map((run) => run.runId) ?? [];
			assert.deepEqual([...listed].sort(), [...parent.runIds].sort(), "recent lists the three ended runs");

			const first = parent.runIds[0]!;
			await parent.run("look up", [fauxToolCall("subagent_wait", { ids: [first] }, { id: "lookup-1" })]);
			const lookup = parent.toolResults("subagent_wait")[1]!;
			const record = (lookup.details as unknown as SubagentWaitStructured).results[0]?.record;
			assert.match(lookup.text, /SUMMARY OF auth-audit/);
			assert.deepEqual(record?.data, { module: "auth-audit" });
			assert.equal(parent.runIds.length, 3, "recovery launched nothing");
		} finally {
			await parent.dispose();
		}
	});
});
