import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { __pollForExitTest__ } from "../../src/mux/poll.ts";
import { registerDeliveryQueue } from "../../src/runtime/delivery-queue.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { publishedResultFields, publishRunResult } from "../../src/runtime/run-result.ts";
import { wireSubagentSteerBack } from "../../src/runtime/running-registry.ts";
import { getSubagentExitSidecarPath } from "../../src/session/exit-sidecar.ts";
import { DATA_SCHEMA_ENV } from "../../src/tools/data-schema.ts";
import { registerSubagentCoreTools, type SubagentToolRuntime } from "../../src/tools/subagent-tools.ts";
import { SUBAGENT_DONE_TOOL_NAME } from "../../src/tools/tool-names.ts";
import { registerSubagentWaitTool } from "../../src/tools/wait-tool.ts";
import type { RunningSubagent, SubagentParamsInput, SubagentResult } from "../../src/types.ts";
import {
	assert,
	createTestDir,
	describe,
	getLaunchedSubagentResultForTest,
	it,
	resetSubagentStateForTest,
	setRunningSubagentForTest,
	subagentDoneExtension,
} from "../support/index.ts";

// T37 (D12) end to end: a real Pi parent session with a faux provider launches a child with a JSON
// schema through the real launch tool; a real Pi child session runs the child extension with the file
// the launch wrote; the child's exit record and session publish the record, and the real subagent_wait
// tool returns it. The child process and its watcher are the only fakes.
const DONE = SUBAGENT_DONE_TOOL_NAME;
type ToolArgs = Parameters<typeof fauxToolCall>[1];

const VERDICT_SCHEMA = {
	type: "object",
	properties: { verdict: { enum: ["approve", "reject"] }, findings: { type: "integer", minimum: 0 } },
	required: ["verdict", "findings"],
	additionalProperties: false,
};
const GOOD_DATA = { verdict: "approve", findings: 0 };
const BAD_DATA = { verdict: "maybe", findings: -1, extra: true };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block as { text?: string }).text ?? "").join("");
}

async function piSession(
	root: string,
	replies: FauxResponseStep[],
	extension: ExtensionFactory,
	sessionManager: SessionManager,
) {
	const agentDir = join(root, "agent");
	const faux = fauxProvider();
	faux.setResponses(replies);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"),
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
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
		sessionManager,
	});
	return { session, faux };
}

interface Parent {
	session: AgentSession;
	/** Launch parameters each fake child process received, by name. */
	launches: Map<string, SubagentParamsInput>;
	/** Ends a child the way its watcher does: publishes from the child's session file and exit record. */
	finishFromChild(name: string, childSessionFile: string): void;
	toolReplies(tool: string): { text: string; details: Record<string, unknown>; isError: boolean }[];
	dispose(): Promise<void>;
}

