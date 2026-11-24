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
import { registerContextFold } from "../../src/runtime/context-fold.ts";
import { registerDeliveryQueue } from "../../src/runtime/delivery-queue.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { publishedResultFields, publishRunResult, type WatchedEnd } from "../../src/runtime/run-result.ts";
import { getLaunchedSubagentResult, wireSubagentSteerBack } from "../../src/runtime/running-registry.ts";
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
	options: {
		api?: string;
		resumeFile?: string;
		root?: string;
		codemode?: boolean;
		blocking?: boolean;
		/** Another extension's tool_result handler, as Pi chains it after this package's handlers. */
		annotate?: (event: { toolName: string; content: { type: string; text?: string }[] }) => unknown;
		/**
		 * The launch wait finds the run already taken (another wait took its ping): it reads the
		 * published record and replies with the lookup copy (running-registry.ts lookUpEnded).
		 */
		lookup?: boolean;
		/** The calls for a last user-role message that no plan key names, such as a result message. */
		react?: (text: string) => ToolCall[] | undefined;
	} = {},
): Promise<Parent> {
	const root = options.root ?? createTestDir();
	const agentDir = join(root, "agent");
	const faux = fauxProvider({ api: options.api ?? "anthropic-messages" });
	const requests: string[] = [];
	const step = (context: { messages: { role: string; content: unknown }[] }): AssistantMessage => {
		requests.push(JSON.stringify(context.messages.map((message) => message.content)));
		const last = context.messages.at(-1);
		const text = last?.role === "user" ? textOf(last.content) : undefined;
		const calls = text === undefined ? undefined : (plan[text] ?? options.react?.(text));
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
	// The session's own results folder, written through a store of its own: a lookup reads the
	// files, as a fresh process does.
	let store: ResultStore | undefined;
	const sessionStore = () => {
		store ??= new ResultStore(getSessionResultsDir(root, session.sessionManager.getSessionId()), () => {});
		return store;
	};
	let finish: ((result: SubagentResult) => void) | undefined;
	let publishedOnceResolve: () => void = () => {};
	const publishedOnce = new Promise<void>((resolve) => {
		publishedOnceResolve = resolve;
	});
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
				parentSessionId: session.sessionManager.getSessionId(),
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
		getLaunchedSubagentResult: options.lookup
			? async (running) => {
					await publishedOnce;
					return getLaunchedSubagentResult(running, {
						updateWidget: () => {},
						waitForSubagentResult: async () => ({ details: { error: "not_found" } }),
						stopRunningSubagent: async () => {},
						asSubagentToolResult: (result) => result,
					});
				}
			: (running, signal) => getLaunchedSubagentResultForTest(running, signal),
		listLaunchableAgents: () => [],
		muxUnavailableResult: () => ({ content: [{ type: "text", text: "mux" }], details: {} }),
	};
	const extension: ExtensionFactory = (pi) => {
		registerDeliveryQueue(pi);
		registerContextFold(pi);
		registerSubagentCoreTools(pi, () => true, runtime);
		const annotate = options.annotate;
		if (annotate) pi.on("tool_result", (event) => annotate(event as never) as never);
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
			if (options.lookup) {
				// The other wait took the run's end: it is no longer running and no result message follows.
				runningSubagents.delete(child.id);
				publishedOnceResolve();
				return;
			}
			finish?.({
				name: child.name,
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
	it("folds brief and result after the settle; the stubs name the report and no wait tool; a reloaded session keeps them", async () => {
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
			assert.match(after, new RegExp(`Folded subagent run ${runId} \\(child-one\\): done, report /[^ ]+\\.md\\]`));
			assert.doesNotMatch(after, /subagent_wait/, "owner 2026-11-24: a stub names the report, not a wait call");
			file = parent.session.sessionManager.getSessionFile() ?? assert.fail("no session file");
			// The task stub names the way back to the original brief: the call's line in the session file.
			const route = `Original text: the line with \\"launch-1\\" in ${file}.`;
			assert.ok(after.includes(route), "the stub names the original call");
			const line = readFileSync(file, "utf8")
				.split("\n")
				.find((entry) => entry.includes('"launch-1"') && entry.includes('"toolCall"'));
			assert.match(line ?? "", new RegExp(BRIEF), "that line holds the original brief");
			root = parent.session.sessionManager.getCwd();
			const stored = JSON.stringify(SessionManager.open(file).getEntries());
			assert.match(stored, new RegExp(BRIEF), "the session file keeps the brief");
			assert.match(stored, new RegExp(REPORT), "the session file keeps the result");
		} finally {
			await parent.dispose();
		}
		// A freshly bound session on the same file: no runtime state, a new result store.
		const reloaded = await startParent(PLAN, { resumeFile: file, root });
		try {
			await reloaded.session.prompt("again");
			await reloaded.session.waitForIdle();
			const request = reloaded.requests.at(-1) ?? "";
			assert.doesNotMatch(request, new RegExp(BRIEF));
			assert.doesNotMatch(request, new RegExp(REPORT));
			assert.match(request, new RegExp(`Folded subagent run ${runId}`));
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
			// The head names the parent's own script as folded; the children never got this script.
			assert.match(after, /The harness folded your original script; original code: the line with \\"script-1\\" in /);
			assert.doesNotMatch(after, /got your full code/);
		} finally {
			await parent.dispose();
		}
	});

	/**
	 * A codemode script that waits for its child inside itself (fold-waits S5, D4): its nested call
	 * takes the run's end, so no result message follows. The child ends while the script waits.
	 */
	async function runWaitingScript(
		code: string,
		options: {
			blocking?: boolean;
			annotate?: NonNullable<Parameters<typeof startParent>[1]>["annotate"];
			answer?: boolean;
		} = {},
	) {
		const parent = await startParent(
			{ ...PLAN, delegate: [fauxToolCall("codemode", { code }, { id: "script-1" })] },
			{ codemode: true, blocking: options.blocking, annotate: options.annotate },
		);
		const delegated = parent.session.prompt("delegate");
		await until(() => runningSubagents.size > 0, "the nested launch");
		parent.finish(REPORT);
		await delegated;
		await parent.session.waitForIdle();
		const result = parent.session.messages.find((m) => m.role === "toolResult" && m.toolName === "codemode");
		const content = JSON.stringify((result as { content?: unknown } | undefined)?.content);
		if (options.answer !== false) assert.match(content, new RegExp(REPORT), "the script returned the child's answer");
		assert.equal(
			parent.session.messages.some((m) => m.role === "custom"),
			false,
			"no result message followed",
		);
		return { parent, content, isError: (result as { isError?: boolean } | undefined)?.isError === true };
	}

	const LAUNCH = `const r = await tools.subagent({ name: "child-one", task: "${BRIEF}", title: "One", agent: "worker-a" });`;
	const WAITING_SCRIPTS: Array<[string, string, boolean]> = [
		["a waited launch", `${LAUNCH}\nreturn r.children[0].record.summary;`, true],
	];

	it("folds the code of a launch script that waits inside itself; its result stays byte-identical (S5)", async () => {
		for (const [form, code, blocking] of WAITING_SCRIPTS) {
			const { parent, content } = await runWaitingScript(code, { blocking });
			try {
				assert.match(parent.requests.at(-1) ?? "", new RegExp(BRIEF), `${form}: before the settle the code is whole`);
				const nested = parent.session.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === "subagent_context_fold_nested");
				assert.equal(nested.length, 1, `${form}: one nested-take entry`);
				// Owner rule 2026-11-23T11:58Z: run ids only.
				const data = (nested[0] as { data: Record<string, unknown> }).data;
				assert.deepEqual(Object.keys(data).sort(), ["callId", "nestedId", "runIds"], `${form}: the persisted keys`);
				assert.deepEqual(data.runIds, [parent.runId()], `${form}: the run id`);
				await until(() => parent.foldEntries() === 1, `${form}: the fold entry of the settle`);
				await parent.session.prompt("next");
				await parent.session.waitForIdle();
				const after = parent.requests.at(-1) ?? "";
				assert.doesNotMatch(after, new RegExp(BRIEF), `${form}: the script's brief is gone`);
				assert.match(after, new RegExp(`Folded launch script of runs ${parent.runId()}\\.`), form);
				assert.ok(after.includes(content), `${form}: the script result is byte-identical`);
			} finally {
				await parent.dispose();
			}
		}
	});

	it("keeps a waiting script whole when it also calls another tool or throws after the wait (S5)", async () => {
		// [form, code, expected script error, expected fold entries]
		const scripts: Array<[string, string, boolean, number]> = [
			[
				"a mixed script",
				WAITING_SCRIPTS[0][1].replace("return", 'await tools.bash({ command: "echo hi" });\nreturn'),
				false,
				1,
			],
			["a script that throws", `${LAUNCH}\nthrow new Error("after " + r.children[0].record.summary);`, true, 0],
		];
		for (const [form, code, expectError, expectFolds] of scripts) {
			const { parent, content, isError } = await runWaitingScript(code, { blocking: true });
			assert.equal(isError, expectError, `${form}: the script's error flag`);
			try {
				const before = parent.requests.at(-1) ?? "";
				await parent.session.prompt("next");
				await parent.session.waitForIdle();
				const after = parent.requests.at(-1) ?? "";
				assert.match(after, new RegExp(BRIEF), `${form}: the code stays whole`);
				assert.ok(after.startsWith(before.slice(0, -1)), `${form}: the earlier messages are byte-identical`);
				assert.ok(after.includes(content), `${form}: the script result stays`);
				// A thrown script showed the model no answer: its run is not used and does not fold.
				assert.equal(parent.foldEntries(), expectFolds, form);
			} finally {
				await parent.dispose();
			}
		}
	});

	it("a nested take survives reload and /fork: before the settle it folds only where the record is readable", async () => {
		const { parent } = await runWaitingScript(WAITING_SCRIPTS[0][1], { blocking: true });
		let file = "";
		let root = "";
		let runId = "";
		try {
			await until(() => parent.foldEntries() === 1, "the fold entry of the settle");
			file = parent.session.sessionManager.getSessionFile() ?? assert.fail("no session file");
			root = parent.session.sessionManager.getCwd();
			runId = parent.runId();
		} finally {
			await parent.dispose();
		}
		const entries = SessionManager.open(file).getEntries();
		const foldAt = entries.findIndex((entry) => entry.type === "custom" && entry.customType === FOLD_ENTRY);
		const stub = new RegExp(`Folded launch script of runs ${runId}\\.`);
		// The session file as it was before the settle (the process stopped first): cut at the fold entry.
		const lines = readFileSync(file, "utf8").split("\n");
		const reloaded = join(root, "sessions", "before-settle.jsonl");
		const cut = lines.findIndex((line) => line.includes(`"customType":"${FOLD_ENTRY}"`));
		writeFileSync(reloaded, `${lines.slice(0, cut).join("\n")}\n`);
		const open = async (resumeFile: string) => {
			const session = await startParent({}, { resumeFile, root, codemode: true });
			await session.session.prompt("again");
			await session.session.waitForIdle();
			const first = session.requests.at(-1) ?? "";
			await session.session.prompt("next");
			await session.session.waitForIdle();
			return { first, after: session.requests.at(-1) ?? "", folds: session.foldEntries(), session };
		};
		// After the settle: the fold entry holds the facts, so reload and fork keep the stubs.
		const forkedAfter = SessionManager.open(file).createBranchedSession(entries[entries.length - 1].id);
		for (const [form, resumeFile] of [
			["reload after the settle", file],
			["fork after the settle", forkedAfter ?? assert.fail("no fork")],
		] as const) {
			const { first, after, session } = await open(resumeFile);
			try {
				assert.doesNotMatch(first, new RegExp(BRIEF), `${form}: the code stays a stub`);
				assert.match(first, stub, form);
				assert.doesNotMatch(after, new RegExp(BRIEF), form);
			} finally {
				await session.dispose();
			}
		}
		// Before the settle (the process stopped first): the same session reads the run's record and folds
		// at its next settle; a fork has a new session id, cannot read the record, and stays full.
		const forkedBefore = SessionManager.open(file).createBranchedSession(entries[foldAt - 1].id);
		for (const [form, resumeFile, folds] of [
			["reload before the settle", reloaded, 1],
			["fork before the settle", forkedBefore ?? assert.fail("no fork"), 0],
		] as const) {
			const { first, after, folds: count, session } = await open(resumeFile);
			try {
				assert.match(first, new RegExp(BRIEF), `${form}: no fold before the settle`);
				assert.equal(count, folds, `${form}: fold entries`);
				if (folds === 1) assert.match(after, stub, `${form}: the code folds at the next settle`);
				else assert.match(after, new RegExp(BRIEF), `${form}: the code stays whole`);
			} finally {
				await session.dispose();
			}
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

	it("a waited launch reply that holds the lookup copy of a taken run folds with its saved report", async () => {
		const parent = await startParent(PLAN, { blocking: true, lookup: true });
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
			assert.equal((reply as { details?: { lookup?: boolean } }).details?.lookup, true, "the reply is the lookup copy");
			await until(() => parent.foldEntries() === 1, "the fold entry of the settle");
			await parent.session.prompt("next");
			await parent.session.waitForIdle();
			const after = parent.requests.at(-1) ?? "";
			assert.doesNotMatch(after, new RegExp(BRIEF), "the brief folds");
			assert.match(after, new RegExp(`Folded subagent run ${parent.runId()} \\(child-one\\): done`));
		} finally {
			await parent.dispose();
		}
	});

	it("keeps a waited launch reply full when another extension changed its text", async () => {
		const ANNOTATION = "NOTE-FROM-ANOTHER-EXTENSION";
		const forms: Array<[string, (text: string) => { type: string; text: string }[]]> = [
			[
				"an appended text block",
				(text) => [
					{ type: "text", text },
					{ type: "text", text: ANNOTATION },
				],
			],
			["text appended to the one block", (text) => [{ type: "text", text: `${text}\n\n${ANNOTATION}` }]],
		];
		for (const [form, change] of forms) {
			for (const tool of ["subagent"] as const) {
				const plan: Record<string, ToolCall[]> = { ...PLAN };
				const parent = await startParent(plan, {
					blocking: tool === "subagent",
					annotate: (event) =>
						event.toolName === tool ? { content: change(event.content.map((b) => b.text ?? "").join("")) } : undefined,
				});
				try {
					const delegated = parent.session.prompt("delegate");
					await until(() => parent.session.messages.some((m) => m.role === "assistant"), "the launch call");
					parent.finish(REPORT);
					await delegated;
					await parent.session.waitForIdle();
					await until(() => parent.foldEntries() === 1, "the fold entry of the settle");
					await parent.session.prompt("next");
					await parent.session.waitForIdle();
					const after = parent.requests.at(-1) ?? "";
					assert.match(after, new RegExp(ANNOTATION), `${tool}, ${form}: the other extension's text stays`);
					assert.match(after, new RegExp(REPORT), `${tool}, ${form}: the reply stays whole`);
				} finally {
					await parent.dispose();
				}
			}
		}
	});

	it("folds nothing while the task is open: a settle with a running child keeps every request full (review-fix shape)", async () => {
		// The review-fix benchmark (2026-11-24): async launch of child 1, the parent settles while it
		// runs, its result comes, the parent launches child 2, settles while child 2 runs, its result
		// comes, and the final request must still hold the first brief and result in full.
		const BRIEF_TWO = "BRIEF-TEXT-OF-CHILD-TWO";
		const REPORT_TWO = "CHILD-TWO-FULL-REPORT";
		const second = fauxToolCall(
			"subagent",
			{ name: "child-two", task: BRIEF_TWO, title: "Two", agent: "worker-a" },
			{ id: "launch-2" },
		);
		const parent = await startParent(PLAN, { react: (text) => (text.includes(REPORT) ? [second] : undefined) });
		try {
			await useOneRun(parent);
			await until(
				() =>
					runningSubagents.size > 0 &&
					parent.session.messages.some((m) => m.role === "toolResult" && m.toolCallId === "launch-2"),
				"the second launch",
			);
			await parent.session.waitForIdle();
			const entriesWhileOpen = parent.foldEntries();
			const before = parent.requests.length;
			parent.finish(REPORT_TWO);
			await until(() => parent.requests.length > before, "the second result turn");
			await parent.session.waitForIdle();
			const final = parent.requests.at(-1) ?? "";
			assert.match(final, new RegExp(REPORT_TWO));
			assert.doesNotMatch(final, /Folded|folded by the harness/, "no stub in a request of the open task");
			assert.match(final, new RegExp(BRIEF), "the parent's own first launch keeps its task text");
			assert.match(final, new RegExp(REPORT), "the first result stays full");
			assert.equal(entriesWhileOpen, 0, "a settle while child 2 runs folds nothing");
			// The settle after the last result closes the task: both runs fold, the launch calls with the task stub.
			await until(() => parent.foldEntries() === 1, "the fold entry of the task-end settle");
			await parent.session.prompt("next");
			await parent.session.waitForIdle();
			const after = parent.requests.at(-1) ?? "";
			for (const text of [BRIEF, REPORT, BRIEF_TWO, REPORT_TWO]) assert.doesNotMatch(after, new RegExp(text));
			assert.equal(
				after.split("Task text folded by the harness after run").length - 1,
				2,
				"both launch tasks carry the task stub",
			);
		} finally {
			await parent.dispose();
		}
	});

	it("another parent's running child does not keep this parent's task open (owner scope)", async () => {
		// Review round 1: two parent sessions in one process share the registry and the queue. A's
		// child still runs; B's task is closed, so B folds at its settle.
		const a = await startParent(PLAN);
		const b = await startParent(PLAN);
		try {
			await a.session.prompt("delegate");
			await a.session.waitForIdle();
			assert.ok(runningSubagents.has(a.runId()), "A's child runs");
			await useOneRun(b);
			await until(() => b.foldEntries() === 1, "B's fold entry while A's child runs");
			assert.equal(a.foldEntries(), 0, "A's own running child keeps A's task open");
		} finally {
			await b.dispose();
			await a.dispose();
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
