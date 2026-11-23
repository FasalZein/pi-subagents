import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { watchSubagent } from "../../src/runtime/interactive-watch.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { TIME_LIMIT_GUIDANCE, TIME_LIMIT_NO_RESUME_GUIDANCE, WRAP_UP_NOTICE } from "../../src/runtime/result-render.ts";
import { settleVerdictAfterRun } from "../../src/runtime/resume-guards.ts";
import {
	publishRunResult,
	STOPPED_REASON,
	TIME_LIMIT_RESUME_REASON,
	type WatchedEnd,
} from "../../src/runtime/run-result.ts";
import { stopRunningSubagent, wireSubagentSteerBack } from "../../src/runtime/running-registry.ts";
import { writeSubagentExitSidecar } from "../../src/session/exit-sidecar.ts";
import { readSubagentTimeoutSidecar } from "../../src/session/timeout-sidecar.ts";
import { registerSubagentKillTool } from "../../src/tools/kill-tool.ts";
import { CALLER_PING_TOOL_NAME, SUBAGENT_DONE_TOOL_NAME } from "../../src/tools/tool-names.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";
import {
	afterEach,
	assert,
	createSessionFile,
	createTestDir,
	describe,
	getCompletedSubagentResultForTest,
	it,
	resetSubagentStateForTest,
	rmSync,
	setRunningSubagentForTest,
	sleep,
} from "../support/index.ts";
import { waitText } from "../support/result-delivery.ts";
import { assistant, toolCall, toolResult } from "../support/result-fixtures.ts";

const dirs: string[] = [];

function setup(entries: object[], overrides: Partial<RunningSubagent> = {}) {
	const root = createTestDir();
	dirs.push(root);
	const sessionFile = createSessionFile(root, entries);
	const store = new ResultStore(join(root, "results"), () => {});
	const reservation = store.reserve();
	const running: RunningSubagent = {
		id: reservation.runId,
		name: "worker",
		task: "Work",
		agent: "scout",
		mode: "background",
		phase: { kind: "running" },
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		resultTarget: { store, reservation, parentCwd: root, warnings: [] },
		...overrides,
	} as RunningSubagent;
	return { running, store, reservation, sessionFile };
}

const DONE_CALL = [
	toolCall(SUBAGENT_DONE_TOOL_NAME, { outcome: "done", summary: "All work finished." }, "done-1", "Here is the work."),
	toolResult(SUBAGENT_DONE_TOOL_NAME, "done-1", "ok"),
];

/**
 * Replay 5 (bugpath-replay.md, red on cf6dbf4): the real subagent_kill tool stops a running headless
 * child, then the dying child exits. D7: the stop decides the outcome, whatever the child wrote.
 */
async function killReplay(exitWith: (child: ChildProcess, sessionFile: string) => void, published: boolean) {
	const { running, store, reservation, sessionFile } = setup(published ? DONE_CALL : []);
	if (!published) running.resultTarget = undefined;
	const child = new EventEmitter() as ChildProcess; // no pid: no real process is signalled
	running.childProcess = child;
	setRunningSubagentForTest(running);
	const ac = new AbortController();
	running.abortController = ac;
	const watch = watchBackgroundSubagent(
		running,
		{ cleanupNoSessionSessionFile() {}, terminateBackgroundChildProcess() {} },
		ac.signal,
	);
	running.completionPromise = watch;
	const sent: Array<{ content: string; customType: string }> = [];
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const pi = {
		registerTool(definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
			tools.set(definition.name, definition);
			return definition;
		},
		getThinkingLevel: () => "low",
		sendMessage(message: { content: string; customType: string }) {
			sent.push(message);
		},
	};
	registerSubagentKillTool(
		pi as never,
		() => true,
		async (r: RunningSubagent) => {
			await stopRunningSubagent(r, async () => {});
		},
	);
	wireSubagentSteerBack(pi as never, running, watch, () => {});
	try {
		await tools.get("subagent_kill")!.execute("k1", { runId: running.id }, undefined, undefined, {});
		assert.ok(ac.signal.aborted);
	} catch (error) {
		// A failed stop must not leave the watcher pending: it would keep node --test alive.
		ac.abort();
		child.emit("exit", null, "SIGTERM");
		await watch.catch(() => {});
		throw error;
	}
	exitWith(child, sessionFile);
	const routed = await watch;
	await sleep(10);
	return {
		running,
		routed,
		cached: getCompletedSubagentResultForTest(running.id)!,
		sent,
		record: store.read(reservation.runId),
	};
}

const exitZeroWithDone = (child: ChildProcess, sessionFile: string) => {
	writeSubagentExitSidecar(sessionFile, { type: "done" });
	child.emit("exit", 0, null);
};
const exitBySignal = (child: ChildProcess) => {
	child.emit("exit", null, "SIGTERM");
};

