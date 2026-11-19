import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

function overlayCtx(sessionFile: string) {
	return { cwd: createTestDir(), sessionManager: { getSessionFile: () => sessionFile } } as never;
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

	it("an ephemeral run never offers resume", async () => {
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
		// The session file holds its message too, without a session file of its own.
		const file = sessionWith(dir, [
			{
				customType: "subagent_result",
				content: "done",
				details: { id: "ephemeral", name: "ephemeral", status: "completed" },
			},
		]);
		const items = await buildCompletedItems(overlayCtx(file));
		assert.equal(items.length, 1);
		assert.equal(items[0]?.canResume, false);
		completedSubagentResults.clear();
		assert.equal(
			(await buildCompletedItems(overlayCtx(file))).some((item) => item.canResume),
			false,
		);
	});
});
