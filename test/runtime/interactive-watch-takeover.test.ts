import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchSubagent } from "../../src/runtime/interactive-watch.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { assert, createTestDir, describe, it, sleep, writeExecutable } from "../support/index.ts";
import { cleanupPaneChild, loadPaneChild } from "../support/pane-child.ts";

const toolUseEnd = {
	messages: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] }],
};
const MUX_ENV_KEYS = ["PATH", "PI_SUBAGENT_MUX", "CMUX_SOCKET_PATH"] as const;
// The watcher polls the pane once per second.
const TWO_POLLS_MS = 2_500;

/**
 * D11/D12 from the pane to the parent: the child extension runs in this
 * process, a fake cmux serves its screen, and the real watcher and poller
 * read its exit record. Only the Pi process and the terminal are fakes.
 */
describe("interactive watcher after a pane takeover", () => {
	it("shows the error in the open pane, delivers nothing, then one error result after the pane closes", async () => {
		const binDir = createTestDir();
		const screenFile = join(binDir, "screen");
		writeFileSync(screenFile, "");
		writeExecutable(binDir, "cmux", `#!/bin/sh\nif [ "$1" = "read-screen" ]; then cat "${screenFile}" || exit 1; fi\n`);
		const savedEnv = Object.fromEntries(MUX_ENV_KEYS.map((key) => [key, process.env[key]]));
		process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
		process.env.PI_SUBAGENT_MUX = "cmux";
		process.env.CMUX_SOCKET_PATH = "fake-cmux-socket";
		const child = loadPaneChild({
			autoExit: true,
			pane: true,
			onNotice: (message) => appendFileSync(screenFile, `${message}\n`),
		});
		const sessionFile = process.env.PI_SUBAGENT_SESSION as string;
		const running: RunningSubagent = {
			id: "pane-child",
			name: "pane-child",
			task: "Fix the build",
			mode: "interactive",
			phase: "running",
			parentClosePolicy: "terminate",
			async: true,
			startTime: Date.now(),
			sessionFile,
			surface: "surface:1",
		};
		const controller = new AbortController();
		let results = 0;
		let closes = 0;
		try {
			const watching = watchSubagent(
				running,
				{
					cleanupNoSessionSessionFile() {},
					async closeRunningSurface() {
						closes += 1;
					},
				},
				controller.signal,
			).then((result) => {
				results += 1;
				return result;
			});

			child.takeOver();
			for (let i = 0; i < 3; i++) child.emit("agent_end", toolUseEnd);
			await sleep(TWO_POLLS_MS);

			const exhausted = "Subagent recovery exhausted after 3 consecutive tool-use boundary endings.";
			assert.match(readFileSync(screenFile, "utf8"), new RegExp(exhausted.replace(/\./g, "\\.")));
			assert.equal(child.shutdowns, 0, "the child keeps its pane");
			assert.equal(results, 0, "the parent delivers no result while the pane is open");
			assert.equal(closes, 0, "the parent does not close the pane");

			// The person quits Pi in the pane.
			child.emit("session_shutdown", { reason: "quit" });
			const result = await watching;

			assert.equal(results, 1);
			assert.equal(result.exitCode, 1);
			assert.equal(result.errorMessage, exhausted);
			assert.equal(existsSync(`${sessionFile}.exit`), false, "the parent consumed the one exit record");
		} finally {
			controller.abort();
			for (const key of MUX_ENV_KEYS) {
				if (savedEnv[key] === undefined) delete process.env[key];
				else process.env[key] = savedEnv[key];
			}
			cleanupPaneChild(child.dir);
			rmSync(binDir, { recursive: true, force: true });
		}
	});
});
