import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, mock } from "node:test";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { getSubagentExitSidecarPath } from "../../src/session/exit-sidecar.ts";
import { CALLER_PING_TOOL_NAME, SUBAGENT_DONE_TOOL_NAME } from "../../src/tools/tool-names.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	assert,
	createTestDir,
	describe,
	it,
	resetSubagentStateForTest,
	subagentDoneExtension,
} from "../support/index.ts";

// T72 (D01 revert) end to end: a real Pi session with a faux provider runs the child extension; the
// exit record, the real background watcher and the published result files decide the result. Expected
// values come from cf6dbf4 (`git show cf6dbf4:src/tools/subagent-done.ts`, `caller-ping.ts`).
const DONE = SUBAGENT_DONE_TOOL_NAME;
const ENV_KEYS = ["PI_SUBAGENT_SESSION", "PI_SUBAGENT_AUTO_EXIT", "PI_SUBAGENT_SURFACE", "PI_DENY_TOOLS"];

interface ChildRun {
	sessionFile: string;
	/** Scripted replies the model never got to send. */
	unusedReplies: number;
	shutdownRequests: number;
	/** The exit record as the session closed, before the watcher consumes it. */
	exitBeforeClose: unknown;
}

/** Raw pane key listeners the child registered; pressKey() replays a person's key (D11 takeover). */
const keyListeners: Array<(data: string) => unknown> = [];
function pressKey() {
	for (const listener of [...keyListeners]) listener("x");
}
/** The pane UI methods the child uses; Pi spreads this object into its own UI context. */
const paneUi = {
	setStatus() {},
	setWidget() {},
	notify() {},
	onTerminalInput(listener: (data: string) => unknown) {
		keyListeners.push(listener);
		return () => keyListeners.splice(keyListeners.indexOf(listener), 1);
	},
};

/** A scripted reply sent after a person pressed a key in the pane mid-run. */
function afterKeyPress(reply: ReturnType<typeof fauxAssistantMessage>): FauxResponseStep {
	return () => {
		pressKey();
		return reply;
	};
}

/**
 * Runs the child extension in a real Pi session on one task prompt. The session closes like a pane
 * close: session_shutdown, then dispose.
 */
async function runChild(options: {
	autoExit: boolean;
	pane?: boolean;
	replies: FauxResponseStep[];
	extensions?: ExtensionFactory[];
}): Promise<ChildRun> {
	const root = createTestDir();
	const agentDir = join(root, "agent");
	const sessionManager = SessionManager.create(root, join(root, "sessions"));
	const sessionFile = sessionManager.getSessionFile();
	assert.ok(sessionFile, "the session has a file");
	process.env.PI_SUBAGENT_SESSION = sessionFile;
	if (options.autoExit) process.env.PI_SUBAGENT_AUTO_EXIT = "1";
	if (options.pane) process.env.PI_SUBAGENT_SURFACE = "fake-pane";
	const faux = fauxProvider();
	faux.setResponses(options.replies);
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
		extensionFactories: [subagentDoneExtension, ...(options.extensions ?? [])],
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
	let shutdownRequests = 0;
	let exitBeforeClose: unknown = null;
	try {
		await session.bindExtensions({
			shutdownHandler: () => void shutdownRequests++,
			...(options.pane ? { uiContext: paneUi as never } : {}),
		});
		await session.prompt("task");
		await new Promise((resolve) => setTimeout(resolve, 5)); // deferred shutdown requests
		const exitFile = getSubagentExitSidecarPath(sessionFile);
		exitBeforeClose = existsSync(exitFile) ? JSON.parse(readFileSync(exitFile, "utf8")) : null;
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		resetSubagentStateForTest();
		keyListeners.length = 0;
		for (const key of ENV_KEYS) delete process.env[key];
	}
	return { sessionFile, unusedReplies: faux.getPendingResponseCount(), shutdownRequests, exitBeforeClose };
}

/** The real background watcher on a child process that exits 0; returns the published record. */
async function watchAndPublish(sessionFile: string) {
	const root = createTestDir();
	const store = new ResultStore(join(root, "results"), () => {});
	const reservation = store.reserve();
	const child = new EventEmitter() as ChildProcess;
	const running = {
		id: reservation.runId,
		name: "worker",
		task: "Work",
		agent: "scout",
		mode: "background",
		phase: "running",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		childProcess: child,
		resultTarget: { store, reservation, parentCwd: root, warnings: [] },
	} as unknown as RunningSubagent;
	const watch = watchBackgroundSubagent(
		running,
		{ cleanupNoSessionSessionFile() {}, terminateBackgroundChildProcess() {} },
		new AbortController().signal,
	);
	setTimeout(() => child.emit("exit", 0, null), 10);
	await watch;
	const record = store.read(reservation.runId);
	assert.ok(record, "the watcher published a record");
	const report = record.report.saved ? readFileSync(record.report.path, "utf8") : "";
	return { record, report };
}

