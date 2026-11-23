import { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assembleResult } from "../../src/runtime/result-assembler.ts";
import { RECORD_FILE, ResultStore } from "../../src/runtime/result-files.ts";
import { parseRunId } from "../../src/runtime/result-record.ts";
import { recentRuns, renderRecentRuns } from "../../src/runtime/run-lookup.ts";
import { assert, createTestDir, describe, it } from "../support/index.ts";
import { assistant, facts, sessionHeader } from "../support/result-fixtures.ts";

// T25 fix round 1 (P2): the results folder is a file-read boundary. A lookup and the recent list
// trust only run folders inside it and records whose identity and shape match (D13, D16), and the
// launch note names only a session file that exists as a file.

function store(): { dir: string; store: ResultStore } {
	const dir = join(createTestDir(), "results");
	return { dir, store: new ResultStore(dir, () => {}) };
}

/** A valid published run folder for `name`, built in a scratch store, moved where the test wants it. */
function validRunFolder(name: string): { folder: string; runId: string } {
	const scratch = store().store;
	const reservation = scratch.reserve();
	scratch.publish(
		reservation,
		assembleResult(facts([sessionHeader(), assistant("text")], { runId: reservation.runId, name, endedAt: 5_000 })),
	);
	return { folder: reservation.folder!, runId: reservation.runId };
}

describe("T25 fix round 1: the launch note", () => {
	it("a rollback forgets the cached note", () => {
		const { store: results } = store();
		const sessionFile = join(createTestDir(), "child.jsonl");
		writeFileSync(sessionFile, "{}\n");
		const reservation = results.reserve();
		results.noteLaunch(reservation, sessionFile);
		results.discard(reservation);
		assert.equal(results.launchSessionFile(reservation.runId), undefined);
	});

	it("names only a target that is a file, from this process and from the run folder", () => {
		const { dir, store: results } = store();
		const notAFile = createTestDir();
		const removed = join(createTestDir(), "gone.jsonl");
		writeFileSync(removed, "{}\n");
		const folderTarget = results.reserve();
		results.noteLaunch(folderTarget, notAFile);
		const removedTarget = results.reserve();
		results.noteLaunch(removedTarget, removed);
		rmSync(removed);
		const restarted = new ResultStore(dir, () => {});
		for (const source of [results, restarted]) {
			assert.equal(source.launchSessionFile(folderTarget.runId), undefined, "a folder is no session file");
			assert.equal(source.launchSessionFile(removedTarget.runId), undefined, "a removed file is not named");
		}
	});
});

describe("T25 fix round 1: records at the file-read boundary", () => {
	it("a run folder that is a symlink out of the results folder is neither listed nor read", () => {
		const { dir, store: results } = store();
		mkdirSync(dir, { recursive: true });
		const outside = validRunFolder("outside-run");
		symlinkSync(outside.folder, join(dir, outside.runId));
		assert.deepEqual(results.list(), []);
		assert.equal(results.read(parseRunId(outside.runId)), undefined);
	});

	it("a record that names another run, or has no valid end time, is skipped and recent does not throw", () => {
		const { dir, store: results } = store();
		mkdirSync(dir, { recursive: true });
		const good = validRunFolder("good-run");
		renameSync(good.folder, join(dir, good.runId));
		const otherId = validRunFolder("other-run");
		renameSync(otherId.folder, join(dir, "feedbeef"));
		const broken = join(dir, "badc0ffe");
		mkdirSync(broken);
		writeFileSync(join(broken, RECORD_FILE), JSON.stringify({ runId: "badc0ffe", name: "broken", outcome: "done" }));
		assert.equal(results.read(parseRunId("feedbeef")), undefined, "the record names another run id");
		assert.equal(results.read(parseRunId("badc0ffe")), undefined, "the record has no valid shape");
		assert.deepEqual(
			recentRuns(results).map((run) => run.runId),
			[good.runId],
		);
	});

	it("a run reserved without a folder never reads another process's record or launch file of its id", () => {
		// M10-A: the folder of that id belongs to a run of another process (3.2 of the model).
		const { dir, store: results } = store();
		const runId = parseRunId("abcd0001");
		chmodSync(join(dir, ".."), 0o500);
		const own = results.reserve(() => runId);
		chmodSync(join(dir, ".."), 0o700);
		assert.equal(own.folder, undefined, "the own run has no folder");
		results.noteLaunch(own, undefined);

		// Another process on the same session folder draws the same id and publishes it.
		const other = new ResultStore(dir, () => {});
		const theirs = other.reserve(() => runId);
		assert.ok(theirs.folder, "the other process gets the folder");
		const sessionFile = join(createTestDir(), "other-child.jsonl");
		writeFileSync(sessionFile, "{}\n");
		other.noteLaunch(theirs, sessionFile);
		other.publish(theirs, assembleResult(facts([sessionHeader(), assistant("other run")], { runId, endedAt: 5_000 })));

		assert.equal(results.read(runId), undefined, "the other process's record is not this run's record");
		assert.equal(results.launchSessionFile(runId), undefined, "the other process's session file is not named");
		const mine = results.publish(
			own,
			assembleResult(facts([sessionHeader(), assistant("own run")], { runId, endedAt: 1_000 })),
		);
		assert.deepStrictEqual(results.read(runId), mine, "the own in-memory record, also with an earlier end time");
	});

	it("a name with line breaks stays on its one recent line", () => {
		const text = renderRecentRuns([{ runId: "abcd1234", name: "two\nlines\r\nhere", outcome: "done", endedAt: 0 }]);
		assert.equal(text, "abcd1234 · two lines here · done · 1970-01-01T00:00:00.000Z");
	});
});