async function startParent(plan: Record<string, ReturnType<typeof fauxToolCall>[]>): Promise<Parent> {
	const root = createTestDir();
	const store = new ResultStore(join(root, "results"), () => {});
	const launches = new Map<string, SubagentParamsInput>();
	const runs = new Map<string, RunningSubagent>();
	const finish = new Map<string, (result: SubagentResult) => void>();
	const runtime: SubagentToolRuntime = {
		loadAgentDefaults: () => ({ spawning: true, async: true, mode: "background" }) as never,
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		launchBackgroundSubagent: async (params) => {
			launches.set(params.name, params);
			const running = {
				id: `id-${params.name}`,
				name: params.name,
				task: params.task,
				agent: "reviewer",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				blocking: false,
				async: true,
				startTime: Date.now(),
				sessionFile: join(root, `${params.name}.jsonl`),
				resultTarget: { store, reservation: store.reserve(), parentCwd: root, warnings: [] },
			} as RunningSubagent;
			setRunningSubagentForTest(running as never);
			runs.set(params.name, running);
			return running;
		},
		launchSubagent: async () => {
			throw new Error("no pane");
		},
		watchBackgroundSubagent: (running) => new Promise<SubagentResult>((resolve) => finish.set(running.name, resolve)),
		watchSubagent: async () => new Promise<SubagentResult>(() => {}),
		getWatcherSignal: (_running, controller) => controller.signal,
		wireSubagentSteerBack: (pi, running, promise) => wireSubagentSteerBack(pi as never, running, promise, () => {}),
		startWidgetRefresh: () => {},
		getLaunchedSubagentResult: (running, signal) => getLaunchedSubagentResultForTest(running, signal),
		listLaunchableAgents: () => [],
		muxUnavailableResult: () => ({ content: [{ type: "text", text: "mux" }], details: {} }),
	};
	const step = (context: { messages: { role: string; content: unknown }[] }): AssistantMessage => {
		const last = context.messages.at(-1);
		const calls = last?.role === "user" ? plan[textOf(last.content)] : undefined;
		return calls ? fauxAssistantMessage(calls, { stopReason: "toolUse" }) : fauxAssistantMessage("ok");
	};
	const extension: ExtensionFactory = (pi) => {
		registerDeliveryQueue(pi);
		registerSubagentCoreTools(pi, () => true, runtime);
		registerSubagentWaitTool(pi, () => true, { mayLaunch: () => true });
	};
	const { session } = await piSession(
		root,
		Array.from({ length: 20 }, () => step as never),
		extension,
		SessionManager.create(root, join(root, "sessions")),
	);
	await session.bindExtensions({ uiContext: new Proxy({}, { get: () => () => undefined }) as never });
	return {
		session,
		launches,
		finishFromChild(name, childSessionFile) {
			const running = runs.get(name);
			if (!running) assert.fail(`no child ${name}`);
			running.sessionFile = childSessionFile;
			const sidecar = JSON.parse(readFileSync(getSubagentExitSidecarPath(childSessionFile), "utf8"));
			const published = publishRunResult(running, {
				exitCode: 0,
				operatorClosed: false,
				stopped: false,
				exitSignal: __pollForExitTest__.interpretExitSidecar(sidecar),
				contextUsage: {},
			});
			if (!published) assert.fail("the run published no record");
			finish.get(name)?.({
				name,
				task: "t",
				summary: published.summary,
				summarySource: published.summarySource,
				sessionFile: childSessionFile,
				exitCode: 0,
				elapsed: 1,
				...publishedResultFields(published),
			});
		},
		toolReplies: (tool) =>
			session.messages.flatMap((message) =>
				message.role === "toolResult" && message.toolName === tool
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
}

/** A real headless child session with the launch's env; returns its session file and the tool results it saw. */
async function runChild(env: Record<string, string>, replies: FauxResponseStep[]) {
	const root = createTestDir();
	const sessionManager = SessionManager.create(root, join(root, "sessions"));
	const sessionFile = sessionManager.getSessionFile()!;
	const keys = { ...env, PI_SUBAGENT_SESSION: sessionFile, PI_SUBAGENT_AUTO_EXIT: "1" };
	Object.assign(process.env, keys);
	try {
		const { session, faux } = await piSession(root, replies, subagentDoneExtension, sessionManager);
		try {
			await session.bindExtensions({ shutdownHandler: () => {} });
			await session.prompt("Review the change.");
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.ok(existsSync(getSubagentExitSidecarPath(sessionFile)), "the child wrote its exit record");
			const doneResults = session.messages.flatMap((message) =>
				message.role === "toolResult" && message.toolName === DONE
					? [{ text: textOf(message.content), isError: message.isError }]
					: [],
			);
			return { sessionFile, doneResults, unusedReplies: faux.getPendingResponseCount() };
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			// No state reset here: the parent's run registry lives in the same process; its dispose resets.
			session.dispose();
		}
	} finally {
		for (const key of Object.keys(keys)) delete process.env[key];
	}
}

const done = (data: unknown, id: string) =>
	fauxAssistantMessage(
		[fauxToolCall(DONE, { outcome: "done", summary: "Reviewed the change.", data } as ToolArgs, { id })],
		{
			stopReason: "toolUse",
		},
	);

function launchWith(schema: unknown) {
	return [
		fauxToolCall(
			"subagent",
			{
				children: [
					{ name: "diff-reviewer", task: "Review the change.", title: "Review the change", agent: "reviewer", schema },
				],
			} as ToolArgs,
			{ id: "launch-1" },
		),
	];
}

async function launchAndRunChild(replies: FauxResponseStep[]) {
	const parent = await startParent({
		delegate: launchWith(VERDICT_SCHEMA),
		join: [fauxToolCall("subagent_wait", { ids: ["id-diff-reviewer"] }, { id: "wait-1" })],
	});
	await parent.session.prompt("delegate");
	await parent.session.waitForIdle();
	const params = parent.launches.get("diff-reviewer");
	assert.ok(params?.dataSchemaFile, "the launch hands the child a schema file");
	assert.deepEqual(JSON.parse(readFileSync(params.dataSchemaFile, "utf8")), VERDICT_SCHEMA);
	const launchReply = parent.toolReplies("subagent")[0]!;
	assert.doesNotMatch(launchReply.text, /additionalProperties|approve/, "the launch reply does not echo the schema");
	const child = await runChild({ [DATA_SCHEMA_ENV]: params.dataSchemaFile }, replies);
	const run = parent.session.prompt("join");
	await new Promise((resolve) => setTimeout(resolve, 20));
	parent.finishFromChild("diff-reviewer", child.sessionFile);
	await run;
	await parent.session.waitForIdle();
	const wait = parent.toolReplies("subagent_wait")[0]!;
	const results = wait.details.results as { text: string; record: Record<string, unknown> | null }[];
	return { parent, child, wait, record: results[0]!.record! };
}

describe("T37: data checked against a launch schema, end to end", () => {
	it("check 1: matching data is an object in the wait reply's record and not in the rendered text", async () => {
		const { parent, child, wait, record } = await launchAndRunChild([
			done(GOOD_DATA, "c1"),
			fauxAssistantMessage("late"),
		]);
		try {
			assert.deepEqual(
				child.doneResults.map((r) => r.isError),
				[false],
			);
			assert.equal(child.unusedReplies, 1, "the accepted call ends the child's turn");
			assert.equal(record.typed, true);
			assert.deepEqual(record.data, GOOD_DATA);
			assert.equal(record.dataError, undefined);
			assert.doesNotMatch(wait.text, /approve|verdict|findings/, "data stays out of the rendered text");
			assert.doesNotMatch(wait.text, /data error/);
		} finally {
			await parent.dispose();
		}
	});

	it("check 2: failing data gets one tool error with violations; a second failure is a typed record with a data error and no data", async () => {
		const { parent, child, wait, record } = await launchAndRunChild([
			done(BAD_DATA, "c1"),
			done(BAD_DATA, "c2"),
			fauxAssistantMessage("late"),
		]);
		try {
			assert.deepEqual(
				child.doneResults.map((r) => r.isError),
				[true, false],
				"one refusal, then the call ends the run",
			);
			const refusal = child.doneResults[0]!.text;
			assert.match(refusal, /does not match the launch schema/);
			const violations = refusal.split("\n").filter((line) => line.startsWith("- "));
			assert.ok(violations.length >= 1 && violations.length <= 10, `1 to 10 violations, got ${violations.length}`);
			assert.match(refusal, /data\.verdict/);
			assert.equal(record.typed, true);
			assert.equal(record.data, undefined);
			assert.equal(typeof record.dataError, "string");
			assert.match(wait.text.split("\n")[0]!, /data error/, "the header says data error");
		} finally {
			await parent.dispose();
		}
	});

	const refusals: [string, unknown, RegExp][] = [
		["an invalid schema", { type: "object", properties: { verdict: { type: "strng" } } }, /invalid schema/],
		["a malformed keyword", { type: "object", required: "verdict" }, /invalid schema/],
		["a $ref to an outside URL", { $ref: "https://example.com/verdict.json" }, /outside URL/],
		[
			"a nested $ref to an outside URL",
			{ type: "object", properties: { v: { $ref: "http://example.com/v#/x" } } },
			/outside URL/,
		],
		["a schema that is not an object", "a string", /JSON Schema object/],
	];
	it("each launch gets its own owner-only schema file, also two same-name siblings in one second", async () => {
		const other = { type: "object", required: ["other"] };
		const sibling = (schema: unknown) => ({
			name: "diff-reviewer",
			task: "t",
			title: "Review",
			agent: "reviewer",
			schema,
		});
		const parent = await startParent({
			delegate: [
				fauxToolCall("subagent", { children: [sibling(VERDICT_SCHEMA), sibling(other)] } as ToolArgs, {
					id: "launch-1",
				}),
			],
		});
		const launched: string[] = [];
		const umask = process.umask(0o022);
		try {
			const record = parent.launches.set.bind(parent.launches);
			parent.launches.set = (name, params) => {
				if (params.dataSchemaFile) launched.push(params.dataSchemaFile);
				return record(name, params);
			};
			await parent.session.prompt("delegate");
			await parent.session.waitForIdle();
			assert.equal(launched.length, 2);
			assert.notEqual(launched[0], launched[1], "two launches never share a schema file");
			assert.deepEqual(JSON.parse(readFileSync(launched[0]!, "utf8")), VERDICT_SCHEMA);
			assert.deepEqual(JSON.parse(readFileSync(launched[1]!, "utf8")), other);
			for (const file of launched) {
				assert.equal(statSync(file).mode & 0o777, 0o600, "the schema file is owner-only");
				assert.equal(statSync(dirname(file)).mode & 0o777, 0o700, "its folder is owner-only");
			}
		} finally {
			process.umask(umask);
			await parent.dispose();
		}
	});

	it("check 3: one bad schema in a batch refuses the batch; its valid sibling does not start", async () => {
		const valid = {
			name: "first-reviewer",
			task: "t",
			title: "First review",
			agent: "reviewer",
			schema: VERDICT_SCHEMA,
		};
		const invalid = {
			name: "second-reviewer",
			task: "t",
			title: "Second review",
			agent: "reviewer",
			schema: { $ref: "https://example.com/s" },
		};
		const parent = await startParent({
			delegate: [fauxToolCall("subagent", { children: [valid, invalid] } as ToolArgs, { id: "launch-1" })],
		});
		try {
			await parent.session.prompt("delegate");
			await parent.session.waitForIdle();
			assert.equal(parent.launches.size, 0, "no child started");
			assert.match(parent.toolReplies("subagent")[0]!.text, /second-reviewer: schema refers to an outside URL/);
		} finally {
			await parent.dispose();
		}
	});

	for (const [what, schema, error] of refusals) {
		it(`check 3: ${what} is refused before any child starts`, async () => {
			const parent = await startParent({ delegate: launchWith(schema) });
			try {
				await parent.session.prompt("delegate");
				await parent.session.waitForIdle();
				assert.equal(parent.launches.size, 0, "no child started");
				const reply = parent.toolReplies("subagent")[0]!;
				assert.equal(reply.isError, true);
				assert.match(reply.text, error);
			} finally {
				await parent.dispose();
			}
		});
	}
});
