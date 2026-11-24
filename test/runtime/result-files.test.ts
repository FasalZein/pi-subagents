import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleResult } from "../../src/runtime/result-assembler.ts";
import {
	publishResult,
	RECORD_FILE,
	type Reservation,
	ResultStore,
	readResultRecord,
	reserveRunId,
} from "../../src/runtime/result-files.ts";
import { parseRunId, type ResultRecord, type RunId } from "../../src/runtime/result-record.ts";
import { renderResult } from "../../src/runtime/result-render.ts";
import { after, assert, describe, it } from "../support/index.ts";
import { assistant, facts, sessionHeader } from "../support/result-fixtures.ts";

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

const srcUrl = (path: string) => new URL(`../../${path}`, import.meta.url).href;

/**
 * Publishes one run whose report is `text` in a child process whose file-size limit is 1 KiB
 * (`ulimit -f 1`): a write that crosses the limit writes part of its bytes and returns (a short
 * write); the next write fails with EFBIG. Returns the published record and the folder's files.
 */
function publishUnderFileSizeLimit(text: string): { record: ResultRecord; files: Record<string, string> } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "result-files-limit-")));
	roots.push(root);
	const script = join(root, "publish.mjs");
	writeFileSync(
		script,
		`import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assembleResult } from ${JSON.stringify(srcUrl("src/runtime/result-assembler.ts"))};
import { publishResult, reserveRunId } from ${JSON.stringify(srcUrl("src/runtime/result-files.ts"))};
import { assistant, facts, sessionHeader } from ${JSON.stringify(srcUrl("test/support/result-fixtures.ts"))};
const reservation = reserveRunId(join(process.argv[2], "results"));
const text = readFileSync(join(process.argv[2], "input.txt"), "utf8");
const record = publishResult(reservation, assembleResult(facts([sessionHeader(), assistant(text)], { runId: reservation.runId })));
const files = Object.fromEntries(readdirSync(reservation.folder).map((name) => [name, readFileSync(join(reservation.folder, name), "utf8")]));
process.stdout.write(JSON.stringify({ record, files }));
`,
	);
	writeFileSync(join(root, "input.txt"), text);
	const child = spawnSync("bash", ["-c", 'ulimit -f 1 && exec "$0" "$1" "$2"', process.execPath, script, root], {
		encoding: "utf8",
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout) as { record: ResultRecord; files: Record<string, string> };
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

	it("commits no truncated report when a write of the report is short", () => {
		const text = "r".repeat(3000);
		const { record, files } = publishUnderFileSizeLimit(text);

		assert.equal(record.report.saved, false, "a report that does not fit is not saved");
		assert.deepStrictEqual(files, {}, "no record and no partial report stay");
	});

	it("commits no truncated record when a write of the record is short", () => {
		// The report (900 bytes) fits under 1 KiB; the record holds the summary and more, so it does not.
		const text = "s".repeat(900);
		const { record, files } = publishUnderFileSizeLimit(text);

		assert.equal(record.report.saved, false, "a record that does not fit is not committed");
		assert.deepStrictEqual(files, {}, "no record and no unnamed report stay");
	});

	it("keeps the result in memory when cleanup of a failed write also fails", () => {
		const notices: string[] = [];
		const store = new ResultStore(resultsDir(), (message) => notices.push(message));
		const reservation = store.reserve();
		const folder = folderOf(reservation);
		// A non-directory now occupies the reserved path: the writes and their cleanup both fail.
		rmdirSync(folder);
		writeFileSync(folder, "not a folder");

		const record = store.publish(reservation, runResult(reservation.runId, "summary after a lost folder"));

		assert.equal(record.report.saved, false);
		assert.equal(notices.length, 1);
		assert.deepStrictEqual(store.read(reservation.runId), record, "the record stays in memory");
		const text = renderResult(record, { cwd: "/", homeDir: "/nonexistent-home" });
		assert.match(text, /report not saved: /);
		assert.ok(text.includes("summary after a lost folder"));
	});

	it("reads the revision it delivered last when a failed publish shares the end time or the clock steps back", () => {
		// M10-A: read follows publish order in the publishing process, not the end time (3.1 of the model).
		for (const secondEndedAt of [66_000, 65_000]) {
			let renames = 0;
			const io = {
				rename(from: string, to: string) {
					renames++;
					if (renames > 1) throw new Error("EIO: rename failed");
					renameSync(from, to);
				},
			};
			const store = new ResultStore(resultsDir(), () => {}, io);
			const reservation = store.reserve();
			const render = (record: ResultRecord) => renderResult(record, { cwd: "/", homeDir: "/nonexistent-home" });
			const first = store.publish(reservation, runResult(reservation.runId, "first revision", 66_000), render);
			const second = store.publish(reservation, runResult(reservation.runId, "second revision", secondEndedAt), render);
			assert.ok(first.report.saved, "the first revision is in the files");
			assert.equal(second.report.saved, false, "the second revision is in memory only");

			const read = store.read(reservation.runId);
			assert.deepStrictEqual(read, second, `the last delivered revision (second endedAt ${secondEndedAt})`);
			const rendering = store.storedRendering(read);
			assert.ok(rendering?.includes("second revision"), "the rendering of the second revision");
			assert.ok(!rendering?.includes("first revision"));
		}
	});

	it("lists no saved run it cannot enumerate, and gives an older unsaved revision no payload of a newer one", () => {
		// M10-A review P2: list adds only unsaved entries; payload getters check the revision.
		const dir = resultsDir();
		const store = new ResultStore(dir, () => {});
		const saved = store.reserve();
		store.publish(saved, runResult(saved.runId, "saved run"));
		chmodSync(dir, 0o100);
		try {
			assert.deepStrictEqual(store.list(), [], "a saved run is listed through its folder only");
		} finally {
			chmodSync(dir, 0o700);
		}

		const unsaved = store.reserve();
		chmodSync(folderOf(unsaved), 0o500);
		const render = (record: ResultRecord) => renderResult(record, { cwd: "/", homeDir: "/nonexistent-home" });
		const older = store.publish(unsaved, runResult(unsaved.runId, "older revision", 66_000), render);
		const newer = store.publish(unsaved, runResult(unsaved.runId, "newer revision", 67_000), render);
		chmodSync(folderOf(unsaved), 0o700);
		assert.equal(store.storedRendering(older), undefined);
		assert.ok(store.storedRendering(newer)?.includes("newer revision"));
	});

	it("gives colliding draws different run ids in memory, and no run replaces the record of another", () => {
		const dir = resultsDir();
		chmodSync(join(dir, ".."), 0o500);
		const store = new ResultStore(dir, () => {});
		const draws = ["aaaa0001", "aaaa0001", "bbbb0002"].map(parseRunId);
		const draw = () => {
			const next = draws.shift();
			assert.ok(next, "enough draws");
			return next;
		};

		const first = store.reserve(draw);
		const second = store.reserve(draw);
		assert.equal(first.folder, undefined);
		assert.equal(first.runId, "aaaa0001");
		assert.equal(second.runId, "bbbb0002");
		const a = store.publish(first, runResult(first.runId, "first run"));
		const b = store.publish(second, runResult(second.runId, "second run"));

		assert.deepStrictEqual(store.read(first.runId), a);
		assert.deepStrictEqual(store.read(second.runId), b);
		assert.ok(a.summary.includes("first run") && b.summary.includes("second run"));
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

	it("creates run folders 0700 and report and record files 0600 under umask 0022", () => {
		const previous = process.umask(0o022);
		try {
			const dir = resultsDir();
			const reservation = reserveRunId(dir);
			const folder = folderOf(reservation);
			publishResult(reservation, runResult(reservation.runId, "first"));
			publishResult(reservation, runResult(reservation.runId, "second", 99_000));
			const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);
			assert.equal(mode(dir), "700", "the results folder is private");
			assert.equal(mode(folder), "700", "the run folder is private");
			for (const name of readdirSync(folder)) assert.equal(mode(join(folder, name)), "600", `${name} is private`);
			assert.deepStrictEqual(readdirSync(folder).sort(), [RECORD_FILE, "report-1.md", "report-2.md"]);
		} finally {
			process.umask(previous);
		}
	});
});
