import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleResult } from "../../src/runtime/result-assembler.ts";
import {
	publishResult,
	RECORD_FILE,
	readResultRecord,
	reserveRunId,
	ResultStore,
	type Reservation,
} from "../../src/runtime/result-files.ts";
import { parseRunId, type ResultRecord, type RunId } from "../../src/runtime/result-record.ts";
import { renderResult } from "../../src/runtime/result-render.ts";
import { assistant, facts, sessionHeader } from "../support/result-fixtures.ts";
import { after, assert, describe, it } from "../support/index.ts";

const roots: string[] = [];
function resultsDir(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "result-files-")));
	roots.push(root);
	return join(root, "results");
}

function runResult(runId: RunId, text: string, endedAt = 66_000) {
	return assembleResult(facts([sessionHeader(), assistant(text)], { runId, endedAt }));
}

function folderOf(reservation: Reservation): string {
	assert.ok(reservation.folder, "reservation has a folder");
	return reservation.folder;
}

/** D13 invariant: a committed record never names a missing report. */
function assertRecordNamesExistingReport(folder: string): ResultRecord | undefined {
	const record = readResultRecord(folder);
	if (record) {
		assert.ok(record.report.saved, "a committed record names a saved report");
		assert.ok(existsSync(record.report.path), "the named report exists");
	}
	return record;
}

/** The record as JSON stores it: fields set to undefined drop out. */
function asStored(record: ResultRecord): ResultRecord {
	return JSON.parse(JSON.stringify(record)) as ResultRecord;
}

const failingRename = {
	rename() {
		throw new Error("EIO: rename failed");
	},
};

describe("result files (D13)", () => {
	after(() => {
		for (const root of roots) {
			chmodSync(root, 0o700);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("writes a report and a record that names it when a run ends", () => {
		const reservation = reserveRunId(resultsDir());
		const folder = folderOf(reservation);
		const result = runResult(reservation.runId, "the full report");
		const published = publishResult(reservation, result);

		const record = assertRecordNamesExistingReport(folder);
		assert.deepStrictEqual(record, asStored(published));
		assert.ok(record?.report.saved);
		assert.equal(readFileSync(record.report.path, "utf8"), "the full report");
		assert.equal(record.runId, reservation.runId);
		assert.deepStrictEqual(readdirSync(folder).sort(), [RECORD_FILE, "report-1.md"]);
	});

	it("adds a report and switches the record for a second revision; a paused reader keeps its report", () => {
		const reservation = reserveRunId(resultsDir());
		const folder = folderOf(reservation);
		publishResult(reservation, runResult(reservation.runId, "revision one"));

		// The reader reads the record, then pauses before it opens the report.
		const seen = readResultRecord(folder);
		assert.ok(seen?.report.saved);
		publishResult(reservation, runResult(reservation.runId, "revision two", 99_000));

		assert.equal(readFileSync(seen.report.path, "utf8"), "revision one");
		const current = assertRecordNamesExistingReport(folder);
		assert.ok(current?.report.saved);
		assert.notEqual(current.report.path, seen.report.path);
		assert.equal(readFileSync(current.report.path, "utf8"), "revision two");
		assert.equal(current.endedAt, 99_000);
	});

	it("keeps the old record and its report when the rename of a new record fails", () => {
		const reservation = reserveRunId(resultsDir());
		const folder = folderOf(reservation);
		const old = publishResult(reservation, runResult(reservation.runId, "old report"));

		const failed = publishResult(reservation, runResult(reservation.runId, "new report", 99_000), failingRename);

		assert.deepStrictEqual(failed.report, { saved: false, error: "EIO: rename failed" });
		assert.deepStrictEqual(assertRecordNamesExistingReport(folder), asStored(old));
		assert.ok(old.report.saved);
		assert.equal(readFileSync(old.report.path, "utf8"), "old report");
		assert.deepStrictEqual(readdirSync(folder).sort(), [RECORD_FILE, "report-1.md"]);
	});

	it("leaves no record that names a missing report when the first write is interrupted", () => {
		const reservation = reserveRunId(resultsDir());
		const folder = folderOf(reservation);
		const failed = publishResult(reservation, runResult(reservation.runId, "lost"), failingRename);

		assert.equal(failed.report.saved, false);
		assert.equal(readResultRecord(folder), undefined);
		assert.deepStrictEqual(readdirSync(folder), []);
	});

	it("gives colliding draws different run ids, and no run replaces the files of another", () => {
		const dir = resultsDir();
		const draws = ["aaaa0001", "aaaa0001", "bbbb0002"].map(parseRunId);
		const draw = () => {
			const next = draws.shift();
			assert.ok(next, "enough draws");
			return next;
		};
		const first = reserveRunId(dir, draw);
		const second = reserveRunId(dir, draw);
		assert.equal(first.runId, "aaaa0001");
		assert.equal(second.runId, "bbbb0002");

		publishResult(first, runResult(first.runId, "first run"));
		publishResult(second, runResult(second.runId, "second run"));
		const a = assertRecordNamesExistingReport(folderOf(first));
		const b = assertRecordNamesExistingReport(folderOf(second));
		assert.ok(a?.report.saved && b?.report.saved);
		assert.equal(readFileSync(a.report.path, "utf8"), "first run");
		assert.equal(readFileSync(b.report.path, "utf8"), "second run");
	});

	it("degrades a read-only results folder to memory with one notice and no path in the text", () => {
		const dir = resultsDir();
		const root = join(dir, "..");
		chmodSync(root, 0o500);
		const notices: string[] = [];
		const store = new ResultStore(dir, (message) => notices.push(message));

		const records = [1, 2].map((n) => {
			const reservation = store.reserve();
			assert.equal(reservation.folder, undefined);
			return store.publish(reservation, runResult(reservation.runId, `summary of run ${n}`));
		});

		assert.equal(notices.length, 1, "one storage-failure notice");
		assert.equal(existsSync(dir), false);
		for (const [i, record] of records.entries()) {
			assert.equal(record.report.saved, false);
			assert.deepStrictEqual(store.read(record.runId), record, "the record stays in memory");
			const text = renderResult(record, { cwd: root, homeDir: "/nonexistent-home" });
			assert.match(text, /report not saved: /);
			assert.ok(text.includes(`summary of run ${i + 1}`));
			assert.ok(!text.includes(root) && !/report: /.test(text), `the text names no path: ${text}`);
		}
	});

	it("degrades a run folder that turns read-only before the run ends", () => {
		const notices: string[] = [];
		const store = new ResultStore(resultsDir(), (message) => notices.push(message));
		const reservation = store.reserve();
		chmodSync(folderOf(reservation), 0o500);

		const record = store.publish(reservation, runResult(reservation.runId, "kept summary"));
		const again = store.publish(reservation, runResult(reservation.runId, "kept summary", 99_000));

		assert.equal(record.report.saved, false);
		assert.equal(notices.length, 1);
		assert.deepStrictEqual(store.read(reservation.runId), again);
		const text = renderResult(record, { cwd: "/", homeDir: "/nonexistent-home" });
		assert.match(text, /report not saved: /);
		assert.ok(text.includes("kept summary"));
		chmodSync(folderOf(reservation), 0o700);
	});
});
