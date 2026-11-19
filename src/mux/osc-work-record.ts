import type { WorkReporter, WorkReporterSession } from "../runtime/work-reporting.ts";

/** The id of the extension's own OSC 7501 side record; Pi's root record has no id and is never written here. */
export const WORK_RECORD_ID = "pi-subagents";

/** Backends whose terminal stores OSC 7501 side records (D30). */
export type OscRecordBackend = "herdr-core" | "rex";

/**
 * The terminal end of the writer: the parent's own stdout in production, a fake in tests.
 * `write` is replaced while the reporter runs, so it is a property, not a method.
 */
interface RecordTerminal {
	readonly isTTY?: boolean;
	write: (chunk: string | Uint8Array, ...rest: never[]) => boolean;
}

const OSC = "\x1b]7501;";
const ST = "\x1b\\";
const ESC = "\x1b";
/** The body of each OSC 7501 report in a chunk, ended by ST or BEL. */
const REPORT = new RegExp(`${ESC}\\]7501;([^\\x07${ESC}]*)(?:${ESC}\\\\|\\x07)`, "g");

/** The side record for a count: `working` with a readable message at a positive count, `clear` at zero. */
function formatWorkRecord(count: number): string {
	if (count <= 0) return `${OSC}state=clear:id=${WORK_RECORD_ID}${ST}`;
	const message = Buffer.from(`${count} ${count === 1 ? "child" : "children"}`, "utf8").toString("base64");
	return `${OSC}state=working:id=${WORK_RECORD_ID}:msg=${message}${ST}`;
}

/** What a chunk does to the root record: Pi's root reports carry no id; a query (`7501;?`) is neither. */
function rootChange(chunk: string): "clear" | "report" | undefined {
	let change: "clear" | "report" | undefined;
	for (const match of chunk.matchAll(REPORT)) {
		const pairs = match[1].split(":");
		if (pairs.some((pair) => pair.startsWith("id="))) continue;
		const state = pairs.find((pair) => pair.startsWith("state="));
		if (state) change = state === "state=clear" ? "clear" : "report";
	}
	return change;
}

/** The terminal identity of each backend, from the environment its terminal sets for the program in it. */
function insideBackend(backend: OscRecordBackend, environment: NodeJS.ProcessEnv): boolean {
	if (backend === "herdr-core") return !!environment.HC_TERMINAL_ID;
	return !!environment.REX_SESSION && !!environment.REX_BLOCK;
}

/**
 * One writer for herdr-core and Rex (D30): the TUI parent reports its count of outstanding children
 * as its own side record on its own terminal. The markers alone can be inherited from another terminal, so
 * `usable`, the backend's bounded asynchronous launch check, decides as launch detection does (D29).
 */
export async function createOscWorkReporter(
	session: WorkReporterSession,
	backend: OscRecordBackend,
	usable: () => Promise<boolean>,
	environment: NodeJS.ProcessEnv = process.env,
	terminal: RecordTerminal = process.stdout,
): Promise<WorkReporter | undefined> {
	const preference = environment.PI_SUBAGENT_MUX?.trim().toLowerCase();
	if (session.mode !== "tui" || !terminal.isTTY || !insideBackend(backend, environment)) return;
	if (preference && preference !== backend) return;
	if (!(await usable())) return;
	return makeRecordReporter(terminal);
}

function makeRecordReporter(terminal: RecordTerminal): WorkReporter {
	// What the terminal holds: the count of the last record written (0: none). A root clear removes every
	// side record on herdr-core and Rex, so the terminal can lose the record without a write of ours.
	let held: number | undefined;
	let count = 0;
	let stopped = false;
	// Pi's TUI stopped (exit, Ctrl+Z, Ctrl+G external editor, TUI mode change): its stop() writes a root
	// clear, and its start() writes Pi's root record again. Pi 1.5.2 gives extensions no event for either,
	// and the TUI terminal is not reachable from the extension context. Both writes go through the stdout
	// this reporter writes to, so it watches that stream: the record is written only while Pi's TUI holds
	// the terminal, and restored when Pi reports its root record again. pi-tui writes each report in one
	// write call, so a report is never split across chunks.
	let tuiStopped = false;
	const original = terminal.write;
	const own = (data: string) => original.call(terminal, data);

	function sync(): void {
		if (stopped || tuiStopped || held === count) return;
		try {
			own(formatWorkRecord(count));
			held = count;
		} catch {
			// Optional reporting must never break Pi; the next change writes again.
		}
	}

	const observed: RecordTerminal["write"] = (chunk, ...rest) => {
		const result = original.call(terminal, chunk, ...rest);
		const change = typeof chunk === "string" ? rootChange(chunk) : undefined;
		if (change === "clear") {
			held = 0;
			tuiStopped = true;
		} else if (change === "report" && tuiStopped) {
			tuiStopped = false;
			sync();
		}
		return result;
	};
	terminal.write = observed;

	return {
		async publish(value) {
			count = value;
			sync();
		},
		async stop() {
			if (stopped) return;
			count = 0;
			sync();
			stopped = true;
			// Another wrapper installed after this one keeps calling it; `stopped` makes it a pass-through.
			if (terminal.write === observed) terminal.write = original;
		},
	};
}