function watchedEnd(overrides: Partial<WatchedEnd> = {}): WatchedEnd {
	return { exitCode: 0, operatorClosed: false, closedByPerson: false, stopped: false, exitSignal: undefined, contextUsage: {}, ...overrides };
}

describe("end outcomes (T09)", () => {
	afterEach(() => {
		resetSubagentStateForTest();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("files a stopped headless child with exit 0 and a done record as cancelled (replay 5a)", async () => {
		const { routed, cached, sent } = await killReplay(exitZeroWithDone, false);
		assert.equal(routed.error, "cancelled");
		assert.equal(cached.status, "cancelled");
		assert.equal(sent.length, 1);
		assert.match(sent[0].content, /^worker · scout · cancelled · /);
	});

	it("files a stopped headless child that exits by signal without a record as cancelled (replay 5b)", async () => {
		const { routed, cached, sent } = await killReplay(exitBySignal, false);
		assert.equal(routed.error, "cancelled");
		assert.equal(cached.status, "cancelled");
		assert.match(sent[0].content, /^worker · scout · cancelled · /);
	});

	for (const [label, exitWith] of [
		["exit 0 and a done record", exitZeroWithDone],
		["a signal exit without a record", exitBySignal],
	] as const) {
		it(`renders a stopped child with ${label} as a cancelled record on both carriers`, async () => {
			const { running, routed, cached, sent, record } = await killReplay(exitWith, true);
			assert.equal(record?.outcome, "cancelled");
			assert.equal(record?.typed, false, "a stop decides over the completion call");
			assert.equal(cached.status, "cancelled");
			assert.match(routed.resultText ?? "", /^worker · scout · cancelled · /);
			assert.equal(sent[0].content, routed.resultText);
			assert.equal(await waitText(routed, running), routed.resultText);
		});
	}

	it("renders a stopped pane child that wrote a done record as cancelled", async () => {
		const savedMux = process.env.PI_SUBAGENT_MUX;
		process.env.PI_SUBAGENT_MUX = "tmux";
		try {
			const { running, store, reservation, sessionFile } = setup(DONE_CALL, {
				mode: "interactive",
				surface: "pi-subagents-nonexistent-surface",
			});
			const ac = new AbortController();
			const result = await watchSubagent(
				running,
				{
					cleanupNoSessionSessionFile() {},
					async closeRunningSurface() {},
					async pollForExit() {
						ac.abort();
						writeSubagentExitSidecar(sessionFile, { type: "done" });
						return { reason: "sentinel", exitCode: 0 };
					},
				} as never,
				ac.signal,
			);
			assert.equal(result.error, "cancelled");
			assert.equal(store.read(reservation.runId)?.outcome, "cancelled");
			assert.match(result.resultText ?? "", /^worker · scout · cancelled · /);
		} finally {
			if (savedMux === undefined) delete process.env.PI_SUBAGENT_MUX;
			else process.env.PI_SUBAGENT_MUX = savedMux;
		}
	});

	it("renders a time-limit kill as timed out with one line of guidance", () => {
		const { running, store, reservation } = setup([assistant("Partial work.")]);
		const published = publishRunResult(
			running,
			watchedEnd({ exitCode: 1, timedOut: { kind: "timeout", seconds: 60 } }),
		);
		const record = store.read(reservation.runId);
		assert.equal(record?.outcome, "timed_out");
		assert.deepEqual(record?.timeLimit, { kind: "timeout", seconds: 60, wrapUp: false });
		const lines = published!.text.split("\n");
		assert.match(lines[0], /· timed out ·/);
		assert.deepEqual(
			lines.filter((l) => l.startsWith("time limit")),
			[`time limit: 60s for the whole run: ${TIME_LIMIT_GUIDANCE}`],
		);
		assert.ok(!published!.text.includes("not resumable"));
	});

	it("renders an idle kill whose agent forbids resume with its reason and guidance", () => {
		const { running } = setup([], { timeoutBlocksResume: true });
		const published = publishRunResult(
			running,
			watchedEnd({ exitCode: 1, timedOut: { kind: "idle-timeout", seconds: 30 } }),
		);
		assert.equal(published?.record.outcome, "timed_out");
		assert.deepEqual(published?.record.resume, { resumable: false, reason: TIME_LIMIT_RESUME_REASON });
		assert.ok(published!.text.includes(`time limit: 30s without output: ${TIME_LIMIT_NO_RESUME_GUIDANCE}`));
		assert.ok(published!.text.includes(`not resumable: ${TIME_LIMIT_RESUME_REASON}`));
	});

	it("keeps the notice of a report-only wrap-up", () => {
		const { running } = setup(DONE_CALL, {
			phase: {
				kind: "wrapping-up",
				wrapUp: { wrapUp: { kind: "timeout", seconds: 100, threshold: 80 }, deadlineAt: 0 },
			},
		});
		const published = publishRunResult(running, watchedEnd());
		// T77 (D21): cf6dbf4 filed a finished wrap-up as completed; a report-only wrap-up stays untyped.
		assert.equal(published?.record.outcome, "done");
		assert.equal(published?.record.typed, false);
		assert.deepEqual(published?.record.timeLimit, { kind: "timeout", seconds: 100, wrapUp: true });
		assert.ok(published!.text.includes(`wrap-up: 100s for the whole run: ${WRAP_UP_NOTICE}`));
	});

	it("publishes a ping as a typed blocked record with the full message as its report", () => {
		const message = `I need the API key location.\n${"detail ".repeat(400)}`;
		const { running, store, reservation } = setup([toolCall(CALLER_PING_TOOL_NAME, { message }, "ping-1")]);
		const published = publishRunResult(
			running,
			watchedEnd({ ping: { message }, timedOut: { kind: "timeout", seconds: 60 } }),
		);
		const record = store.read(reservation.runId);
		assert.equal(record?.outcome, "blocked", "a ping outranks the time-limit kill");
		assert.equal(record?.typed, true);
		assert.ok(record!.summary.length < message.length, "only the summary is cut");
		assert.ok(record!.report.saved);
		assert.equal(readFileSync(record!.report.path, "utf8"), message);
		assert.match(published!.text, /^worker · scout · blocked · .* · typed/);
	});

	it("publishes a watcher error as a failed record", () => {
		const { running } = setup([assistant("Partial.")]);
		const published = publishRunResult(running, watchedEnd({ exitCode: 1, errorMessage: "provider quota exhausted" }));
		assert.equal(published?.record.outcome, "failed");
		assert.equal(published?.record.exit.error, "provider quota exhausted");
	});

	it("names the stop as the cancel reason when the child left no text", () => {
		const { running } = setup([]);
		const published = publishRunResult(running, watchedEnd({ stopped: true, ping: { message: "help" } }));
		assert.equal(published?.record.outcome, "cancelled");
		assert.equal(published?.record.summary, `cancelled: ${STOPPED_REASON}`);
	});

	// Review b2 g1 P1: a person took over a resumed pane; the child called subagent_done(done), which
	// recorded the call in the session but wrote no exit record, and the pane stayed open until the
	// hard deadline closed it. The call never ended the run, so the deadline did (D7) and its
	// block-resume verdict stays (D8).
	it("files a taken-over pane whose recorded call never ended the run as timed out at the hard deadline", async () => {
		const savedMux = process.env.PI_SUBAGENT_MUX;
		process.env.PI_SUBAGENT_MUX = "tmux";
		try {
			const { running, store, reservation, sessionFile } = setup(DONE_CALL, {
				mode: "interactive",
				surface: "pi-subagents-nonexistent-surface",
				autoExit: false,
				startTime: Date.now() - 2000,
				timeoutBudget: { timeoutSeconds: 1 },
				timeoutBlocksResume: true,
			});
			let closed!: () => void;
			const surfaceClosed = new Promise<void>((resolve) => {
				closed = resolve;
			});
			const result = await watchSubagent(
				running,
				{
					cleanupNoSessionSessionFile() {},
					async closeRunningSurface() {
						closed();
					},
					async pollForExit() {
						await surfaceClosed;
						return { reason: "sentinel", exitCode: 0 };
					},
				} as never,
				new AbortController().signal,
			);
			const record = store.read(reservation.runId);
			assert.equal(record?.outcome, "timed_out");
			assert.equal(record?.typed, false);
			assert.equal(result.resultOutcome, "timed_out");
			settleVerdictAfterRun(sessionFile, result);
			assert.deepEqual(readSubagentTimeoutSidecar(sessionFile), {
				kind: "timeout",
				blocksResume: true,
				budget: { timeoutSeconds: 1 },
			});
		} finally {
			if (savedMux === undefined) delete process.env.PI_SUBAGENT_MUX;
			else process.env.PI_SUBAGENT_MUX = savedMux;
		}
	});

	it("keeps the own outcome of a child that completed before the hard deadline and is alive at it", async () => {
		const { running, store, reservation, sessionFile } = setup(DONE_CALL, { timeoutBudget: { timeoutSeconds: 1 } });
		writeSubagentExitSidecar(sessionFile, { type: "done" });
		const child = new EventEmitter() as ChildProcess;
		running.childProcess = child;
		const signals: string[] = [];
		const result = watchBackgroundSubagent(
			running,
			{ cleanupNoSessionSessionFile() {}, terminateBackgroundChildProcess: (_r, s) => void signals.push(s) },
			new AbortController().signal,
		);
		await sleep(1600);
		child.emit("exit", 0, null);
		const routed: SubagentResult = await result;
		assert.deepEqual(signals, [], "the child is not killed after its completion");
		assert.equal(routed.timedOut, undefined);
		const record = store.read(reservation.runId);
		assert.equal(record?.outcome, "done");
		assert.equal(record?.typed, true);
		assert.equal(record?.timeLimit, undefined);
	});
});
