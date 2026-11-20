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

// T51: the workflow script and recovery recipes of the README, run as written in a real Pi parent
// with a faux provider and codemode. Only the inputs change (batch, time limits, run ids), each by
// one exact substitution, so a README edit that drops a substituted line fails this test. Children are fakes that end the way
// their watcher does (a published record); launch, waits, delivery and the result store are
// production code.

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

function replaceOnce(source: string, from: string, to: string): string {
	assert.equal(source.split(from).length - 1, 1, `the recipe has exactly one ${JSON.stringify(from)}`);
	return source.replace(from, to);
}

type BatchEntry = { agent: string; name: string; title: string; task: string };

/** The recipe with other inputs: a batch, a shorter wait, or a script deadline shorter than the wait. */
function recipe(options: { batch?: BatchEntry[]; waitSeconds?: number; scriptTimeoutMs?: number } = {}): string {
	let source = readRecipe("workflow-script");
	if (options.batch) {
		const start = source.indexOf("const BATCH = [");
		const end = source.indexOf("];", start) + 2;
		assert.ok(start >= 0 && end > start, "the recipe has a BATCH input");
		source = `${source.slice(0, start)}const BATCH = ${JSON.stringify(options.batch)};${source.slice(end)}`;
	}
	if (options.waitSeconds !== undefined)
		source = replaceOnce(source, "const WAIT_SECONDS = 1500;", `const WAIT_SECONDS = ${options.waitSeconds};`);
	if (options.scriptTimeoutMs !== undefined)
		source = replaceOnce(source, '"timeout_ms": 1800000', `"timeout_ms": ${options.scriptTimeoutMs}`);
	return source;
}

