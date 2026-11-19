import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Value } from "typebox/value";
import { getSessionResultsDir } from "../../src/artifact-storage.ts";
import { pendingRunEndCount } from "../../src/runtime/delivery-queue.ts";
import { outstandingWork } from "../../src/runtime/outstanding-work.ts";
import { assembleResult } from "../../src/runtime/result-assembler.ts";
import {
	LAUNCH_FILE,
	ResultStore,
	sessionResultStore,
	setResultStorageNotice,
} from "../../src/runtime/result-files.ts";
import type { RunId } from "../../src/runtime/result-record.ts";
import { RESULT_TEXT_MAX_CHARS } from "../../src/runtime/result-render.ts";
import { publishedResultFields, publishRunResult, type WatchedEnd } from "../../src/runtime/run-result.ts";
import { wireSubagentSteerBack } from "../../src/runtime/running-registry.ts";
import { runningSubagents } from "../../src/runtime/state.ts";
import {
	registerSubagentWaitTool,
	SubagentWaitOutput,
	type SubagentWaitStructured,
} from "../../src/tools/wait-tool.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";
import {
	assert,
	createTestDir,
	describe,
	it,
	resetSubagentStateForTest,
	setRunningSubagentForTest,
} from "../support/index.ts";
import { assistant, facts, sessionHeader, toolCall, toolResult, user } from "../support/result-fixtures.ts";

// T25 at the tool boundary: subagent_wait looks up a delivered run by its run id and lists the
// recent runs of this parent session (D16), from the results folder or from memory (D13).

let sessionCounter = 0;

/** A fresh parent session: its own working directory, session id and results folder. */
function parentSession(cwd = createTestDir()) {
	const sessionId = `t25-parent-${++sessionCounter}`;
	const ctx = { cwd, sessionManager: { getSessionId: () => sessionId } };
	return { cwd, sessionId, ctx, resultsDir: getSessionResultsDir(cwd, sessionId) };
}

// biome-ignore lint/suspicious/noExplicitAny: the captured definition is probed dynamically.
function waitTool(): any {
	// biome-ignore lint/suspicious/noExplicitAny: see above.
	let tool: any;
	registerSubagentWaitTool({ registerTool: (definition: unknown) => (tool = definition) } as never, () => true, {
		mayLaunch: () => true,
	});
	return tool;
}

interface Delivered {
	id: string;
	content: string;
}

/**
 * One headless run of this parent session that publishes a typed record into the session's results
 * folder when it ends, as its watcher does, and is routed to the parent by production routing.
 */
