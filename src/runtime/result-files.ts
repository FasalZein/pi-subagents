import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { Value } from "typebox/value";
import type { AssembledResult } from "./result-assembler.ts";
import { parseRunId, type ReportStorage, type ResultRecord, type RunId } from "./result-record.ts";
import { ResultRecordSchema } from "./result-record-schema.ts";

/** The commit point of one run folder (D13). */
export const RECORD_FILE = "record.json";

/**
 * D16: the durable session file of a run, written at launch, so a lookup of a run that ended
 * without a record (a continue child after its parent exited) can name it after a restart.
 */
export const LAUNCH_FILE = "launch.json";

/**
 * Run folders and result files are private from the first write: a report holds the child's whole
 * output. The temporary record is created private too, so the rename keeps the mode.
 */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

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
		mkdirSync(resultsDir, { recursive: true, mode: PRIVATE_DIR_MODE });
		for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS; attempt++) {
			const folder = join(resultsDir, runId);
			try {
				mkdirSync(folder, { mode: PRIVATE_DIR_MODE });
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

/**
 * D6: a failed launch gives back its run folder before the id reaches any reply. Only an empty
 * folder is removed, so a folder that holds results is never lost.
 */
function discardReservation(reservation: Reservation): void {
	if (reservation.folder === undefined) return;
	// The launch note is the one file a launch writes before its id reaches a reply (D16).
	rmSync(join(reservation.folder, LAUNCH_FILE), { force: true });
	rmdirSync(reservation.folder);
}

/**
 * D16: the capped rendering of one report revision, next to its report. It is written before the
 * record commits that revision, so a lookup replays the delivered text, display facts included.
 */
export function renderingPathFor(reportPath: string): string {
	return reportPath.replace(/\.md$/, ".rendering.txt");
}

/** Renders a published record into the parent's text (D14); the publisher stores the result. */
export type RenderPublished = (record: ResultRecord) => string;

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
	const fd = openSync(path, "wx", PRIVATE_FILE_MODE);
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
export function publishResult(
	reservation: Reservation,
	result: AssembledResult,
	io: ResultFileIo = NODE_IO,
	render?: RenderPublished,
): ResultRecord {
	if (reservation.folder === undefined) return { ...result.record, report: { saved: false, error: reservation.error } };
	const folder = reservation.folder;
	let reportPath: string | undefined;
	const temp = join(folder, `${RECORD_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		reportPath = writeReport(folder, result.report);
		const record: ResultRecord = { ...result.record, report: { saved: true, path: reportPath } };
		if (render) writeNewFile(renderingPathFor(reportPath), render(record));
		writeNewFile(temp, JSON.stringify(record));
		io.rename(temp, join(folder, RECORD_FILE));
		return record;
	} catch (error) {
		// The new report is not named by any record; the old record keeps its own report. Cleanup is
		// best effort: its failure must not cost the caller the in-memory record.
		removeQuietly(temp);
		if (reportPath) {
			removeQuietly(renderingPathFor(reportPath));
			removeQuietly(reportPath);
		}
		const report: ReportStorage = { saved: false, error: errorText(error) };
		return { ...result.record, report };
	}
}

function isPlainFile(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
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
	/** The renderings of the in-memory records (D16). */
	private readonly memoryRenderings = new Map<RunId, string>();
	/** Session files of the runs this process launched (D16), also when the folder failed. */
	private readonly launches = new Map<RunId, string>();
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

	publish(reservation: Reservation, result: AssembledResult, render?: RenderPublished): ResultRecord {
		const record = publishResult(reservation, result, this.io, render);
		if (!record.report.saved) {
			this.memory.set(record.runId, record);
			if (render) this.memoryRenderings.set(record.runId, render(record));
			if (reservation.folder !== undefined) this.storageFailed(record.report.error);
		}
		return record;
	}

	/** D6 rollback: gives back the run folder and forgets the launch note of this process (D16). */
	discard(reservation: Reservation): void {
		this.launches.delete(reservation.runId);
		discardReservation(reservation);
	}

	/**
	 * D16: keeps the run's durable session file for a later lookup without a record. A no-session
	 * child passes none: its temporary file is deleted, and a result never names a missing path.
	 * A failed write costs only that path after a restart; this process still knows it.
	 */
	noteLaunch(reservation: Reservation, launchedFile: string | undefined): void {
		if (launchedFile === undefined) return;
		// Absolute against this process's directory, where the launch found it; a restart may run elsewhere.
		const sessionFile = resolve(launchedFile);
		this.launches.set(reservation.runId, sessionFile);
		if (reservation.folder === undefined) return;
		try {
			writeNewFile(join(reservation.folder, LAUNCH_FILE), JSON.stringify({ sessionFile }));
		} catch {
			// Best effort, see above.
		}
	}

	/** The session file a launch of this run named, from this process or the run folder (D16). */
	launchSessionFile(runId: RunId): string | undefined {
		let sessionFile: unknown = this.launches.get(runId);
		if (sessionFile === undefined) {
			const parsed = this.readJson(runId, LAUNCH_FILE);
			sessionFile = (parsed as { sessionFile?: unknown } | undefined)?.sessionFile;
		}
		// Either source may be stale: a session file that is gone, or never was a file, is not named.
		return typeof sessionFile === "string" && isPlainFile(sessionFile) ? sessionFile : undefined;
	}

	/**
	 * The file-read boundary of a run folder: only a real folder inside the results folder (no
	 * symlink out of it) and a plain file in it are read; the result is parsed JSON or undefined.
	 */
	private readContained(runId: RunId, name: string): string | undefined {
		const folder = join(this.resultsDir, runId);
		try {
			if (!lstatSync(folder).isDirectory()) return undefined;
			const path = join(folder, name);
			return isPlainFile(path) ? readFileSync(path, "utf8") : undefined;
		} catch {
			return undefined;
		}
	}

	private readJson(runId: RunId, name: string): unknown {
		const text = this.readContained(runId, name);
		try {
			return text === undefined ? undefined : JSON.parse(text);
		} catch {
			return undefined;
		}
	}

	/** Every record of this session: each committed run folder, and the in-memory records (D13, D16). */
	list(): ResultRecord[] {
		let folders: string[] = [];
		try {
			folders = readdirSync(this.resultsDir);
		} catch {
			// No results folder: only the in-memory records.
		}
		const ids = new Set<string>([...folders, ...this.memory.keys()]);
		return [...ids].flatMap((name) => {
			let id: RunId;
			try {
				id = parseRunId(name);
			} catch {
				return [];
			}
			const record = this.read(id);
			return record ? [record] : [];
		});
	}

	/**
	 * D16: the text that was delivered for this record, or undefined for a record published without
	 * one (before T25, or by verified fan-out).
	 */
	storedRendering(record: ResultRecord): string | undefined {
		if (!record.report.saved) return this.memoryRenderings.get(record.runId);
		// Read from the run's own folder by file name only: the record's path is not trusted.
		return this.readContained(record.runId, basename(renderingPathFor(record.report.path)));
	}

	/** The newest record of a run: its committed file, else the in-memory record. */
	read(runId: RunId): ResultRecord | undefined {
		const parsed = this.readJson(runId, RECORD_FILE);
		// Identity and shape at the boundary: a record of another run, or one without a valid end
		// time, is not this run's record and must not break the recent list.
		const stored =
			Value.Check(ResultRecordSchema, parsed) && parsed.runId === runId && Number.isFinite(parsed.endedAt)
				? (parsed as ResultRecord)
				: undefined;
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
