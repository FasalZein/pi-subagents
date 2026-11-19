import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSessionResultsDir } from "../../src/artifact-storage.ts";
import { sessionResultStore } from "../../src/runtime/result-files.ts";
import type { ResultOutcome, ResultRecord } from "../../src/runtime/result-record.ts";
import { groupRunEnds, type RunEndMessage } from "../../src/runtime/run-end-message.ts";
import { completedSubagentResults } from "../../src/runtime/state.ts";
import { buildCompletedItems } from "../../src/tools/overlay/data.ts";
import type { CompletedSubagentResult } from "../../src/types.ts";
import { afterEach, assert, createTestDir, describe, it, resetSubagentStateForTest } from "../support/index.ts";

// T22 (D15): the /subagents overlay reads run ends back from the parent session file, one row per
// run, from grouped messages and from old single-result and ping messages alike.

function sessionWith(dir: string, messages: Array<{ customType: string; content: string; details: object }>): string {
	const file = join(dir, "parent.jsonl");
	writeFileSync(
		file,
		messages.map((message) => JSON.stringify({ type: "custom_message", display: true, ...message })).join("\n") + "\n",
	);
	return file;
}

function overlayCtx(sessionFile: string, cwd = createTestDir()) {
	return { cwd, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => PARENT_SESSION_ID } } as never;
}

const PARENT_SESSION_ID = "parent-session";

/** Publishes one run's record in the parent session's results, as the production publisher does. */
function publishRecord(
	cwd: string,
	run: { name: string; outcome: ResultOutcome; summary: string; sessionFile: string; endedAt: number },
): ResultRecord {
	const store = sessionResultStore(getSessionResultsDir(cwd, PARENT_SESSION_ID));
	const reservation = store.reserve();
	return store.publish(reservation, {
		record: {
			runId: reservation.runId,
			name: run.name,
			agent: "worker",
			outcome: run.outcome,
			summary: run.summary,
			sessionFile: run.sessionFile,
			artifacts: [],
			endedAt: run.endedAt,
			elapsedSeconds: 2,
			exit: { code: 0 },
			resume: { resumable: true },
			typed: false,
		},
		report: run.summary,
	});
}

/** The cache entry of a completion that a message or the launch delivered. */
function cacheCompletion(record: ResultRecord, sessionFile: string): void {
	const id: string = record.runId;
	completedSubagentResults.set(id, {
		id,
		name: record.name,
		task: "t",
		summary: record.summary,
		exitCode: 0,
		elapsed: 2,
		status: "completed",
		sessionFile,
	} as CompletedSubagentResult);
}

