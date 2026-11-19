import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
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
import { restartSubagentForTimeoutWrapUp } from "../../src/runtime/timeout-wrap-up.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { getSubagentExitSidecarPath } from "../../src/session/exit-sidecar.ts";
import { PI_SUBAGENT_TIMEOUT_WRAP_UP } from "../../src/tools/timeout-reminders.ts";
import { CALLER_PING_TOOL_NAME, SUBAGENT_DONE_TOOL_NAME } from "../../src/tools/tool-names.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	assert,
	createTestDir,
	describe,
	isCompletionNudge,
	it,
	resetSubagentStateForTest,
	subagentDoneExtension,
	writeExecutable,
} from "../support/index.ts";

// D11 and D12 end to end: a real Pi session with a faux provider runs the child extension; the exit
// record, the real background watcher and the published result files decide the result.
const DONE = SUBAGENT_DONE_TOOL_NAME;
const ENV_KEYS = [
	"PI_SUBAGENT_SESSION",
	"PI_SUBAGENT_AUTO_EXIT",
	"PI_SUBAGENT_SURFACE",
	"PI_DENY_TOOLS",
	PI_SUBAGENT_TIMEOUT_WRAP_UP,
];

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
	/** D7: run as the report-only wrap-up continuation. */
	wrapUp?: boolean;
	/** Continue this session file in a new child process, as a time-limit restart does. */
	sessionFile?: string;
}): Promise<ChildRun> {
	const root = createTestDir();
	const agentDir = join(root, "agent");
	const sessionManager = options.sessionFile
		? SessionManager.open(options.sessionFile, join(root, "sessions"))
		: SessionManager.create(root, join(root, "sessions"));
	const sessionFile = sessionManager.getSessionFile()!;
	process.env.PI_SUBAGENT_SESSION = sessionFile;
	if (options.autoExit) process.env.PI_SUBAGENT_AUTO_EXIT = "1";
	if (options.pane) process.env.PI_SUBAGENT_SURFACE = "fake-pane";
	if (options.wrapUp) process.env[PI_SUBAGENT_TIMEOUT_WRAP_UP] = "1";
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
async function watchAndPublish(sessionFile: string, runningFields: Partial<RunningSubagent> = {}) {
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
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		childProcess: child,
		resultTarget: { store, reservation, parentCwd: root, warnings: [] },
		...runningFields,
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

	// B1 review (subagent-done.ts:493): Pi ends the turn only when every call of the batch terminates, so an
	// accepted call inside codemode or beside another tool gets an acknowledgement turn; the result stays typed.
	const REPORT = "REPORT-MARKER-91 the files under src are fixed.";
	const acknowledgement = fauxAssistantMessage("ACK-MARKER-44 Acknowledged: the session is closing.");

	const codemodeDone = fauxAssistantMessage(
		[
			{ type: "text", text: REPORT },
			fauxToolCall("codemode", { code: `await tools.${DONE}(${JSON.stringify(partial)});` }, { id: "cm1" }),
		],
		{ stopReason: "toolUse" },
	);

	it("a headless codemode completion stays typed with its pre-call report after an acknowledgement turn", async () => {
		const run = await runChild({
			autoExit: true,
			prompts: ["task"],
			replies: [codemodeDone, acknowledgement],
			extensions: [createCodemodeExtension({ mode: "on" })],
			defaultTools: ["+codemode"],
		});
		const { record, report } = await watchAndPublish(run.sessionFile);
		assert.equal(record.typed, true);
		assert.equal(record.outcome, "partial");
		assert.equal(record.summary, partial.summary);
		assert.match(report, /REPORT-MARKER-91/);
		assert.doesNotMatch(report, /ACK-MARKER-44/);
	});

	it("a headless direct completion beside a non-terminating tool stays typed after an acknowledgement turn", async () => {
		const run = await runChild({
			autoExit: true,
			prompts: ["task"],
			replies: [
				fauxAssistantMessage(
					[
						{ type: "text", text: REPORT },
						fauxToolCall("ls", { path: "." }, { id: "ls1" }),
						fauxToolCall(DONE, partial, { id: "c1" }),
					],
					{ stopReason: "toolUse" },
				),
				acknowledgement,
			],
		});
		const { record, report } = await watchAndPublish(run.sessionFile);
		assert.equal(record.typed, true);
		assert.equal(record.outcome, "partial");
		assert.match(report, /REPORT-MARKER-91/);
		assert.doesNotMatch(report, /ACK-MARKER-44/);
	});

	it("runs no tool after a final codemode completion: the next tool turn is blocked and ends the loop", async () => {
		const run = await runChild({
			autoExit: true,
			prompts: ["task"],
			replies: [
				codemodeDone,
				fauxAssistantMessage([fauxToolCall("codemode", { code: "await tools.ls({});" }, { id: "cm-after" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("A model turn after the blocked tool."),
			],
			extensions: [createCodemodeExtension({ mode: "on" })],
			defaultTools: ["+codemode"],
		});
		assert.equal(run.unusedReplies, 1, "the blocked tool batch ends the agent loop");
		assert.match(readFileSync(run.sessionFile, "utf8"), /accepted completion call/);
		const { record } = await watchAndPublish(run.sessionFile);
		assert.equal(record.typed, true);
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

/** The user messages of a child session that carry the missing-call nudge. */
function nudgeCount(sessionFile: string): number {
	return readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((entry) => entry.message?.role === "user")
		.filter((entry) => {
			const content = entry.message.content;
			const text = typeof content === "string" ? content : content.map((block: { text?: string }) => block.text ?? "").join("");
			return isCompletionNudge(text);
		})
		.length;
}

/** Ends each model run that started from the given text with one more extension-sent prompt. */
function extraModelRuns(count: number): ExtensionFactory {
	return (pi) => {
		let sent = 0;
		pi.on("agent_end", () => {
			if (sent >= count) return;
			sent += 1;
			pi.sendUserMessage(`extension follow-up ${sent}`, { deliverAs: "followUp" });
		});
	};
}

describe("one completion nudge, then an untyped result (D12)", () => {
	const longReport = Array.from({ length: 80 }, (_, i) => `Finding ${i + 1}: the module behaves as documented.`).join("\n");

	it("a long report, the nudge, then \"ok\": one nudge, an untyped done record, the report file holds the long report", async () => {
		const run = await runChild({
			autoExit: true,
			prompts: ["task"],
			replies: [fauxAssistantMessage(longReport), fauxAssistantMessage("ok"), fauxAssistantMessage("never sent")],
		});
		assert.equal(nudgeCount(run.sessionFile), 1, "exactly one nudge");
		assert.match(readFileSync(run.sessionFile, "utf8"), /Make only the call\./, "a run with a report is asked for the call alone");
		assert.equal(run.unusedReplies, 1, "the child exits after its answer to the nudge");
		assert.ok(run.shutdownRequests >= 1, "the child requests its exit");
		const { record, report } = await watchAndPublish(run.sessionFile);
		assert.equal(record.typed, false);
		assert.equal(record.outcome, "done", "a missing call is not an error");
		assert.equal(report, longReport);
	});

	it("exactly one nudge across several model runs", async () => {
		// Model runs: the report (nudged), the answer "ok", then two extension follow-ups.
		const run = await runChild({
			autoExit: true,
			prompts: ["task"],
			replies: [
				fauxAssistantMessage("Report."),
				fauxAssistantMessage("ok"),
				fauxAssistantMessage("still ok"),
				fauxAssistantMessage("still ok again"),
			],
			extensions: [extraModelRuns(3)],
		});
		assert.equal(run.unusedReplies, 0, "every model run took place");
		assert.equal(nudgeCount(run.sessionFile), 1, "one nudge per run");
	});

	it("a child that answers the nudge with the call ends typed", async () => {
		const run = await runChild({
			autoExit: true,
			prompts: ["task"],
			replies: [
				fauxAssistantMessage("Report written before the nudge."),
				fauxAssistantMessage([fauxToolCall(DONE, partial, { id: "c1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("never sent"),
			],
		});
		assert.equal(nudgeCount(run.sessionFile), 1);
		assert.equal(run.unusedReplies, 1);
		const { record, report } = await watchAndPublish(run.sessionFile);
		assert.equal(record.typed, true);
		assert.equal(record.outcome, "partial");
		assert.equal(record.summary, partial.summary);
		assert.equal(report, "Report written before the nudge.");
	});

	it("a child that makes the call without a nudge gets none", async () => {
		const run = await runChild({
			autoExit: true,
			prompts: ["task"],
			replies: [fauxAssistantMessage([fauxToolCall(DONE, partial, { id: "c1" })], { stopReason: "toolUse" })],
		});
		assert.equal(nudgeCount(run.sessionFile), 0);
	});

	it("a child in report-only wrap-up gets no nudge; after a time-limit restart its report wins over the nudged first process", async () => {
		// The first process writes A, gets the nudge, and the soft deadline interrupts its answer.
		const first = await runChild({
			autoExit: true,
			prompts: ["task"],
			replies: [
				fauxAssistantMessage("Report A from the first process."),
				fauxAssistantMessage([], { stopReason: "aborted" }),
			],
		});
		assert.equal(nudgeCount(first.sessionFile), 1, "the first process was nudged");
		// The real restart, with a stub Pi command; then the replacement runs on the same session.
		const dir = createTestDir();
		const savedPiCommand = process.env.PI_SUBAGENT_PI_COMMAND;
		process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(dir, "stub-pi", "#!/usr/bin/env bash\ncat > /dev/null\n");
		const timeoutWrapUp = { kind: "timeout" as const, seconds: 600, threshold: 80 };
		const startTime = Date.now() - 480_000;
		const running = {
			name: "worker",
			agent: "scout",
			mode: "background",
			parentClosePolicy: "terminate",
			startTime,
			sessionFile: first.sessionFile,
			timeoutBudget: { timeoutSeconds: 600 },
			timeoutWarnThreshold: 80,
			timeoutWrapUp,
			timeoutWrapUpDeadlineAt: startTime + 600_000,
			launchMetadata: {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "worker",
				agent: "scout",
				mode: "background",
				sessionMode: "fresh",
				autoExit: true,
				parentClosePolicy: "terminate",
				async: true,
				denyTools: [],
				spawnBudget: 0,
				spawnableAgents: false,
				noContextFiles: false,
				noSession: false,
				cwd: dir,
				timeout: 600,
				timeoutWarnThreshold: "80%",
			},
		} as unknown as RunningSubagent;
		try {
			await restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 });
			await once(running.childProcess!, "exit");
		} finally {
			if (savedPiCommand === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = savedPiCommand;
		}
		running.phase = "wrapping-up"; // as the watcher sets it after the restart
		const replacement = await runChild({
			autoExit: true,
			wrapUp: true,
			sessionFile: first.sessionFile,
			prompts: ["wrap up"],
			replies: [fauxAssistantMessage("Report B from the wrap-up."), fauxAssistantMessage("never sent")],
		});
		assert.equal(nudgeCount(first.sessionFile), 1, "the replacement gets no nudge");
		assert.equal(replacement.unusedReplies, 1);
		const { record, report } = await watchAndPublish(first.sessionFile, {
			startTime,
			timeoutWrapUp,
			phase: "wrapping-up",
			timeoutWrapUpDeadlineAt: startTime + 600_000,
			processEntryCount: running.processEntryCount,
		} as Partial<RunningSubagent>);
		assert.equal(record.typed, false);
		assert.equal(record.outcome, "timed_out");
		assert.deepEqual(record.timeLimit, { kind: "timeout", seconds: 600, wrapUp: true }, "the original deadline");
		assert.equal(report, "Report B from the wrap-up.");
	});

	it("after a person took over during the nudge answer, a manual close publishes the last text", async () => {
		const run = await runChild({
			autoExit: true,
			pane: true,
			prompts: ["task", "operator: fix the second finding"],
			replies: [
				fauxAssistantMessage("Report A."),
				afterKeyPress(fauxAssistantMessage("ok")),
				fauxAssistantMessage("Report B, corrected for the operator."),
			],
		});
		assert.equal(nudgeCount(run.sessionFile), 1);
		assert.equal(run.exitBeforeClose, null, "the person owns the pane");
		const { record, report } = await watchAndPublish(run.sessionFile);
		assert.equal(record.typed, false);
		assert.equal(report, "Report B, corrected for the operator.");
	});

	it("an autonomous pane child that answers the nudge with \"ok\" still publishes the report before the nudge", async () => {
		const run = await runChild({
			autoExit: true,
			pane: true,
			prompts: ["task"],
			replies: [fauxAssistantMessage("Report A."), fauxAssistantMessage("ok")],
		});
		assert.equal(nudgeCount(run.sessionFile), 1);
		const { report } = await watchAndPublish(run.sessionFile);
		assert.equal(report, "Report A.");
	});
});
