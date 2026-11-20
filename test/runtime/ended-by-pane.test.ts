import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchSubagent } from "../../src/runtime/interactive-watch.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { SUBAGENT_ACCEPTED_CALL_ENTRY } from "../../src/tools/completion-call.ts";
import { SUBAGENT_DONE_TOOL_NAME } from "../../src/tools/tool-names.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { assert, createTestDir, describe, it, writeExecutable } from "../support/index.ts";
import { cleanupPaneChild, loadPaneChild } from "../support/pane-child.ts";
import { assistant, toolCall, user } from "../support/result-fixtures.ts";

const MUX_ENV_KEYS = ["PATH", "PI_SUBAGENT_MUX", "CMUX_SOCKET_PATH"] as const;
const toolUseEnd = {
	messages: [
		{
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
		},
	],
};
const answerEnd = {
	messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Final answer." }] }],
};

type PaneChild = ReturnType<typeof loadPaneChild>;

/**
 * T70 from the pane to the record: the real child extension writes its exit record, and the real
 * watcher and poller publish the run's record. Only the Pi process and the terminal are fakes.
 */
async function paneRun(autoExit: boolean, act: (child: PaneChild) => void | Promise<void>, session: object[] = []) {
	const binDir = createTestDir();
	const screenFile = join(binDir, "screen");
	writeFileSync(screenFile, "");
	writeExecutable(binDir, "cmux", `#!/bin/sh\nif [ "$1" = "read-screen" ]; then cat "${screenFile}" || exit 1; fi\n`);
	const savedEnv = Object.fromEntries(MUX_ENV_KEYS.map((key) => [key, process.env[key]]));
	process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
	process.env.PI_SUBAGENT_MUX = "cmux";
	process.env.CMUX_SOCKET_PATH = "fake-cmux-socket";
	const child = loadPaneChild({
		autoExit,
		pane: true,
		onNotice: (message) => appendFileSync(screenFile, `${message}\n`),
	});
	const sessionFile = process.env.PI_SUBAGENT_SESSION as string;
	writeFileSync(sessionFile, session.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
	const store = new ResultStore(join(child.dir, "results"), () => {});
	const reservation = store.reserve();
	const running: RunningSubagent = {
		id: reservation.runId,
		name: "pane-child",
		task: "Fix the build",
		agent: "worker",
		mode: "interactive",
		phase: "running",
		parentClosePolicy: "terminate",
		async: true,
		autoExit,
		startTime: Date.now(),
		sessionFile,
		surface: "surface:1",
		resultTarget: { store, reservation, parentCwd: child.dir, warnings: [] },
	};
	const controller = new AbortController();
	try {
		const watching = watchSubagent(
			running,
			{ cleanupNoSessionSessionFile() {}, async closeRunningSurface() {} },
			controller.signal,
		);
		await act(child);
		const result = await watching;
		const record = store.read(reservation.runId);
		assert.ok(record, "the watcher published a record");
		return { result, record };
	} finally {
		controller.abort();
		for (const key of MUX_ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		cleanupPaneChild(child.dir);
		rmSync(binDir, { recursive: true, force: true });
	}
}

const quit = (child: PaneChild) => child.emit("session_shutdown", { reason: "quit" });

describe("the pane records who ended the run (T70)", () => {
	it("operator: a person takes over an auto-exit pane, then quits it without a completion call", async () => {
		const { result, record } = await paneRun(true, (child) => {
			child.takeOver();
			quit(child);
		});
		assert.equal(record.outcome, "done");
		assert.equal(record.endedBy, "operator");
		assert.match(String(result.resultText).split("\n")[0], / · ended by operator$/);
	});

	it("operator: a person quits a taken-over pane that kept an unrecovered error", async () => {
		const { result, record } = await paneRun(true, (child) => {
			child.takeOver();
			for (let i = 0; i < 3; i++) child.emit("agent_end", toolUseEnd);
			quit(child);
		});
		assert.equal(record.outcome, "failed");
		assert.equal(record.endedBy, "operator");
		assert.match(String(result.errorMessage), /recovery exhausted/);
	});

	it("operator: a person closes a manual pane", async () => {
		const { record } = await paneRun(false, quit);
		assert.equal(record.endedBy, "operator");
	});

	it("child: a re-armed auto-exit child that ends itself after a call made during the takeover", async () => {
		const args = { outcome: "done", summary: "Recorded during the takeover." };
		const session = [
			user("task"),
			toolCall(SUBAGENT_DONE_TOOL_NAME, args, "d1", "Report."),
			{
				type: "custom",
				id: "acc-d1",
				customType: SUBAGENT_ACCEPTED_CALL_ENTRY,
				data: { toolCallId: "d1", tool: SUBAGENT_DONE_TOOL_NAME, args, autonomous: false },
			},
			assistant("Final answer."),
		];
		const { result, record } = await paneRun(
			true,
			async (child) => {
				child.takeOver();
				await child.commands.get("auto-exit")?.handler("", child.ctx);
				child.emit("agent_start", {});
				// One nudge toward the completion call, then the untyped exit of the child's own.
				child.emit("agent_end", answerEnd);
				child.emit("agent_end", answerEnd);
				const exit = child.readExit();
				assert.equal(exit?.type, "done", "the child wrote its own exit record");
				assert.equal(exit?.endedBy, undefined, "the child's own exit record names no operator");
				quit(child);
			},
			session,
		);
		assert.equal(record.endedBy, "child");
		assert.ok(!String(result.resultText).includes("ended by"));
	});
});
