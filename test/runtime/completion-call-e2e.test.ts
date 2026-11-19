import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createCodemodeExtension,
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

// D11 and D12 end to end: a real Pi session with a faux provider runs the child extension; the exit
// record, the real background watcher and the published result files decide the result.
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
 * Runs the child extension in a real Pi session; later prompts are operator input. The session
 * closes like a pane close: session_shutdown, then dispose.
 */
async function runChild(options: {
	autoExit: boolean;
	pane?: boolean;
	prompts: string[];
	replies: FauxResponseStep[];
	extensions?: ExtensionFactory[];
	/** The defaultTools setting, for example ["+codemode"]. */
	defaultTools?: string[];
}): Promise<ChildRun> {
	const root = createTestDir();
	const agentDir = join(root, "agent");
	const sessionManager = SessionManager.create(root, join(root, "sessions"));
	const sessionFile = sessionManager.getSessionFile()!;
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
		settingsManager: SettingsManager.inMemory(options.defaultTools ? { defaultTools: options.defaultTools } : {}),
		sessionManager,
	});
	let shutdownRequests = 0;
	let exitBeforeClose: unknown = null;
	try {
		await session.bindExtensions({
			shutdownHandler: () => void shutdownRequests++,
			...(options.pane ? { uiContext: paneUi as never } : {}),
		});
		for (const prompt of options.prompts) await session.prompt(prompt);
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
		executionState: "running",
		deliveryState: "detached",
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

const partial = { outcome: "partial", summary: "Half of the files are fixed." };

describe("completion call end to end (D11, D12)", () => {
	it("a headless child's accepted call ends the turn: no acknowledgement turn, a typed partial record", async () => {
		const run = await runChild({
			autoExit: true,
			prompts: ["task"],
			replies: [
				fauxAssistantMessage([fauxToolCall(DONE, partial, { id: "c1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Acknowledged: the session is closing."),
			],
		});
		assert.equal(run.unusedReplies, 1, "the model gets no turn after the accepted call");
		const { record, report } = await watchAndPublish(run.sessionFile);
		assert.equal(record.typed, true);
		assert.equal(record.outcome, "partial");
		assert.equal(record.summary, partial.summary);
		assert.match(report, /no report beyond the summary/);
	});

	it("a watcher that reads before Pi persists the tool result still publishes the typed record", async () => {
		// Snapshot the session file and the exit record at the end of tool execution, before Pi
		// writes the tool result: what a pane watcher polling at that moment reads.
		const snapshot = join(createTestDir(), "child.jsonl");
		const snapshotAtToolEnd: ExtensionFactory = (pi) => {
			pi.on("tool_execution_end", (event) => {
				if (event.toolName !== DONE) return;
				const sessionFile = process.env.PI_SUBAGENT_SESSION!;
				copyFileSync(sessionFile, snapshot);
				copyFileSync(getSubagentExitSidecarPath(sessionFile), getSubagentExitSidecarPath(snapshot));
			});
		};
		await runChild({
			autoExit: true,
			prompts: ["task"],
			replies: [fauxAssistantMessage([fauxToolCall(DONE, partial, { id: "c1" })], { stopReason: "toolUse" })],
			extensions: [snapshotAtToolEnd],
		});
		assert.doesNotMatch(readFileSync(snapshot, "utf8"), /"role":"toolResult"/, "the snapshot precedes the tool result");
		const { record } = await watchAndPublish(snapshot);
		assert.equal(record.typed, true);
		assert.equal(record.outcome, "partial");
		assert.equal(record.summary, partial.summary);
	});

	describe("after a takeover, a codemode call with data over Pi's 8 KiB nested-argument limit", () => {
		const data = { blob: "x".repeat(9_000) };
		const script = `await tools.${DONE}(${JSON.stringify({ ...partial, data })});`;
		const takeoverRun = (extraReplies: FauxResponseStep[], extraPrompts: string[]) =>
			runChild({
				autoExit: true,
				pane: true,
				prompts: ["task", ...extraPrompts],
				replies: [
					afterKeyPress(
						fauxAssistantMessage([fauxToolCall("codemode", { code: script }, { id: "cm1" })], {
							stopReason: "toolUse",
						}),
					),
					...extraReplies,
				],
				extensions: [createCodemodeExtension({ mode: "on" })],
				defaultTools: ["+codemode"],
			});

		it("writes no exit record and requests no shutdown; a close at once publishes the typed record with data", async () => {
			const run = await takeoverRun([], []);
			assert.equal(run.exitBeforeClose, null, "no exit record before the close");
			assert.equal(run.shutdownRequests, 0, "the pane stays open");
			const session = readFileSync(run.sessionFile, "utf8");
			assert.match(session, /"argumentsBytes"/, "Pi omitted the nested arguments");
			const { record } = await watchAndPublish(run.sessionFile);
			assert.equal(record.typed, true);
			assert.equal(record.outcome, "partial");
			assert.equal(record.summary, partial.summary);
			assert.deepEqual(record.data, data);
		});

		it("a close after later text publishes an untyped record from the last text", async () => {
			const run = await takeoverRun([fauxAssistantMessage("last words")], ["operator: thanks"]);
			const { record, report } = await watchAndPublish(run.sessionFile);
			assert.equal(record.typed, false);
			assert.equal(report, "last words");
		});
	});

	it("after a takeover, caller_ping writes no exit record and requests no shutdown before the close", async () => {
		const run = await runChild({
			autoExit: true,
			pane: true,
			prompts: ["task"],
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
});
