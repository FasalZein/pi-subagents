import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AssembledResult } from "./result-assembler.ts";
import { parseRunId, type ReportStorage, type ResultRecord, type RunId } from "./result-record.ts";

/** The commit point of one run folder (D13). */
export const RECORD_FILE = "record.json";

/** A reservation that keeps drawing ids after this many collisions has a broken id source. */
const MAX_RESERVE_ATTEMPTS = 16;

/** D13: an eight-hex-digit id, the width the launch paths drew before. */
export function drawRunId(): RunId {
	return parseRunId(randomBytes(4).toString("hex"));
}

/**
 * A reserved run id. With a folder, this process created it exclusively. Without one, the results
 * folder failed and the run's result stays in memory (D13).
 */
export type Reservation = { runId: RunId; folder: string } | { runId: RunId; folder?: undefined; error: string };

/**
 * The error text for the parent. A file-system error names the file by its base name only: a result
 * never names a path that does not exist (D13).
 */
function errorText(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const { path, dest } = error as { path?: unknown; dest?: unknown };
	let text = error.message;
	for (const named of [path, dest]) {
		if (typeof named === "string" && named !== "") text = text.split(named).join(basename(named));
	}
	return text;
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

/**
 * D13: reserves a run id by creating its folder exclusively before the id appears in any reply. A
 * collision draws a new id, so one run never replaces the files of another run.
 */
export function reserveRunId(resultsDir: string, draw: () => RunId = drawRunId): Reservation {
	let runId = draw();
	try {
		mkdirSync(resultsDir, { recursive: true });
		for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS; attempt++) {
			const folder = join(resultsDir, runId);
			try {
				mkdirSync(folder);
				return { runId, folder };
			} catch (error) {
				if (!hasCode(error, "EEXIST")) throw error;
				runId = draw();
			}
		}
		return { runId, error: `no free run id after ${MAX_RESERVE_ATTEMPTS} draws` };
	} catch (error) {
		return { runId, error: errorText(error) };
	}
}

/** Low-level file steps, replaceable in tests to fail one step. */
export interface ResultFileIo {
	rename(from: string, to: string): void;
}

const NODE_IO: ResultFileIo = { rename: renameSync };

/**
 * Writes all of `text` to a new file and flushes it; fails when the file exists. writeFileSync
 * repeats short writes until every byte is written or a write throws. A failed write removes the
 * partial file, so no folder keeps a cut report.
 */
function writeNewFile(path: string, text: string): void {
	const fd = openSync(path, "wx");
	let written = false;
	try {
		writeFileSync(fd, text);
		fsyncSync(fd);
		written = true;
	} finally {
		if (!written) removeQuietly(path);
		closeSync(fd);
	}
}

/** Creates the next free report file of the folder; reports are never overwritten (D13). */
function writeReport(folder: string, report: string): string {
	for (let revision = 1; ; revision++) {
		const path = join(folder, `report-${revision}.md`);
		try {
			writeNewFile(path, report);
			return path;
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
		}
	}
}

/**
 * D13: publishes one revision of a run's result: first an immutable report file, then the record
 * under a temporary name, renamed over the old record last. A reader sees the old record with its
 * old report or the new record with its new report. On a failure the old record and its report stay,
 * and the returned record says "report not saved" and names no path.
 */
export function publishResult(reservation: Reservation, result: AssembledResult, io: ResultFileIo = NODE_IO): ResultRecord {
	if (reservation.folder === undefined) return { ...result.record, report: { saved: false, error: reservation.error } };
	const folder = reservation.folder;
	let reportPath: string | undefined;
	const temp = join(folder, `${RECORD_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		reportPath = writeReport(folder, result.report);
		const record: ResultRecord = { ...result.record, report: { saved: true, path: reportPath } };
		writeNewFile(temp, JSON.stringify(record));
		io.rename(temp, join(folder, RECORD_FILE));
		return record;
	} catch (error) {
		// The new report is not named by any record; the old record keeps its own report. Cleanup is
		// best effort: its failure must not cost the caller the in-memory record.
		removeQuietly(temp);
		if (reportPath) removeQuietly(reportPath);
		const report: ReportStorage = { saved: false, error: errorText(error) };
		return { ...result.record, report };
	}
}

function removeQuietly(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// An unremovable leftover is not named by any record.
	}
}

/** Reads the committed record of a run folder, or undefined when none is committed. */
export function readResultRecord(folder: string): ResultRecord | undefined {
	const path = join(folder, RECORD_FILE);
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8")) as ResultRecord;
}

/**
 * The results of one parent session (D13): run folders under `resultsDir`, and in memory the
 * records whose files failed. The first storage failure sends one notice to the person, outside
 * any tool result.
 */
export class ResultStore {
	private readonly memory = new Map<RunId, ResultRecord>();
	/** Every id this store handed out: without a folder on disk, only this set keeps ids exclusive. */
	private readonly reserved = new Set<RunId>();
	private noticeSent = false;
	private readonly resultsDir: string;
	private readonly notifyStorageFailure: (message: string) => void;
	private readonly io: ResultFileIo;

	constructor(resultsDir: string, notifyStorageFailure: (message: string) => void, io: ResultFileIo = NODE_IO) {
		this.resultsDir = resultsDir;
		this.notifyStorageFailure = notifyStorageFailure;
		this.io = io;
	}

	reserve(draw: () => RunId = drawRunId): Reservation {
		const freshDraw = (): RunId => {
			let runId = draw();
			while (this.reserved.has(runId)) runId = draw();
			return runId;
		};
		const reservation = reserveRunId(this.resultsDir, freshDraw);
		this.reserved.add(reservation.runId);
		if (reservation.folder === undefined) this.storageFailed(reservation.error);
		return reservation;
	}

	publish(reservation: Reservation, result: AssembledResult): ResultRecord {
		const record = publishResult(reservation, result, this.io);
		if (!record.report.saved) {
			this.memory.set(record.runId, record);
			if (reservation.folder !== undefined) this.storageFailed(record.report.error);
		}
		return record;
	}

	/** The newest record of a run: its committed file, else the in-memory record. */
	read(runId: RunId): ResultRecord | undefined {
		let stored: ResultRecord | undefined;
		try {
			stored = readResultRecord(join(this.resultsDir, runId));
		} catch {
			stored = undefined;
		}
		const inMemory = this.memory.get(runId);
		if (!stored) return inMemory;
		return inMemory && inMemory.endedAt > stored.endedAt ? inMemory : stored;
	}

	private storageFailed(error: string): void {
		if (this.noticeSent) return;
		this.noticeSent = true;
		this.notifyStorageFailure(`Subagent results are kept in memory only: ${error}`);
	}
}

const sessionStores = new Map<string, ResultStore>();
let storageNotice: (message: string) => void = () => {};

/** The parent session's UI notice for a storage failure; each store sends it at most once. */
export function setResultStorageNotice(notify: (message: string) => void): void {
	storageNotice = notify;
}

/** One store per results folder, so a parent session reserves its ids and sends its notice once. */
export function sessionResultStore(resultsDir: string): ResultStore {
	let store = sessionStores.get(resultsDir);
	if (!store) {
		store = new ResultStore(resultsDir, (message) => storageNotice(message));
		sessionStores.set(resultsDir, store);
	}
	return store;
}
