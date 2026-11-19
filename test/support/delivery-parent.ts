import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { registerDeliveryQueue } from "../../src/runtime/delivery-queue.ts";
import { ResultStore, readResultRecord } from "../../src/runtime/result-files.ts";
import type { RunId } from "../../src/runtime/result-record.ts";
import { wireSubagentSteerBack } from "../../src/runtime/wiring.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { createTestDir } from "./fixtures.ts";
import { resetSubagentStateForTest } from "./index.ts";
import { assert } from "./node.ts";

// A real Pi parent session with a faux provider for D15 delivery tests at the extension boundary.
// Children are fake processes under the real background watcher, routed by the production wiring.

export interface Request {
	text: string;
	/** Whether the run's committed record and its report file were on disk when this request was built. */
	recordOnDisk: boolean;
}

export interface Parent {
	pi: ExtensionAPI;
	requests: Request[];
	store: ResultStore;
	resultsDir: string;
	runIds: RunId[];
	/** What Alt+Up does: take every queued message out of Pi's steer and follow-up queues. */
	clearQueue(): void;
	pendingReplies(): number;
	/** The parent's session file on disk. */
	sessionFile(): string;
	prompt(text: string): Promise<void>;
	/** What Esc does: abort the running parent turn. */
	abort(): Promise<void>;
	dispose(): Promise<void>;
}

export const CHILD_NAME = "delivery-worker";

/** A child session file with a header and one assistant reply, the transcript the watcher reads. */
export function childSessionFile(): string {
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
export function failWatcher(parent: Parent, name = CHILD_NAME): RunId {
	const reservation = parent.store.reserve();
	parent.runIds.push(reservation.runId);
	const running = {
		id: reservation.runId,
		name,
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
export async function endWatchedChild(parent: Parent, name = CHILD_NAME, exitCode = 0): Promise<string> {
	const reservation = parent.store.reserve();
	parent.runIds.push(reservation.runId);
	const child = new EventEmitter() as ChildProcess;
	const running = {
		id: reservation.runId,
		name,
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
	setTimeout(() => child.emit("exit", exitCode, null), 10);
	await watch;
	await new Promise((resolve) => setImmediate(resolve));
	return reservation.runId;
}

export function recordAndReportOnDisk(resultsDir: string, runId: RunId): boolean {
	const record = readResultRecord(join(resultsDir, runId));
	return !!record && record.report.saved && existsSync(record.report.path);
}

export function recordingReply(parent: () => Parent, text: string): FauxResponseStep {
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

export async function startParent(options: {
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
		sessionFile: () => session.sessionManager.getSessionFile()!,
		prompt: (text) => session.prompt(text),
		abort: () => session.abort(),
		async dispose() {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			resetSubagentStateForTest();
		},
	};
	return parent;
}

export async function waitFor(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!condition()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
