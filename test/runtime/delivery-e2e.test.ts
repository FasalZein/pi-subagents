import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { registerDeliveryQueue } from "../../src/runtime/delivery-queue.ts";
import { ResultStore, readResultRecord } from "../../src/runtime/result-files.ts";
import type { RunId } from "../../src/runtime/result-record.ts";
import {
	getSubagentBatchStopMetadata,
	markSubagentBatchBlocking,
	requestSubagentBatchStop,
} from "../../src/runtime/state.ts";
import { wireSubagentSteerBack } from "../../src/runtime/wiring.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { assert, createTestDir, describe, it, resetSubagentStateForTest } from "../support/index.ts";

// D15 at the extension boundary: a real Pi parent session with a faux provider. The child is a
// fake process under the real background watcher, and its end goes through the production wiring
// (wireSubagentSteerBack) and the production delivery queue, so the result files and the session's
// boundaries decide what the next model request carries.

interface Request {
	text: string;
	/** Whether the run's committed record and its report file were on disk when this request was built. */
	recordOnDisk: boolean;
}

interface Parent {
	pi: ExtensionAPI;
	requests: Request[];
	store: ResultStore;
	resultsDir: string;
	runIds: RunId[];
	/** What Alt+Up does: take every queued message out of Pi's steer and follow-up queues. */
	clearQueue(): void;
	pendingReplies(): number;
	prompt(text: string): Promise<void>;
	dispose(): Promise<void>;
}

const CHILD_NAME = "delivery-worker";

