import { generationRecordOfReport } from "../vf/run/winner-store.ts";
import type { ResultStore } from "./result-files.ts";
import { parseRunId, type ResultRecord } from "./result-record.ts";

/** Where an ended run's published record is read (D13, D18). */
interface PublishedRecordSources {
	/** The run's own store. */
	runStore?: ResultStore;
	/** This parent session's store. */
	sessionStore?: ResultStore;
	/**
	 * The report file that the run's end named. A verified run publishes its generation record beside
	 * that report, outside both stores; only a run end this session received carries the path.
	 */
	reportFile?: string;
}

/**
 * The record that `runId` published: the run's store first, then this session's, then the verified
 * generation of the run's report. Null when none of them holds one, for example a launch that failed
 * before it reserved a record.
 */
export function readPublishedRecord(runId: string | undefined, sources: PublishedRecordSources): ResultRecord | null {
	if (!runId) return null;
	let id: ReturnType<typeof parseRunId>;
	try {
		id = parseRunId(runId);
	} catch {
		return null;
	}
	return (
		sources.runStore?.read(id) ??
		sources.sessionStore?.read(id) ??
		(sources.reportFile ? generationRecordOfReport(sources.reportFile, id) : undefined) ??
		null
	);
}