/** Records the active tools and the registered tool definitions as the model run ends. */
function toolProbe(seen: { active: string[]; params: Record<string, unknown>; descriptions: Record<string, string> }) {
	return ((pi) => {
		pi.on("agent_end", () => {
			seen.active = pi.getActiveTools();
			for (const tool of pi.getAllTools()) {
				seen.params[tool.name] = tool.parameters;
				seen.descriptions[tool.name] = tool.description;
			}
		});
	}) as ExtensionFactory;
}

const newProbe = () => ({
	active: [] as string[],
	params: {} as Record<string, unknown>,
	descriptions: {} as Record<string, string>,
});

// cf6dbf4 caller_ping description, verbatim.
const UPSTREAM_PING_DESCRIPTION =
	"Ask the launching chat for help, send your message there, then close this helper session. " +
	"The launching chat can later send follow-up instructions to continue this helper. Call it once.";
// cf6dbf4 subagent_done description, verbatim.
const UPSTREAM_DONE_DESCRIPTION =
	"Call this tool when you have completed your task. " +
	"It will close this session and return your results to the main session. " +
	"Your LAST assistant message before calling this becomes the summary returned to the caller.";

describe("auto-exit children end as in cf6dbf4 (T72, D01)", () => {
	// T72 review P1: caller_ping arms a real 750 ms process.exit backstop. Every suite of the aggregate
	// run (test/test.ts) shares this process, so the suite intercepts the exit until the last case.
	const exitCodes: unknown[] = [];
	let exitMock: ReturnType<typeof mock.method> | undefined;
	before(() => {
		exitMock = mock.method(process, "exit", ((code?: unknown) => void exitCodes.push(code)) as never);
	});
	after(() => exitMock?.mock.restore());

	it("a headless child without auto-exit gets no type from legacy completion arguments (T72 review)", async () => {
		const legacy = { outcome: "partial", summary: "LEGACY-SUMMARY", artifacts: ["/x"], data: { a: 1 } };
		const run = await runChild({
			autoExit: false,
			replies: [
				fauxAssistantMessage([{ type: "text", text: "FINAL-31 report." }, fauxToolCall(DONE, legacy, { id: "d1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("after the call"),
			],
		});
		const { record, report } = await watchAndPublish(run.sessionFile);
		assert.equal(record.typed, false);
		assert.equal(record.outcome, "done");
		assert.equal(record.summary, "FINAL-31 report.");
		assert.equal(report, "FINAL-31 report.");
		assert.deepEqual(record.artifacts, []);
	});

	it("a done+ping batch beside a tool that does not end the turn keeps the report before done (T72 review)", async () => {
		const run = await runChild({
			autoExit: false,
			replies: [
				fauxAssistantMessage(
					[
						{ type: "text", text: "REPORT-6 work so far." },
						fauxToolCall(DONE, {}, { id: "d1" }),
						fauxToolCall(CALLER_PING_TOOL_NAME, { message: "PING-MSG help" }, { id: "p1" }),
						fauxToolCall("read", { path: "missing-file.txt" }, { id: "r1" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("ACK-9 acknowledged."),
			],
		});
		assert.equal(run.unusedReplies, 0, "the read result gives the model one more turn");
		const { record, report } = await watchAndPublish(run.sessionFile);
		assert.equal(record.outcome, "done");
		assert.equal(record.summary, "REPORT-6 work so far.");
		assert.equal(report, "REPORT-6 work so far.");
	});
	for (const pane of [false, true]) {
		const surface = pane ? "pane" : "headless";
		it(`an auto-exit ${surface} child has no subagent_done, gets no nudge and exits after its answer, untyped`, async () => {
			const probe = newProbe();
			const run = await runChild({
				autoExit: true,
				pane,
				replies: [fauxAssistantMessage("ANSWER-17 all files fixed."), fauxAssistantMessage("never sent")],
				extensions: [toolProbe(probe)],
			});
			// cf6dbf4 getDeniedToolNames(autoExit=true) adds subagent_done; shouldRegisterSubagentDone is false.
			assert.equal(probe.active.includes(DONE), false);
			assert.equal(DONE in probe.params, false, "the tool is not registered");
			// cf6dbf4 registers caller_ping when !isInteractive || autoExit.
			assert.equal(probe.descriptions[CALLER_PING_TOOL_NAME], UPSTREAM_PING_DESCRIPTION);
			assert.equal(run.unusedReplies, 1, "no nudge: the model gets no second turn");
			assert.equal(run.shutdownRequests, 1, "the child requests its own shutdown after the answer");
			assert.equal((run.exitBeforeClose as { type?: string } | null)?.type, "done");
			const { record, report } = await watchAndPublish(run.sessionFile);
			assert.equal(record.typed, false);
			assert.equal(record.outcome, "done");
			assert.match(record.summary, /ANSWER-17/);
			assert.match(report, /ANSWER-17/);
		});
	}

	it("a headless child without auto-exit keeps the zero-argument subagent_done of cf6dbf4", async () => {
		const probe = newProbe();
		const run = await runChild({
			autoExit: false,
			replies: [
				fauxAssistantMessage([{ type: "text", text: "FINAL-22 done." }, fauxToolCall(DONE, {}, { id: "d1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("after the call"),
			],
			extensions: [toolProbe(probe)],
		});
		assert.ok(probe.active.includes(DONE));
		assert.equal(probe.descriptions[DONE], UPSTREAM_DONE_DESCRIPTION);
		assert.deepEqual(Object.keys((probe.params[DONE] as { properties?: object }).properties ?? {}), []);
		assert.equal(probe.descriptions[CALLER_PING_TOOL_NAME], UPSTREAM_PING_DESCRIPTION);
		assert.equal(run.shutdownRequests, 1);
		assert.equal((run.exitBeforeClose as { type?: string } | null)?.type, "done");
		const { record } = await watchAndPublish(run.sessionFile);
		assert.equal(record.typed, false);
		assert.equal(record.outcome, "done");
		assert.match(record.summary, /FINAL-22/);
	});

	it("a manual pane child has neither subagent_done nor caller_ping (T69, cf6dbf4)", async () => {
		const probe = newProbe();
		await runChild({
			autoExit: false,
			pane: true,
			replies: [fauxAssistantMessage("hello")],
			extensions: [toolProbe(probe)],
		});
		assert.equal(DONE in probe.params, false);
		assert.equal(CALLER_PING_TOOL_NAME in probe.params, false);
	});

	it("an autonomous caller_ping is typed blocked from the exit record, its message the report", async () => {
		const run = await runChild({
			autoExit: true,
			replies: [
				fauxAssistantMessage([fauxToolCall(CALLER_PING_TOOL_NAME, { message: "Need the API key." }, { id: "p1" })], {
					stopReason: "toolUse",
				}),
			],
		});
		assert.equal((run.exitBeforeClose as { type?: string } | null)?.type, "ping");
		const { record, report } = await watchAndPublish(run.sessionFile);
		assert.equal(record.typed, true);
		assert.equal(record.outcome, "blocked");
		assert.equal(record.summary, "Need the API key.");
		assert.equal(report, "Need the API key.");
	});

	// C38: done and ping in one parallel batch. Whichever wrote the exit record first wins; the other
	// call, refused by the sidecar, must not change the published verdict.
	for (const order of [
		["done", "ping"],
		["ping", "done"],
	] as const) {
		it(`a ${order.join("+")} batch publishes the verdict of the exit record that won (C38)`, async () => {
			const calls = {
				done: fauxToolCall(DONE, {}, { id: "d1" }),
				ping: fauxToolCall(CALLER_PING_TOOL_NAME, { message: "PING-MSG help" }, { id: "p1" }),
			};
			const run = await runChild({
				autoExit: false,
				replies: [
					fauxAssistantMessage([{ type: "text", text: "REPORT-5 work so far." }, ...order.map((k) => calls[k])], {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("after the batch"),
				],
			});
			// Pi executes the batch in order, so the first call writes the exit record.
			const winner = (run.exitBeforeClose as { type?: string } | null)?.type;
			assert.equal(winner, order[0]);
			assert.equal(run.unusedReplies, 1, "both calls end the turn: no acknowledgement turn");
			const { record, report } = await watchAndPublish(run.sessionFile);
			if (winner === "ping") {
				assert.equal(record.outcome, "blocked");
				assert.equal(record.summary, "PING-MSG help");
				assert.equal(report, "PING-MSG help");
			} else {
				assert.equal(record.outcome, "done", "a refused ping does not make the result blocked");
				assert.equal(record.typed, false);
				assert.equal(record.summary, "REPORT-5 work so far.");
				assert.equal(report, "REPORT-5 work so far.");
			}
		});
	}

	it("after a takeover, caller_ping writes no exit record and requests no shutdown before the close", async () => {
		const run = await runChild({
			autoExit: true,
			pane: true,
			replies: [
				afterKeyPress(
					fauxAssistantMessage([fauxToolCall(CALLER_PING_TOOL_NAME, { message: "Need the API key." }, { id: "p1" })], {
						stopReason: "toolUse",
					}),
				),
			],
		});
		assert.equal(run.exitBeforeClose, null, "the parent receives nothing before the close");
		assert.equal(run.shutdownRequests, 0, "the pane stays open");
		const { record } = await watchAndPublish(run.sessionFile);
		assert.equal(record.outcome, "blocked");
		assert.equal(record.summary, "Need the API key.");
	});

	it("a later assertion still runs after the caller_ping backstop delay (T72 review)", async () => {
		await new Promise((resolve) => setTimeout(resolve, 900));
		assert.ok(exitCodes.length > 0, "the ping backstop fired and was intercepted");
		assert.ok(exitCodes.every((code) => code === 0));
	});
});
