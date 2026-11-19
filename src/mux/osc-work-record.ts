import type { WorkReporter, WorkReporterSession } from "../runtime/work-reporting.ts";

/** The id of the extension's own OSC 7501 side record; Pi's root record has no id and is never written here. */
export const WORK_RECORD_ID = "pi-subagents";

/** Backends whose terminal stores OSC 7501 side records (D30). */
export type OscRecordBackend = "herdr-core" | "rex";

/** The terminal end of the writer: the parent's own stdout in production, a fake in tests. */
export interface RecordTerminal {
	readonly isTTY?: boolean;
	write(data: string): unknown;
}

const OSC = "\x1b]7501;";
const ST = "\x1b\\";

/** The side record for a count: `working` with a readable message at a positive count, `clear` at zero. */
export function formatWorkRecord(count: number): string {
	if (count <= 0) return `${OSC}state=clear:id=${WORK_RECORD_ID}${ST}`;
	const message = Buffer.from(`${count} ${count === 1 ? "child" : "children"}`, "utf8").toString("base64");
	return `${OSC}state=working:id=${WORK_RECORD_ID}:msg=${message}${ST}`;
}

/** The terminal identity of each backend, from the environment its terminal sets for the program in it. */
function insideBackend(backend: OscRecordBackend, environment: NodeJS.ProcessEnv): boolean {
	if (backend === "herdr-core") return !!environment.HC_TERMINAL_ID;
	return !!environment.REX_SESSION && !!environment.REX_BLOCK;
}

/**
 * One writer for herdr-core and Rex (D30): the TUI parent reports its count of outstanding children
 * as its own side record on its own terminal. No probe and no process call, so session start never waits.
 */
export async function createOscWorkReporter(
	session: WorkReporterSession,
	backend: OscRecordBackend,
	environment: NodeJS.ProcessEnv = process.env,
	terminal: RecordTerminal = process.stdout,
): Promise<WorkReporter | undefined> {
	const preference = environment.PI_SUBAGENT_MUX?.trim().toLowerCase();
	if (session.mode !== "tui" || !terminal.isTTY || !insideBackend(backend, environment)) return;
	if (preference && preference !== backend) return;
	return makeRecordReporter(terminal);
}

function makeRecordReporter(terminal: RecordTerminal): WorkReporter {
	// The last record written; undefined until the first write, so the first publish also clears
	// a record that an earlier process in this terminal left behind (C5: converge from any prior state).
	let written: number | undefined;
	let stopped = false;

	function write(count: number): void {
		if (written === count) return;
		try {
			terminal.write(formatWorkRecord(count));
			written = count;
		} catch {
			// Optional reporting must never break Pi; the next change writes again.
		}
	}

	return {
		async publish(count) {
			if (!stopped) write(Math.max(0, count));
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			write(0);
		},
	};
}
