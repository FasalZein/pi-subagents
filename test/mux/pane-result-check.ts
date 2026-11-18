import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MuxBackendAdapter } from "../../src/mux/backend.ts";
import { watchSubagent } from "../../src/runtime/interactive-watch.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { RESULT_TEXT_MAX_CHARS } from "../../src/runtime/result-render.ts";
import { writeSubagentExitSidecar } from "../../src/session/exit-sidecar.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { assert, createSessionFile } from "../support/index.ts";
import {
	assistantText,
	END_MARKER,
	LONG_ANSWER,
	messageText,
	START_MARKER,
	waitText,
} from "../support/result-delivery.ts";

/**
 * T08a (D13, D14): a pane child on this backend's fake ends with a 20,000-character last message.
 * The real watcher polls the fake surface, reads the exit record, publishes the result and closes
 * the surface. The message path and the waiting launch must show one capped text that names the
 * report file, and the report file must hold the whole answer.
 */
export async function checkPaneResultThroughAssembler(adapter: MuxBackendAdapter, root: string): Promise<void> {
	assert.equal(LONG_ANSWER.length, 20_000);
	const sessionFile = createSessionFile(root, [assistantText(LONG_ANSWER)]);
	const store = new ResultStore(join(root, "results"), () => {});
	const reservation = store.reserve();
	const surface = await adapter.createSurface("Pane Result");
	const running: RunningSubagent = {
		id: reservation.runId,
		name: "Long pane answer",
		task: "Answer at length",
		agent: "scout",
		mode: "interactive",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		surface,
		resultTarget: { store, reservation, parentCwd: root, warnings: [] },
	};
	const closed: string[] = [];
	const watching = watchSubagent(
		running,
		{
			cleanupNoSessionSessionFile() {},
			async closeRunningSurface(current) {
				closed.push(current.surface ?? "");
				await adapter.closeSurface(current.surface ?? "");
			},
		},
		new AbortController().signal,
	);
	// The watcher has polled once without an exit record; the child's completion tool writes it now.
	writeSubagentExitSidecar(sessionFile, { type: "done" });
	const result = await watching;

	assert.deepEqual(closed, [surface], "the watcher closes the pane once");
	const message = messageText(result, running);
	assert.ok(message.length <= RESULT_TEXT_MAX_CHARS, `text is ${message.length} characters`);
	assert.ok(message.includes(START_MARKER), message);
	assert.ok(!message.includes(END_MARKER));
	assert.ok(message.includes(`run: ${running.id}`), message);
	assert.ok(result.reportFile, "the result names its report file");
	assert.match(message, /^report: .+$/m);
	assert.equal(readFileSync(result.reportFile, "utf8"), LONG_ANSWER);
	assert.equal(await waitText(result, running), message);
}
