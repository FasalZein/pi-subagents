import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssembledResult } from "../../runtime/result-assembler.ts";
import { RECORD_FILE, readResultRecord } from "../../runtime/result-files.ts";
import type { ResultRecord } from "../../runtime/result-record.ts";

/**
 * D13 and D18: the published results of one verified run, one immutable folder per verification
 * generation: <runDir>/result/g<generation>/ with record.json and report.md. A generation is
 * published once; a replay of the same generation (re-adoption, a second watcher) reuses the
 * committed record, and an older generation never replaces a newer one. The current result is the
 * newest published generation.
 */

const REPORT_FILE = "report.md";
const GENERATION_FOLDER = /^g([1-9][0-9]*)$/;

function resultsRoot(runDir: string): string {
	return join(runDir, "result");
}

function generationFolder(runDir: string, generation: number): string {
	return join(resultsRoot(runDir), `g${generation}`);
}

function readRecordQuietly(folder: string): ResultRecord | undefined {
	try {
		return readResultRecord(folder);
	} catch {
		return undefined;
	}
}

/** The newest published generation of the run, or undefined when none is published. */
export function latestVerifiedRecord(runDir: string): ResultRecord | undefined {
	let names: string[];
	try {
		names = readdirSync(resultsRoot(runDir));
	} catch {
		return undefined;
	}
	const generations = names
		.map((name) => GENERATION_FOLDER.exec(name)?.[1])
		.filter((g): g is string => g !== undefined)
		.map(Number)
		.sort((a, b) => b - a);
	for (const generation of generations) {
		const record = readRecordQuietly(generationFolder(runDir, generation));
		if (record) return record;
	}
	return undefined;
}

function writeFlushed(path: string, text: string): void {
	const fd = openSync(path, "wx");
	try {
		writeFileSync(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function hasCode(error: unknown, ...codes: string[]): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" && codes.includes(code);
}

/**
 * Publishes one generation once: the record and report are written to a temporary folder that is
 * renamed into place, so a reader sees a whole generation or none. When another writer published the
 * generation first, its committed record wins. A failure names no path (D13).
 */
export function publishGeneration(runDir: string, generation: number, result: AssembledResult): ResultRecord {
	const folder = generationFolder(runDir, generation);
	const committed = readRecordQuietly(folder);
	if (committed) return committed;
	const temp = `${folder}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		mkdirSync(resultsRoot(runDir), { recursive: true });
		mkdirSync(temp);
		const record: ResultRecord = { ...result.record, report: { saved: true, path: join(folder, REPORT_FILE) } };
		writeFlushed(join(temp, REPORT_FILE), result.report);
		writeFlushed(join(temp, RECORD_FILE), JSON.stringify(record));
		try {
			renameSync(temp, folder);
			return record;
		} catch (error) {
			if (!hasCode(error, "ENOTEMPTY", "EEXIST")) throw error;
			rmSync(temp, { recursive: true, force: true });
			const winner = readRecordQuietly(folder);
			if (winner) return winner;
			throw error;
		}
	} catch (error) {
		rmSync(temp, { recursive: true, force: true });
		const code = (error as { code?: unknown } | null)?.code;
		return { ...result.record, report: { saved: false, error: typeof code === "string" ? code : "the report could not be written" } };
	}
}