/** A child session file with a header and one assistant reply, the transcript the watcher reads. */
function childSessionFile(): string {
	const file = join(createTestDir(), "child.jsonl");
	const at = new Date().toISOString();
	const header = { type: "session", version: 3, id: "child", timestamp: at, cwd: "/" };
	const reply = {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: at,
		message: { role: "assistant", content: [{ type: "text", text: "Child report." }], timestamp: Date.now() },
	};
	writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(reply)}\n`);
	return file;
}

/** A watched child whose watcher fails: wires a rejected watch through the production wiring. */
function failWatcher(parent: Parent): RunId {
	const reservation = parent.store.reserve();
	parent.runIds.push(reservation.runId);
	const running = {
		id: reservation.runId,
		name: CHILD_NAME,
		task: "Work",
		agent: "scout",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile: childSessionFile(),
		resultTarget: { store: parent.store, reservation, parentCwd: createTestDir(), warnings: [] },
	} as unknown as RunningSubagent;
	wireSubagentSteerBack(parent.pi, running, Promise.reject(new Error("watcher broke")));
	return reservation.runId;
}

/** Starts a watched child and ends it at once; resolves after the end was routed. */
async function endWatchedChild(parent: Parent): Promise<string> {
	const reservation = parent.store.reserve();
	parent.runIds.push(reservation.runId);
	const child = new EventEmitter() as ChildProcess;
	const running = {
		id: reservation.runId,
		name: CHILD_NAME,
		task: "Work",
		agent: "scout",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile: childSessionFile(),
		childProcess: child,
		resultTarget: { store: parent.store, reservation, parentCwd: createTestDir(), warnings: [] },
	} as unknown as RunningSubagent;
	const watch = watchBackgroundSubagent(
		running,
		{ cleanupNoSessionSessionFile() {}, terminateBackgroundChildProcess() {} },
		new AbortController().signal,
	);
	wireSubagentSteerBack(parent.pi, running, watch);
	setTimeout(() => child.emit("exit", 0, null), 10);
	await watch;
	await new Promise((resolve) => setImmediate(resolve));
	return reservation.runId;
}

/**
 * A launch tool that sets the batch flags the way the subagent tool_call hook does and takes the
 * terminate flag from the same state the subagent tool reads. With clearQueue, the person presses
 * Alt+Up after the child ended and before the tool batch ends.
 */
function launchTool(
	parent: () => Parent,
	batch: "terminating" | "blocking",
	options: { clearQueue?: boolean } = {},
): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "launch_child",
			label: "launch_child",
			description: "Launches one child that ends at once.",
			parameters: Type.Object({}),
			async execute() {
				if (batch === "blocking") markSubagentBatchBlocking();
				requestSubagentBatchStop();
				await endWatchedChild(parent());
				if (options.clearQueue) parent().clearQueue();
				return {
					content: [{ type: "text", text: "launched" }],
					details: {},
					...getSubagentBatchStopMetadata(),
				};
			},
		});
	};
}

function recordAndReportOnDisk(resultsDir: string, runId: RunId): boolean {
	const record = readResultRecord(join(resultsDir, runId));
	return !!record && record.report.saved && existsSync(record.report.path);
}

function recordingReply(parent: () => Parent, text: string): FauxResponseStep {
	return (context) => {
		const p = parent();
		const runId = p.runIds.at(-1);
		p.requests.push({
			text: JSON.stringify(context.messages),
			recordOnDisk: runId ? recordAndReportOnDisk(p.resultsDir, runId) : false,
		});
		return fauxAssistantMessage(text);
	};
}

async function startParent(options: {
	replies: (parent: () => Parent) => FauxResponseStep[];
	extensions?: (parent: () => Parent) => ExtensionFactory[];
}): Promise<Parent> {
	const root = createTestDir();
	const agentDir = join(root, "agent");
	const faux = fauxProvider();
	let parent: Parent | undefined;
	const get = () => parent!;
	faux.setResponses(options.replies(get));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"),
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	let captured: ExtensionAPI | undefined;
	const capture: ExtensionFactory = (pi) => {
		captured = pi;
		registerDeliveryQueue(pi);
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		extensionFactories: [capture, ...(options.extensions?.(get) ?? [])],
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
		sessionManager: SessionManager.create(root, join(root, "sessions")),
	});
	await session.bindExtensions({});
	parent = {
		pi: captured!,
		requests: [],
		store: new ResultStore(join(root, "results"), () => {}),
		resultsDir: join(root, "results"),
		runIds: [],
		clearQueue: () => void session.clearQueue(),
		pendingReplies: () => faux.getPendingResponseCount(),
		prompt: (text) => session.prompt(text),
		async dispose() {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			resetSubagentStateForTest();
		},
	};
	return parent;
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!condition()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function carriesResult(request: Request | undefined, runId: string): boolean {
	// Pi hands a custom message to the provider as user text: the rendered header and footer.
	return !!request && request.text.includes(CHILD_NAME) && request.text.includes(`run: ${runId}`);
}

describe("delivery owner at the extension boundary (D15)", () => {
	it("R3: a child that ends in a terminating batch while the stop flag is set reaches the next request without user input (replay 3a)", async () => {
		const parent = await startParent({
			extensions: (p) => [launchTool(p, "terminating")],
			replies: (p) => [
				fauxAssistantMessage([fauxToolCall("launch_child", {}, { id: "l1" })], { stopReason: "toolUse" }),
				recordingReply(p, "Read the result."),
			],
		});
		try {
			await parent.prompt("delegate");
			assert.equal(parent.pendingReplies(), 0, "the result started a model request without a new prompt");
			assert.ok(carriesResult(parent.requests[0], parent.runIds[0]!), "the request carries the result message");
		} finally {
			await parent.dispose();
		}
	});

	it("R3: a child that ends in a blocking batch while the stop flag is set reaches the next request without user input (replay 3b)", async () => {
		const parent = await startParent({
			extensions: (p) => [launchTool(p, "blocking")],
			replies: (p) => [
				fauxAssistantMessage([fauxToolCall("launch_child", {}, { id: "l1" })], { stopReason: "toolUse" }),
				recordingReply(p, "Continue."),
				recordingReply(p, "Read the result."),
			],
		});
		try {
			await parent.prompt("delegate");
			assert.ok(
				carriesResult(parent.requests[0], parent.runIds[0]!),
				"the first request after the tool batch carries the result message",
			);
		} finally {
			await parent.dispose();
		}
	});

	it("R3: a result survives a cleared Pi queue (Alt+Up) during a blocking batch and reaches the first request after it", async () => {
		const parent = await startParent({
			extensions: (p) => [launchTool(p, "blocking", { clearQueue: true })],
			replies: (p) => [
				fauxAssistantMessage([fauxToolCall("launch_child", {}, { id: "l1" })], { stopReason: "toolUse" }),
				recordingReply(p, "Continue."),
				recordingReply(p, "Read the result."),
			],
		});
		try {
			await parent.prompt("delegate");
			assert.ok(
				carriesResult(parent.requests[0], parent.runIds[0]!),
				"the first request after the tool batch carries the result message",
			);
		} finally {
			await parent.dispose();
		}
	});

	it("R3: a child that ends while the parent is idle starts a parent turn", async () => {
		const parent = await startParent({
			replies: (p) => [fauxAssistantMessage("Nothing to do."), recordingReply(p, "Read the result.")],
		});
		try {
			await parent.prompt("hello");
			const runId = await endWatchedChild(parent);
			await waitFor(() => parent.requests.length === 1, "the turn that the result starts");
			assert.ok(carriesResult(parent.requests[0], runId), "the started turn carries the result message");
		} finally {
			await parent.dispose();
		}
	});

	it("R2: a watched run's result is in its files before it is handed over", async () => {
		const parent = await startParent({
			replies: (p) => [fauxAssistantMessage("Nothing to do."), recordingReply(p, "Read the result.")],
		});
		try {
			await parent.prompt("hello");
			const runId = await endWatchedChild(parent);
			await waitFor(() => parent.requests.length === 1, "the turn that the result starts");
			assert.ok(carriesResult(parent.requests[0], runId));
			assert.equal(
				parent.requests[0]!.recordOnDisk,
				true,
				"the committed record and its report file were on disk when the result was delivered",
			);
		} finally {
			await parent.dispose();
		}
	});

	it("R2: a watcher error publishes a failed record before it is handed over", async () => {
		const parent = await startParent({
			replies: (p) => [fauxAssistantMessage("Nothing to do."), recordingReply(p, "Read the result.")],
		});
		try {
			await parent.prompt("hello");
			const runId = failWatcher(parent);
			await waitFor(() => parent.requests.length === 1, "the turn that the result starts");
			assert.ok(carriesResult(parent.requests[0], runId));
			assert.equal(parent.requests[0]!.recordOnDisk, true, "the failed end was committed to disk first");
			assert.equal(readResultRecord(join(parent.resultsDir, runId))?.outcome, "failed");
		} finally {
			await parent.dispose();
		}
	});
});
