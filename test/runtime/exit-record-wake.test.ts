import { join } from "node:path";
import type { MuxBackendAdapter } from "../../src/mux/backend.ts";
import { type PollResult, pollForExit } from "../../src/mux/poll.ts";
import { pollForProgramSurfaceExit } from "../../src/runtime/interactive-watch.ts";
import {
	getSubagentExitSidecarPath,
	HELD_EXIT_FIELD,
	releaseSubagentExitSidecar,
} from "../../src/session/exit-sidecar.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	assert,
	beforeEach,
	createTestDir,
	describe,
	it,
	sleep,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";

// Owner decision 2026-11-21: the parent wakes when the child's exit record appears; the 1 s poll stays the fallback.
const POLL_MS = 1_000;
/** Far below the poll interval: only a wake on the file reads the record this soon. */
const WAKE_BOUND_MS = 200;
/** The record appears after the first read, while the poll loop waits. */
const RECORD_AFTER_MS = 300;
/** Past the second read and short of the third: a pane read spends 0 to 300 ms on the fake cmux. */
const HELD_FOR_MS = 1_700;

type Poll = (sessionFile: string, signal: AbortSignal) => Promise<PollResult>;

/** The pane loop: a fake cmux whose screen never shows the done marker. */
const paneLoop: Poll = (sessionFile, signal) => pollForExit("surface:wake", signal, { interval: POLL_MS, sessionFile });

/** The direct-program loop (herdr): no zellij target, so only the completion files decide. */
const programLoop: Poll = (sessionFile, signal) =>
	pollForProgramSurfaceExit(
		{ name: "wake", sessionFile, surface: "surface:wake" } as RunningSubagent,
		{} as MuxBackendAdapter,
		signal,
		() => {},
	);

/** A closed file watch leaves the active handles a few ms later (libuv closes it asynchronously). */
const WATCH_CLOSE_MS = 100;
async function fileWatchers(): Promise<number> {
	await sleep(WATCH_CLOSE_MS);
	return process.getActiveResourcesInfo().filter((kind) => kind === "FSEventWrap").length;
}

describe("exit record wakes the watcher (pane close delay)", () => {
	// The support hooks restore PATH and the mux variables after each test.
	beforeEach(() => {
		const binDir = createTestDir();
		writeExecutable(binDir, "cmux", "#!/bin/sh\nexit 0\n");
		process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
		process.env.PI_SUBAGENT_MUX = "cmux";
		process.env.CMUX_SOCKET_PATH = "fake-cmux-socket";
	});

	for (const [loop, poll] of [
		["pane poll", paneLoop],
		["program-surface poll", programLoop],
	] as const) {
		it(`${loop}: returns the exit within ${WAKE_BOUND_MS} ms of the record, with a ${POLL_MS} ms interval`, async () => {
			const watchersBefore = await fileWatchers();
			const sessionFile = join(createTestDir(), "child.jsonl");
			const polling = poll(sessionFile, new AbortController().signal);
			await sleep(RECORD_AFTER_MS);
			const writtenAt = Date.now();
			writeFileSync(getSubagentExitSidecarPath(sessionFile), JSON.stringify({ type: "done" }));
			const result = await polling;
			const waited = Date.now() - writtenAt;
			assert.equal(result.reason, "done");
			assert.ok(waited < WAKE_BOUND_MS, `read the record ${waited} ms after it was written`);
			assert.equal(await fileWatchers(), watchersBefore, "the watcher closed with the result");
		});

		it(`${loop}: a held record still reads as no exit; its release wakes the watcher`, async () => {
			const sessionFile = join(createTestDir(), "child.jsonl");
			writeFileSync(getSubagentExitSidecarPath(sessionFile), JSON.stringify({ type: "done", [HELD_EXIT_FIELD]: true }));
			let settled = false;
			const polling = poll(sessionFile, new AbortController().signal).finally(() => {
				settled = true;
			});
			await sleep(HELD_FOR_MS);
			assert.equal(settled, false, "the child may run: the held record is not its exit");
			const releasedAt = Date.now();
			assert.equal(releaseSubagentExitSidecar(sessionFile, { endedBy: "operator" }), true);
			const result = await polling;
			const waited = Date.now() - releasedAt;
			assert.equal(result.closedByOperator, true);
			assert.ok(waited < WAKE_BOUND_MS, `read the released record ${waited} ms after the release`);
		});

		it(`${loop}: an abort closes the watcher`, async () => {
			const watchersBefore = await fileWatchers();
			const controller = new AbortController();
			const polling = poll(join(createTestDir(), "child.jsonl"), controller.signal);
			await sleep(RECORD_AFTER_MS);
			controller.abort();
			await assert.rejects(polling, /Abort/);
			assert.equal(await fileWatchers(), watchersBefore, "the watcher closed with the abort");
		});
	}
});