function startRun(session: ReturnType<typeof parentSession>, name: string, delivered: Delivered[]) {
	let finish!: (result: SubagentResult) => void;
	const watch = new Promise<SubagentResult>((resolve) => {
		finish = resolve;
	});
	const store = sessionResultStore(session.resultsDir);
	const reservation = store.reserve();
	const running = {
		id: reservation.runId,
		name,
		task: "t",
		agent: "worker-a",
		mode: "background",
		phase: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		blocking: false,
		async: true,
		startTime: Date.now(),
		completionPromise: watch,
		sessionFile: join(session.cwd, `${name}.jsonl`),
		resultTarget: { store, reservation, parentCwd: session.cwd, warnings: [] },
	} as RunningSubagent;
	setRunningSubagentForTest(running);
	const sink = {
		sendMessage: (message: { content: string; details: { id: string } }) => {
			delivered.push({ id: message.details.id, content: message.content });
		},
	};
	wireSubagentSteerBack(sink as never, running, watch, () => {});
	const end = (summary: string) => {
		const args = { outcome: "done", summary };
		const entries = [
			sessionHeader(),
			user("task"),
			toolCall("subagent_done", args, "d1"),
			toolResult("subagent_done", "d1", "ok"),
		];
		writeFileSync(running.sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const exitSignal: WatchedEnd["exitSignal"] = {
			reason: "done",
			exitCode: 0,
			acceptedCall: { toolCallId: "d1", args },
		};
		const published = publishRunResult(running, {
			exitCode: 0,
			operatorClosed: false,
			stopped: false,
			exitSignal,
			contextUsage: {},
		});
		finish({
			name,
			task: "t",
			summary,
			summarySource: "subagent",
			exitCode: 0,
			elapsed: 1,
			...publishedResultFields(published),
		});
	};
	return { runId: reservation.runId as string, end };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Publishes one record straight into a store, as a watcher of an earlier process did. */
function publishRecord(store: ResultStore, name: string, endedAt: number, summary = `SUMMARY OF ${name}`): RunId {
	const reservation = store.reserve();
	store.publish(
		reservation,
		assembleResult(facts([sessionHeader(), assistant(summary)], { runId: reservation.runId, name, endedAt })),
	);
	return reservation.runId;
}

/** The state a lookup must not change (D16). */
function deliveryState() {
	return { queued: pendingRunEndCount(), outstanding: outstandingWork.count };
}

describe("T25: lookup by run id", () => {
	it("check 1: a delivered run returns its rendering again, also after a reload, and changes no state", async () => {
		resetSubagentStateForTest();
		const unsubscribe = outstandingWork.subscribe(() => {});
		const session = parentSession();
		const delivered: Delivered[] = [];
		const run = startRun(session, "one", delivered);
		run.end("ONE-REPORT");
		await tick();
		assert.equal(delivered.length, 1, "the result went out by message");
		const tool = waitTool();
		const before = deliveryState();
		assert.equal(before.outstanding, 1, "the committed message has not released the run yet");

		// Same process (a compaction changes no extension state): the in-memory rendering.
		const again = await tool.execute("c1", { ids: [run.runId] }, undefined, undefined, session.ctx);
		assert.equal(again.content[0].text, delivered[0]!.content);
		assert.deepEqual(deliveryState(), before, "the lookup took nothing from the queue and released nothing");

		// A reload forgets this process's runs; the lookup reads the record file.
		resetSubagentStateForTest();
		const afterReload = deliveryState();
		const reloaded = await tool.execute("c2", { ids: [run.runId] }, undefined, undefined, session.ctx);
		const text = reloaded.content[0].text as string;
		assert.equal(text, delivered[0]!.content, "the same rendering from the record file");
		assert.ok(text.length <= RESULT_TEXT_MAX_CHARS);
		const structured = reloaded.structuredContent as SubagentWaitStructured;
		assert.ok(Value.Check(SubagentWaitOutput, structured));
		assert.equal(structured.status, "complete");
		assert.equal(structured.results[0]?.record?.runId, run.runId);
		assert.deepEqual(deliveryState(), afterReload);
		assert.equal(runningSubagents.size, 0, "nothing launched");
		unsubscribe();
	});

	it("check 1: a long summary is still capped at 1,900 characters by the lookup", async () => {
		resetSubagentStateForTest();
		const session = parentSession();
		const store = sessionResultStore(session.resultsDir);
		const runId = publishRecord(store, "long", 1_000, "x".repeat(5_000));
		const reply = await waitTool().execute("c1", { ids: [runId] }, undefined, undefined, session.ctx);
		assert.ok(reply.content[0].text.length <= RESULT_TEXT_MAX_CHARS);
		assert.match(reply.content[0].text, new RegExp(`run: ${runId}`));
	});

	it("check 5: a run id without a record gets no result record, with a known session file and never a made-up path", async () => {
		resetSubagentStateForTest();
		const session = parentSession();
		// The parent that launched the continue child exited; its launch note stays in the run folder.
		const earlier = new ResultStore(session.resultsDir, () => {});
		const childSession = join(session.cwd, "continue-child.jsonl");
		writeFileSync(childSession, "{}\n");
		const known = earlier.reserve();
		earlier.noteLaunch(known, childSession);
		const gone = earlier.reserve();
		earlier.noteLaunch(gone, join(session.cwd, "deleted.jsonl"));
		const noSession = earlier.reserve();
		earlier.noteLaunch(noSession, undefined);

		const tool = waitTool();
		const reply = await tool.execute(
			"c1",
			{ ids: [known.runId, gone.runId, noSession.runId, "feedbeef"] },
			undefined,
			undefined,
			session.ctx,
		);
		const missing = (reply.structuredContent as SubagentWaitStructured).missing;
		assert.deepEqual(missing, [
			{ id: known.runId, error: `No result record for "${known.runId}". Its session file: ${childSession}` },
			{ id: gone.runId, error: `No result record for "${gone.runId}".` },
			{ id: noSession.runId, error: `No result record for "${noSession.runId}".` },
			{ id: "feedbeef", error: 'No result record for "feedbeef".' },
		]);
		assert.equal((reply.structuredContent as SubagentWaitStructured).status, "empty");
		assert.equal(runningSubagents.size, 0, "nothing launched");
	});

	it("a failed launch gives back its run folder even after the launch note", () => {
		const session = parentSession();
		const store = new ResultStore(session.resultsDir, () => {});
		const reservation = store.reserve();
		store.noteLaunch(reservation, join(session.cwd, "child.jsonl"));
		assert.ok(existsSync(join(reservation.folder!, LAUNCH_FILE)));
		store.discard(reservation);
		assert.equal(existsSync(reservation.folder!), false);
		assert.equal(store.launchSessionFile(reservation.runId), undefined, "the rollback forgets the cached note");
	});
});

describe("T25: the recent list", () => {
	it("check 2: 25 ended runs give 20 lines, newest first, ties by run id, this session only, no full result", async () => {
		resetSubagentStateForTest();
		const session = parentSession();
		const store = sessionResultStore(session.resultsDir);
		const ids: { runId: RunId; endedAt: number }[] = [];
		for (let i = 0; i < 25; i++) {
			// Runs 10 and 11 end at the same moment; the store draws their ids at random.
			const endedAt = 1_700_000_000_000 + (i === 11 ? 10 : i) * 1_000;
			ids.push({ runId: publishRecord(store, `run-${i}`, endedAt), endedAt });
		}
		// Only the session id differs: the project folder is the same.
		const other = parentSession(session.cwd);
		publishRecord(sessionResultStore(other.resultsDir), "foreign-run", 1_800_000_000_000);
		const before = deliveryState();

		const reply = await waitTool().execute("c1", { recent: true, ids: ["ignored"] }, undefined, undefined, session.ctx);
		const text = reply.content[0].text as string;
		const lines = text.split("\n");
		assert.equal(lines.length, 20);
		assert.ok(text.length <= RESULT_TEXT_MAX_CHARS);
		const expected = [...ids]
			.sort((a, b) => b.endedAt - a.endedAt || (a.runId < b.runId ? -1 : 1))
			.slice(0, 20)
			.map((run) => run.runId);
		assert.deepEqual(
			lines.map((line) => line.split(" · ")[0]),
			expected,
		);
		assert.match(lines[0]!, /^\w+ · run-24 · done · 2023-11-14T22:13:44\.000Z$/);
		assert.doesNotMatch(text, /foreign-run|SUMMARY OF|report:/);
		const structured = reply.structuredContent as SubagentWaitStructured;
		assert.ok(Value.Check(SubagentWaitOutput, structured));
		assert.equal(structured.status, "recent");
		assert.deepEqual(
			structured.recent?.map((run) => run.runId),
			expected,
		);
		assert.deepEqual(structured.results, []);
		assert.deepEqual(deliveryState(), before, "the list changes no state");
	});

	it("check 4: with an unwritable results folder, recent and lookup return the result from memory", async () => {
		resetSubagentStateForTest();
		const notices: string[] = [];
		setResultStorageNotice((message) => notices.push(message));
		const session = parentSession();
		mkdirSync(dirname(session.resultsDir), { recursive: true });
		writeFileSync(session.resultsDir, "not a folder");
		const delivered: Delivered[] = [];
		const run = startRun(session, "mem", delivered);
		const tool = waitTool();
		const wait = tool.execute("w", { ids: [run.runId] }, undefined, undefined, session.ctx);
		await tick();
		run.end("MEMORY-REPORT");
		const waited = await wait;
		// The script throws without printing; the notice was shown outside it.
		assert.equal(notices.length, 1);
		assert.match(notices[0]!, /^Subagent results are kept in memory only: /);
		resetSubagentStateForTest();
		const recent = await tool.execute("r", { recent: true }, undefined, undefined, session.ctx);
		assert.match(recent.content[0].text, new RegExp(`^${run.runId} · mem · done · `));
		const lookup = await tool.execute("l", { ids: [run.runId] }, undefined, undefined, session.ctx);
		assert.equal(lookup.content[0].text, waited.content[0].text);
		assert.match(lookup.content[0].text, /MEMORY-REPORT[\s\S]*report not saved/);
		setResultStorageNotice(() => {});
	});
});