describe("overlay rows from run-end messages (T22)", () => {
	afterEach(() => resetSubagentStateForTest());

	it("an old single-result and an old ping message each read back as a row with its resume target", async () => {
		const dir = createTestDir();
		const file = sessionWith(dir, [
			{
				customType: "subagent_result",
				content: "old result",
				details: {
					id: "old-1",
					name: "old-result",
					status: "completed",
					exitCode: 0,
					sessionFile: join(dir, "a.jsonl"),
				},
			},
			{
				customType: "subagent_ping",
				content: "help",
				details: { id: "old-2", name: "old-ping", message: "help", sessionFile: join(dir, "b.jsonl") },
			},
		]);
		const items = await buildCompletedItems(overlayCtx(file));
		const byName = new Map(items.map((item) => [item.name, item]));
		assert.equal(byName.get("old-result")?.sessionFile, join(dir, "a.jsonl"));
		assert.equal(byName.get("old-result")?.canResume, true);
		assert.equal(byName.get("old-ping")?.sessionFile, join(dir, "b.jsonl"));
		assert.equal(byName.get("old-ping")?.status, "blocked");
		assert.equal(items.length, 2);
	});

	it("a grouped message with done, blocked and failed reads back as three rows", async () => {
		const dir = createTestDir();
		const entry = (customType: RunEndMessage["customType"], id: string, details: object): RunEndMessage =>
			({
				customType,
				content: `${id} text`,
				display: true,
				details: { id, name: id, sessionFile: join(dir, `${id}.jsonl`), ...details },
			}) as RunEndMessage;
		const group = groupRunEnds([
			entry("subagent_result", "r-done", { status: "completed", outcome: "done", exitCode: 0 }),
			entry("subagent_ping", "r-blocked", { outcome: "blocked", message: "help" }),
			entry("subagent_result", "r-failed", { status: "failed", outcome: "failed", exitCode: 1 }),
		]);
		const items = await buildCompletedItems(overlayCtx(sessionWith(dir, [group])));
		assert.deepEqual(
			items.map((item) => [item.name, item.status, item.sessionFile, item.canResume]),
			[
				["r-done", undefined, join(dir, "r-done.jsonl"), true],
				["r-blocked", "blocked", join(dir, "r-blocked.jsonl"), true],
				["r-failed", "failed", join(dir, "r-failed.jsonl"), true],
			],
		);
	});

	it("an ephemeral run is a row without resume, before and after reload, grouped too", async () => {
		const dir = createTestDir();
		completedSubagentResults.set("ephemeral", {
			id: "ephemeral",
			name: "ephemeral",
			task: "t",
			summary: "done",
			exitCode: 0,
			elapsed: 1,
			status: "completed",
		} as CompletedSubagentResult);
		const group = groupRunEnds([
			{
				customType: "subagent_result",
				content: "e",
				display: true,
				details: { id: "ephemeral", name: "ephemeral", status: "completed" } as any,
			},
			{
				customType: "subagent_result",
				content: "g",
				display: true,
				details: { id: "grouped-eph", name: "grouped-eph", status: "completed" } as any,
			},
		]);
		const file = sessionWith(dir, [group]);
		const before = await buildCompletedItems(overlayCtx(file));
		assert.deepEqual(
			before.map((item) => [item.id, item.canResume]),
			[
				["ephemeral", false],
				["grouped-eph", false],
			],
		);
		// A reload keeps only the session file.
		completedSubagentResults.clear();
		const after = await buildCompletedItems(overlayCtx(file));
		assert.deepEqual(
			after.map((item) => [item.id, item.canResume]),
			[
				["ephemeral", false],
				["grouped-eph", false],
			],
		);
	});

	it("one session with a ping, then a resume that finishes: the newest run is the row before and after reload", async () => {
		const dir = createTestDir();
		const session = join(dir, "child.jsonl");
		const file = sessionWith(dir, [
			{
				customType: "subagent_ping",
				content: "help",
				details: { id: "run-1", name: "child", message: "help", sessionFile: session },
			},
			{
				customType: "subagent_result",
				content: "done",
				details: {
					id: "run-2",
					name: "child",
					status: "completed",
					outcome: "done",
					exitCode: 0,
					sessionFile: session,
				},
			},
		]);
		completedSubagentResults.set("run-2", {
			id: "run-2",
			name: "child",
			task: "t",
			summary: "done",
			exitCode: 0,
			elapsed: 1,
			status: "completed",
			sessionFile: session,
		} as CompletedSubagentResult);
		const rows = async () => (await buildCompletedItems(overlayCtx(file))).map((item) => [item.id, item.status]);
		assert.deepEqual(await rows(), [["run-2", undefined]]);
		completedSubagentResults.clear();
		assert.deepEqual(await rows(), [["run-2", undefined]]);
	});

	it("reads the summary line of a current result and of a legacy message after reload", async () => {
		const dir = createTestDir();
		const file = sessionWith(dir, [
			{
				customType: "subagent_result",
				content: "current · scout · done · 1s · typed\nThe current summary.\n\nSecond paragraph.\nrun: r-cur",
				details: {
					id: "r-cur",
					name: "current",
					status: "completed",
					runId: "r-cur",
					sessionFile: join(dir, "c.jsonl"),
				},
			},
			{
				customType: "subagent_result",
				content: "legacy header\n\nThe legacy summary.\n\nSession: /tmp/x.jsonl",
				details: { id: "r-old", name: "legacy", status: "completed", sessionFile: join(dir, "l.jsonl") },
			},
		]);
		const items = await buildCompletedItems(overlayCtx(file));
		assert.deepEqual(
			items.map((item) => item.activity),
			["The current summary.", "The legacy summary."],
		);
	});
});

describe("overlay rows from published records (g3 P1)", () => {
	afterEach(() => resetSubagentStateForTest());

	it("a completion, then a resumed ping on the same session: the row is the ping, before and after the cache clears", async () => {
		const dir = createTestDir();
		const cwd = createTestDir();
		const session = join(dir, "child.jsonl");
		const file = sessionWith(dir, []);
		const done = publishRecord(cwd, {
			name: "child",
			outcome: "done",
			summary: "FIRST DONE",
			sessionFile: session,
			endedAt: 1_000,
		});
		cacheCompletion(done, session);
		// The resumed run pings; a wait takes the ping, so neither the cache nor a message has it.
		const ping = publishRecord(cwd, {
			name: "child",
			outcome: "blocked",
			summary: "NEED HELP",
			sessionFile: session,
			endedAt: 2_000,
		});
		const rows = async () =>
			(await buildCompletedItems(overlayCtx(file, cwd))).map((item) => [
				item.id,
				item.status,
				item.activity,
				item.canResume,
			]);
		assert.deepEqual(await rows(), [[ping.runId, "blocked", "NEED HELP", true]]);
		completedSubagentResults.clear();
		assert.deepEqual(await rows(), [[ping.runId, "blocked", "NEED HELP", true]]);
	});

	it("a ping and a completion that only a wait took are rows, before and after the cache clears", async () => {
		const dir = createTestDir();
		const cwd = createTestDir();
		const file = sessionWith(dir, []);
		const ping = publishRecord(cwd, {
			name: "asker",
			outcome: "blocked",
			summary: "WHICH BRANCH",
			sessionFile: join(dir, "asker.jsonl"),
			endedAt: 1_000,
		});
		const done = publishRecord(cwd, {
			name: "worker",
			outcome: "done",
			summary: "ALL DONE",
			sessionFile: join(dir, "worker.jsonl"),
			endedAt: 2_000,
		});
		const expected = [
			[ping.runId, "blocked", "WHICH BRANCH", true],
			[done.runId, undefined, "ALL DONE", true],
		];
		const rows = async () =>
			(await buildCompletedItems(overlayCtx(file, cwd))).map((item) => [
				item.id,
				item.status,
				item.activity,
				item.canResume,
			]);
		assert.deepEqual(await rows(), expected);
		completedSubagentResults.clear();
		assert.deepEqual(await rows(), expected);
	});
});
