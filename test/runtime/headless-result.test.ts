import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { RESULT_TEXT_MAX_CHARS } from "../../src/runtime/result-render.ts";
import { deliverCompletedSubagentResult } from "../../src/runtime/result-router.ts";
import { buildCompletedSubagentResult } from "../../src/runtime/state.ts";
import { waitForSubagentResult } from "../../src/runtime/wait-result.ts";
import { writeSubagentExitSidecar } from "../../src/session/exit-sidecar.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";
import { afterEach, assert, createSessionFile, createTestDir, describe, it, rmSync } from "../support/index.ts";
import { testResultsDir } from "../support/result-fixtures.ts";

const dirs: string[] = [];
const START_MARKER = "<<T07-START>>";
const END_MARKER = "<<T07-END>>";
/** The ticket's long answer: a 20,000-character last message with a marker at each end. */
const LONG_ANSWER = `${START_MARKER}${"lorem ipsum dolor sit amet\n".repeat(800).slice(0, 20_000 - START_MARKER.length - END_MARKER.length)}${END_MARKER}`;
const TOOL_OUTPUT = "UNRELATED-TOOL-OUTPUT secret listing";

function makeRunning(sessionFile: string, childProcess: ChildProcess): RunningSubagent {
	const store = new ResultStore(testResultsDir(), () => {});
	const reservation = store.reserve();
	return {
		id: reservation.runId,
		name: "Long answer",
		task: "Answer at length",
		agent: "scout",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		childProcess,
		resultTarget: { store, reservation },
	};
}

async function finishHeadless(entries: object[]): Promise<{ running: RunningSubagent; result: SubagentResult }> {
	const dir = createTestDir();
	dirs.push(dir);
	const sessionFile = createSessionFile(dir, entries);
	const child = new EventEmitter() as ChildProcess;
	writeSubagentExitSidecar(sessionFile, { type: "done" });
	const running = makeRunning(sessionFile, child);
	const promise = watchBackgroundSubagent(
		running,
		{ cleanupNoSessionSessionFile() {}, terminateBackgroundChildProcess() {} },
		new AbortController().signal,
	);
	child.emit("exit", 0);
	return { running, result: await promise };
}

function assistantText(text: string) {
	return { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function messageText(result: SubagentResult, running: RunningSubagent): string {
	const sent: Array<{ content: string }> = [];
	const completed = buildCompletedSubagentResult(running, result);
	deliverCompletedSubagentResult({ sendMessage: (message) => sent.push(message as { content: string }) }, completed, String);
	assert.equal(sent.length, 1);
	return sent[0].content;
}

async function waitText(result: SubagentResult, running: RunningSubagent): Promise<string> {
	const cached = buildCompletedSubagentResult(running, result);
	const reply = await waitForSubagentResult({ id: running.id }, { findTrackedSubagent: () => ({ cached }) } as never);
	return (reply.content[0] as { text: string }).text;
}

describe("headless results through the assembler (T07)", () => {
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("caps a 20,000-character answer and names a report file that holds all of it", async () => {
		assert.equal(LONG_ANSWER.length, 20_000);
		const { running, result } = await finishHeadless([assistantText(LONG_ANSWER)]);
		const text = messageText(result, running);
		assert.ok(text.length <= RESULT_TEXT_MAX_CHARS, `text is ${text.length} characters`);
		assert.ok(text.includes(START_MARKER));
		assert.ok(!text.includes(END_MARKER));
		const reportFile = result.reportFile;
		assert.ok(reportFile, "the result names its report file");
		assert.ok(text.includes(`run: ${running.id}`));
		const report = readFileSync(reportFile, "utf8");
		assert.equal(report, LONG_ANSWER);
		assert.ok(report.includes(START_MARKER) && report.includes(END_MARKER));
	});

	it("gives the message path and the waiting-launch path the same text", async () => {
		const { running, result } = await finishHeadless([assistantText(LONG_ANSWER)]);
		assert.equal(await waitText(result, running), messageText(result, running));
	});

	it("does not report unrelated tool output for a run that stops at a tool call with no text", async () => {
		const { running, result } = await finishHeadless([
			{ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }] } },
			{ type: "message", id: "r1", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", isError: false, content: [{ type: "text", text: TOOL_OUTPUT }] } },
		]);
		const text = messageText(result, running);
		assert.ok(!text.includes(TOOL_OUTPUT), text);
		assert.ok(result.reportFile);
		assert.ok(!readFileSync(result.reportFile, "utf8").includes(TOOL_OUTPUT));
	});
});