/** The recovery recipe with a 3-second wait; with run ids, the list in it is replaced by them. */
function recovery(runIds: string[] = []): string {
	const source = replaceOnce(readRecipe("recover"), "const WAIT_SECONDS = 600;", "const WAIT_SECONDS = 3;");
	return runIds.length === 0
		? source
		: replaceOnce(source, "const RUN_IDS = [];", `const RUN_IDS = ${JSON.stringify(runIds)};`);
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
		operatorClosed: false, closedByPerson: false,
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

function scriptCall(code: string, id = "workflow-1"): ToolCall[] {
	return [fauxToolCall("codemode", { code }, { id })];
}

/** The digest the recipe returns: the JSON text after the Run ids line. */
function digestOf(text: string): Record<string, unknown> {
	const start = text.indexOf("{");
	assert.ok(start >= 0, `the script returned an object: ${text}`);
	return JSON.parse(text.slice(start)) as Record<string, unknown>;
}

/** D25: a digest of at most about 1,500 tokens, at 4 characters per token. */
const DIGEST_CHARS = 6000;

type DigestRun = Record<string, unknown> & { id: string; name?: string };

async function runBatch(parent: Parent, code: string, ends: (parent: Parent) => void, count = 3) {
	const work = parent.run("work", scriptCall(code));
	await until(
		() => parent.runIds.length === count && parent.runIds.every(isRunEndHeld),
		`the script waits for ${count} runs`,
	);
	ends(parent);
	await work;
	const [script] = parent.toolResults("codemode");
	assert.ok(script && !script.isError, `the script completed: ${script?.text}`);
	assert.doesNotMatch(script.text, /truncated output/, "codemode did not cut the digest");
	const digest = digestOf(script.text);
	const runs = digest.runs as DigestRun[] | undefined;
	return {
		text: script.text,
		digest,
		byName: Object.fromEntries<DigestRun>((runs ?? []).map((run) => [String(run.name), run])),
	};
}

describe("T51: the README workflow script recipe in a real Pi session", () => {
	it("check 1: the digest names outcome, data, the data error and the untyped run with report paths", async () => {
		const parent = await startParent();
		try {
			const { text, digest, byName } = await runBatch(parent, recipe(), (p) => {
				p.end("auth-audit", { kind: "typed", data: { findings: 2 } });
				p.end("billing-audit", { kind: "data-error", error: "DATA-ERROR: /findings must be integer" });
				p.end("search-audit", { kind: "untyped", text: "UNTYPED REPORT OF search-audit" });
			});
			assert.match(text, new RegExp(`Run ids: ${parent.runIds.join(", ")}`));
			assert.equal(digest.ok, false, "a data error and an untyped run make the batch not ok");
			assert.deepEqual(Object.keys(byName).sort(), [...NAMES].sort());
			assert.equal(byName["auth-audit"]?.outcome, "done");
			assert.deepEqual(byName["auth-audit"]?.data, { findings: 2 }, "a small value comes back whole");
			assert.equal(byName["auth-audit"]?.check, undefined);
			assert.match(String(byName["billing-audit"]?.check), /^data error: DATA-ERROR/);
			assert.equal(byName["billing-audit"]?.data, undefined);
			assert.match(String(byName["search-audit"]?.check), /^untyped/);
			for (const run of Object.values(byName)) {
				assert.equal(run.id, parent.idOf(String(run.name)));
				assert.match(String(run.report), /\.md$/, "each entry names its report file");
			}
			assert.equal(parent.resultMessages(), 0, "the wait delivered every result");
		} finally {
			await parent.dispose();
		}
	});

	it("fix round 1 (P1): a clean typed batch with one partial run is not ok; the all-done control is ok", async () => {
		for (const [partial, expected] of [
			[true, false],
			[false, true],
		] as const) {
			const parent = await startParent();
			try {
				const { digest, byName } = await runBatch(parent, recipe(), (p) => {
					p.end("auth-audit", { kind: "typed", data: { findings: 0 } });
					p.end("billing-audit", { kind: "typed", data: { findings: 1 }, ...(partial ? { outcome: "partial" } : {}) });
					p.end("search-audit", { kind: "typed", data: { findings: 0 } });
				});
				assert.equal(byName["billing-audit"]?.outcome, partial ? "partial" : "done");
				for (const run of Object.values(byName)) assert.equal(run.check, undefined, "no run has a check");
				assert.equal(digest.ok, expected, partial ? "a partial run makes the batch not ok" : "all done is ok");
			} finally {
				await parent.dispose();
			}
		}
	});

	it("fix round 1 (P1): a valid value longer than the data limit is omitted with a lookup by run id, never cut", async () => {
		const parent = await startParent();
		const modules = NAMES.map((name) => ({
			name,
			outcome: "done",
			report: `/Users/someone/.pi/history/work/artifacts/01a1f251-fb3c-761f-9182-ba3c2a91028b/results/${name}/report-1.md`,
		}));
		try {
			const { digest, byName } = await runBatch(parent, recipe(), (p) => {
				p.end("auth-audit", { kind: "typed", data: { modules } });
				p.end("billing-audit", { kind: "typed", data: {} });
				p.end("search-audit", { kind: "typed", data: {} });
			});
			assert.ok(JSON.stringify({ modules }).length > 300, "the value is longer than 300 characters");
			const auth = byName["auth-audit"];
			assert.equal(auth?.data, undefined, "no part of the long value is in the digest");
			const id = parent.idOf("auth-audit");
			assert.ok(String(auth?.dataOmitted).includes(`subagent_wait({ ids: ["${id}"] })`), "the entry names the lookup");
			assert.equal(digest.ok, true, "an omitted value is complete in the record");
			await parent.run("look up", [fauxToolCall("subagent_wait", { ids: [id] }, { id: "lookup-1" })]);
			const [lookup] = parent.toolResults("subagent_wait");
			assert.ok(lookup, "the lookup ran");
			const record = (lookup.details as unknown as SubagentWaitStructured).results[0]?.record;
			assert.deepEqual(record?.data, { modules }, "the lookup returns the whole value");
		} finally {
			await parent.dispose();
		}
	});

	it("fix round 1 (P1): 16 children with long summaries, values and report paths fit the digest budget whole", async () => {
		const parent = await startParent({ deepCwd: true });
		const batch = workers(16);
		try {
			const { text, digest } = await runBatch(
				parent,
				recipe({ batch }),
				(p) => {
					for (const child of batch)
						p.end(child.name, { kind: "typed", summary: "s".repeat(1500), data: { findings: "f".repeat(280) } });
				},
				16,
			);
			assert.ok(text.length <= DIGEST_CHARS + 400, `the script output is ${text.length} characters`);
			assert.ok(JSON.stringify(digest).length <= DIGEST_CHARS, "the digest is within about 1,500 tokens");
			assert.equal(digest.ok, true);
			const listed = JSON.stringify(digest);
			for (const id of parent.runIds) assert.ok(listed.includes(id), `the digest names run ${id}`);
			assert.match(String(digest.note), /subagent_wait/, "the digest says how to read what it left out");
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
});

describe("T51: the README recovery recipe after a forced script failure", () => {
	async function failScript(parent: Parent): Promise<void> {
		const work = parent.run("work", scriptCall(recipe({ scriptTimeoutMs: 1500 })));
		await until(() => parent.runIds.length === 3 && parent.runIds.every(isRunEndHeld), "the script waits");
		await work;
		const [script] = parent.toolResults("codemode");
		assert.ok(script?.isError, "the script failed on its deadline");
		assert.match(script.text, /timed out/i);
		assert.match(script.text, new RegExp(`Run ids: ${parent.runIds.join(", ")}`), "the partial output names every run");
	}

	it("with the run ids: the recipe returns the ended runs and waits for the one that still works; nothing is launched", async () => {
		const parent = await startParent();
		try {
			await failScript(parent);
			parent.end("auth-audit", { kind: "typed", data: { module: "auth" } });
			parent.end("billing-audit", { kind: "typed", data: { module: "billing" } });
			await until(() => parent.resultMessages() >= 1, "the ended children report by message");
			await parent.session.waitForIdle();
			const recover = parent.run("recover", scriptCall(recovery([...parent.runIds]), "recover-1"));
			const last = parent.idOf("search-audit");
			await until(() => isRunEndHeld(last), "the recovery waits for the run that still works");
			parent.end("search-audit", { kind: "typed", data: { module: "search" } });
			await recover;
			const script = parent.toolResults("codemode")[1];
			assert.ok(script && !script.isError, `the recovery completed: ${script?.text}`);
			const result = digestOf(script.text) as { runs: { id: string; outcome: string }[]; pending: string[] };
			assert.deepEqual(result.runs.map((run) => run.id).sort(), [...parent.runIds].sort());
			for (const run of result.runs) assert.equal(run.outcome, "done");
			assert.deepEqual(result.pending, []);
			assert.equal(parent.runIds.length, 3, "recovery launched nothing");
		} finally {
			await parent.dispose();
		}
	});

	it("with the ids lost: the recipe lists the ended runs of the session; nothing is launched", async () => {
		const parent = await startParent();
		try {
			await failScript(parent);
			for (const name of NAMES) parent.end(name, { kind: "typed", data: { module: name } });
			await until(() => parent.resultMessages() >= 1, "the children report after the failed script");
			await parent.session.waitForIdle();
			await parent.run("recover", scriptCall(recovery(), "recover-1"));
			const script = parent.toolResults("codemode")[1];
			assert.ok(script && !script.isError, `the recovery completed: ${script?.text}`);
			const result = digestOf(script.text) as { recent: { runId: string; outcome: string }[] };
			assert.deepEqual(result.recent.map((run) => run.runId).sort(), [...parent.runIds].sort());
			assert.equal(parent.runIds.length, 3, "recovery launched nothing");
		} finally {
			await parent.dispose();
		}
	});
});
