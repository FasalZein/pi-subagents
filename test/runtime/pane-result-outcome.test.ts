import { join } from "node:path";
import { watchSubagent } from "../../src/runtime/interactive-watch.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { writeSubagentExitSidecar } from "../../src/session/exit-sidecar.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	afterEach,
	assert,
	beforeEach,
	createSessionFile,
	createTestDir,
	describe,
	it,
	rmSync,
} from "../support/index.ts";
import { assistantText, LONG_ANSWER, messageText, waitText } from "../support/result-delivery.ts";

const dirs: string[] = [];
let savedMux: string | undefined;

/**
 * T08a review P1, reverse direction: the shell's exit status never turns the child's own error
 * record into a success. The poll sees the shell's zero status first; the child's error record
 * lands before the watcher reads exit records. The watcher must decide the run failed and, since
 * T09 (D14: an error end goes through the assembler too), publish a failed record whose rendering
 * both carriers show.
 */
describe("pane result outcome", () => {
	beforeEach(() => {
		savedMux = process.env.PI_SUBAGENT_MUX;
		// The file-polling branch: tmux has no direct-program exit check.
		process.env.PI_SUBAGENT_MUX = "tmux";
	});

	afterEach(() => {
		if (savedMux === undefined) delete process.env.PI_SUBAGENT_MUX;
		else process.env.PI_SUBAGENT_MUX = savedMux;
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("keeps a late error record a failure when the shell reported status 0", async () => {
		const root = createTestDir();
		dirs.push(root);
		const sessionFile = createSessionFile(root, [assistantText(LONG_ANSWER)]);
		const store = new ResultStore(join(root, "results"), () => {});
		const reservation = store.reserve();
		const running: RunningSubagent = {
			id: reservation.runId,
			name: "Late error",
			task: "Answer",
			agent: "scout",
			mode: "interactive",
			phase: "running",
			parentClosePolicy: "terminate",
			async: true,
			startTime: Date.now(),
			sessionFile,
			surface: "pi-subagents-nonexistent-surface",
			resultTarget: { store, reservation, parentCwd: root, warnings: [] },
		};
		const result = await watchSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				async closeRunningSurface() {},
				async pollForExit() {
					writeSubagentExitSidecar(sessionFile, { type: "error", errorMessage: "provider quota exhausted" });
					return { reason: "sentinel", exitCode: 0 };
				},
			} as never,
			new AbortController().signal,
		);

		assert.equal(result.errorMessage, "provider quota exhausted");
		assert.notEqual(result.exitCode, 0);
		assert.equal(store.read(reservation.runId)?.outcome, "failed");
		assert.equal(store.read(reservation.runId)?.exit.error, "provider quota exhausted");
		assert.match(result.resultText ?? "", /^Late error · scout · failed · /);
		const message = messageText(result, running);
		assert.equal(message, result.resultText);
		assert.equal(await waitText(result, running), message);
	});
});
