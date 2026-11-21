import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getSessionResultsDir } from "../../src/artifact-storage.ts";
import { sessionResultStore } from "../../src/runtime/result-files.ts";
import type { ResultOutcome, ResultRecord } from "../../src/runtime/result-record.ts";
import { groupRunEnds, type RunEndMessage } from "../../src/runtime/run-end-message.ts";
import { completedSubagentResults } from "../../src/runtime/state.ts";
import { ChildSessionStorage } from "../../src/session/child-session-storage.ts";
import {
	type PersistedSubagentLaunchMetadata,
	writeSubagentLaunchMetadataEntry,
} from "../../src/session/session-files.ts";
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
			endedBy: "child",
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
		summarySource: "subagent",
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

// T84 (D15): a fork child inherits the parent's branch, run ends included. Those stay readable as
// conversation, but the child's Completed tab lists only run ends after the child's own start.

function forkLaunchMetadata(cwd: string, model: string): PersistedSubagentLaunchMetadata {
	return {
		version: 1,
		timestamp: "2026-11-21T00:00:00.000Z",
		name: "fork-child",
		title: "Fork child",
		sessionTitle: "[worker] Fork child",
		agent: "worker",
		mode: "background",
		sessionMode: "fork",
		parentClosePolicy: "terminate",
		async: true,
		model,
		modelRef: model,
		allowModelOverride: true,
		modelSource: "launch-override",
		tools: "read",
		skills: "none",
		denyTools: [],
		extensions: [],
		noContextFiles: false,
		noSession: false,
		agentConfigDir: cwd,
		cwd,
		boundarySystemPrompt: true,
	};
}

const runEnd = (customType: string, id: string, extra: object = {}) => ({
	customType,
	content: `${id} text`,
	details: { id, name: id, status: "completed", exitCode: 0, sessionFile: `/runs/${id}.jsonl`, ...extra },
});

describe("fork child Completed rows (T84)", () => {
	afterEach(() => resetSubagentStateForTest());

	it("a fork lists only its own run ends, before and after a resume on another model", async () => {
		const dir = createTestDir();
		const parent = join(dir, "parent.jsonl");
		const ancestorResult = runEnd("subagent_result", "ancestor-result");
		const ancestorPing = runEnd("subagent_ping", "ancestor-ping", { message: "help" });
		const parentEntries = [
			{ type: "session", version: 3, id: "parent-session", timestamp: "2026-11-21T00:00:00.000Z", cwd: dir },
			{ type: "message", id: "u1", parentId: null, message: { role: "user", content: "go" } },
			{ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [] } },
			{ type: "custom_message", display: true, id: "r1", parentId: "a1", ...ancestorResult },
			{ type: "custom_message", display: true, id: "p1", parentId: "r1", ...ancestorPing },
		];
		writeFileSync(parent, `${parentEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		// The parent session itself (no fork seed) keeps every run end it holds.
		assert.deepEqual(
			(await buildCompletedItems(overlayCtx(parent))).map((item) => item.name),
			["ancestor-result", "ancestor-ping"],
		);

		// Seed and start the fork child as the launch coordinator does.
		const child = join(dir, "child.jsonl");
		const storage = new ChildSessionStorage(child);
		storage.seed("fork", parent, dir, { activeLeafId: "p1" });
		storage.writeModelState({ model: "provider-a/model-a" });
		await storage.writeLaunchMetadataWhenReady(forkLaunchMetadata(dir, "provider-a/model-a"), 0);
		const own = (customType: RunEndMessage["customType"], id: string) =>
			({ ...runEnd(customType, id), display: true }) as unknown as RunEndMessage;
		const group = groupRunEnds([own("subagent_result", "own-done"), own("subagent_ping", "own-ping")]);
		SessionManager.open(child, undefined, dir).appendCustomMessageEntry(
			group.customType,
			group.content,
			true,
			group.details,
		);
		const names = async () => (await buildCompletedItems(overlayCtx(child))).map((item) => item.name);
		assert.deepEqual(await names(), ["own-done", "own-ping"]);

		// A resume on another model appends model state and a second launch-metadata entry.
		storage.writeModelState({ model: "provider-b/model-b" });
		writeSubagentLaunchMetadataEntry(child, forkLaunchMetadata(dir, "provider-b/model-b"));
		const after = runEnd("subagent_result", "own-after-resume");
		SessionManager.open(child, undefined, dir).appendCustomMessageEntry(
			after.customType,
			after.content,
			true,
			after.details,
		);
		assert.deepEqual(await names(), ["own-done", "own-ping", "own-after-resume"]);
		// The inherited reports stay in the child's conversation.
		const conversation = SessionManager.open(child, undefined, dir).getEntries();
		assert.ok(conversation.some((entry) => JSON.stringify(entry).includes("ancestor-result text")));
	});
});
