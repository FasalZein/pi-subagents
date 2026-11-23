import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { RESULT_TEXT_MAX_CHARS } from "../../src/runtime/result-render.ts";
import { writeSubagentExitSidecar } from "../../src/session/exit-sidecar.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";
import { afterEach, assert, createSessionFile, createTestDir, describe, it, rmSync } from "../support/index.ts";
import {
	assistantText,
	END_MARKER,
	LONG_ANSWER,
	messageText,
	START_MARKER,
	waitText,
} from "../support/result-delivery.ts";
import { testResultsDir } from "../support/result-fixtures.ts";

const dirs: string[] = [];
const TOOL_OUTPUT = "UNRELATED-TOOL-OUTPUT secret listing";

interface TargetOptions {
	resultsDir?: string;
	parentCwd?: string;
	warnings?: readonly string[];
}

function makeRunning(sessionFile: string, childProcess: ChildProcess, options: TargetOptions): RunningSubagent {
	const store = new ResultStore(options.resultsDir ?? testResultsDir(), () => {});
	const reservation = store.reserve();
	return {
		id: reservation.runId,
		name: "Long answer",
		task: "Answer at length",
		agent: "scout",
		mode: "background",
		phase: { kind: "running" },
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		childProcess,
		resultTarget: {
			store,
			reservation,
			parentCwd: options.parentCwd ?? process.cwd(),
			warnings: options.warnings ?? [],
		},
	};
}

async function finishHeadless(
	entries: object[],
	options: TargetOptions & { exitPayload?: object } = {},
): Promise<{ running: RunningSubagent; result: SubagentResult }> {
	const dir = createTestDir();
	dirs.push(dir);
	const sessionFile = createSessionFile(dir, entries);
	const child = new EventEmitter() as ChildProcess;
	writeSubagentExitSidecar(sessionFile, options.exitPayload ?? { type: "done" });
	const running = makeRunning(sessionFile, child, options);
	const promise = watchBackgroundSubagent(
		running,
		{ cleanupNoSessionSessionFile() {}, terminateBackgroundChildProcess() {} },
		new AbortController().signal,
	);
	child.emit("exit", 0);
	return { running, result: await promise };
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

	it("keeps launch warnings inside the rendering, the same text on the waiting launch and the message path", async () => {
		const warnings = [
			"Warning: background launches always use auto-exit: true; auto-exit: false is ignored.",
			"Warning: agent 'scout' sets allow-model-override: false; model 'alpha' from the call ignored. The child runs on the agent's own model.",
		];
		const { running, result } = await finishHeadless([assistantText(LONG_ANSWER)], {
			warnings: warnings.map((w) => w.replace(/^Warning: /, "")),
		});
		const launchText = await waitText(result, running, warnings.join("\n\n"));
		const message = messageText(result, running);
		assert.equal(launchText, message);
		assert.ok(launchText.length <= RESULT_TEXT_MAX_CHARS, `text is ${launchText.length} characters`);
		assert.ok(launchText.includes("warning: background launches always use auto-exit: true"), launchText);
	});

	it("publishes a context-pressure wrap-up through the assembler and says why it cannot resume", async () => {
		const { running, result } = await finishHeadless([assistantText(LONG_ANSWER)], {
			exitPayload: { type: "done", completionReason: "context-pressure", contextTokens: 900, contextWindow: 1000 },
		});
		const message = messageText(result, running);
		assert.equal(await waitText(result, running), message);
		assert.ok(message.length <= RESULT_TEXT_MAX_CHARS, `text is ${message.length} characters`);
		assert.ok(message.includes(START_MARKER) && !message.includes(END_MARKER));
		assert.match(message, /not resumable: stopped early by its context-warning policy/);
		assert.ok(result.reportFile, "the result names its report file");
		assert.equal(readFileSync(result.reportFile, "utf8"), LONG_ANSWER);
	});

	it("names the report by a locator that resolves from the parent's working directory, not the process's", async () => {
		const processDir = createTestDir();
		const parentCwd = createTestDir();
		dirs.push(processDir, parentCwd);
		// process.cwd() reports the real path; the results folder lives under it.
		const resultsDir = join(realpathSync(processDir), "results");
		mkdirSync(resultsDir);
		const previousCwd = process.cwd();
		process.chdir(processDir);
		let finished: Awaited<ReturnType<typeof finishHeadless>>;
		try {
			finished = await finishHeadless([assistantText("short answer")], { resultsDir, parentCwd });
		} finally {
			process.chdir(previousCwd);
		}
		const { running, result } = finished;
		const locator = /^(?:run|resume): .* · (.+)$/m.exec(messageText(result, running))?.[1];
		assert.ok(locator, "the text names the report");
		assert.ok(result.reportFile);
		// Pi's read tool expands a leading ~ and resolves any other relative path from its cwd.
		const expanded = locator.startsWith("~/") ? join(homedir(), locator.slice(2)) : locator;
		assert.equal(resolve(parentCwd, expanded), result.reportFile);
	});

	// T77 (D12): cf6dbf4 findLastSubagentOutputWithSource reports the trailing tool result of a run
	// whose last assistant turn has no text.
	it("reports the trailing tool output of a run that stops at a tool call with no text (cf6dbf4)", async () => {
		const { running, result } = await finishHeadless([
			{
				type: "message",
				id: "a1",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }],
				},
			},
			{
				type: "message",
				id: "r1",
				message: {
					role: "toolResult",
					toolCallId: "t1",
					toolName: "bash",
					isError: false,
					content: [{ type: "text", text: TOOL_OUTPUT }],
				},
			},
		]);
		const text = messageText(result, running);
		assert.ok(text.includes(TOOL_OUTPUT), text);
		assert.ok(result.reportFile);
		assert.equal(readFileSync(result.reportFile, "utf8"), TOOL_OUTPUT);
	});
});
