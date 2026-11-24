import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Pi's own argv parsing and first-message assembly: the real collaborator that turns a child's
// prompt arguments into its first user message.
import { parseArgs } from "../../node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js";
import { processFileArguments } from "../../node_modules/@earendil-works/pi-coding-agent/dist/cli/file-processor.js";
import { buildInitialMessage } from "../../node_modules/@earendil-works/pi-coding-agent/dist/cli/initial-message.js";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { restartSubagentForTimeoutWrapUp } from "../../src/runtime/timeout-wrap-up.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	assert,
	buildPiPromptArgsForTest,
	createTestDir,
	describe,
	it,
	writeExecutable,
	writeSubagentLaunchMetadataEntryForTest,
} from "../support/index.ts";
import { testResultsDir } from "../support/result-fixtures.ts";

async function firstMessageOf(args: string[]) {
	const parsed = parseArgs(args);
	const { text } = await processFileArguments(parsed.fileArgs, { autoResizeImages: false });
	return buildInitialMessage({ parsed, fileText: text }).initialMessage ?? "";
}

/** The note a fresh launch puts after its task file: the shape every other launch path must match. */
async function freshLaunchNote(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagents-first-message-"));
	const taskPath = join(dir, "task.md");
	writeFileSync(taskPath, "x");
	return (await firstMessageOf(buildPiPromptArgsForTest([], `@${taskPath}`))).slice(
		`<file name="${taskPath}">\nx\n</file>\n`.length,
	);
}

/** A fake tmux on PATH that logs its argv; an interactive launch then writes a capsule with the child's pi argv. */
function useFakeTmux(dir: string): string {
	const binDir = join(dir, "bin");
	mkdirSync(binDir, { recursive: true });
	const logFile = join(dir, "tmux.log");
	writeExecutable(
		binDir,
		"tmux",
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_TMUX_LOG"
case "$1" in
  new-window) printf '%%42\\n' ;;
esac
`,
	);
	process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
	process.env.PI_SUBAGENT_MUX = "tmux";
	process.env.TMUX = "fake-tmux-socket";
	process.env.FAKE_TMUX_LOG = logFile;
	return logFile;
}

/** The first message of the pane child that the fake tmux was told to start. */
async function paneFirstMessage(logFile: string): Promise<{ taskPath: string; initialMessage: string }> {
	const match = readFileSync(logFile, "utf8").match(/run-child\.mjs' '([^']+)'/);
	if (!match?.[1]) throw new Error(`no capsule launch in the fake tmux log ${logFile}`);
	const args: string[] = JSON.parse(readFileSync(match[1], "utf8")).args;
	const taskArg = args.find((arg) => arg.startsWith("@"));
	if (!taskArg) throw new Error(`no @task argument in the capsule argv: ${JSON.stringify(args)}`);
	return { taskPath: taskArg.slice(1), initialMessage: await firstMessageOf(args.slice(args.indexOf("--session"))) };
}

function writeChildSession(dir: string): string {
	const sessionFile = join(dir, "child.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "child-session", timestamp: new Date().toISOString(), cwd: dir })}\n`,
	);
	return sessionFile;
}

function interactiveMetadata(dir: string): PersistedSubagentLaunchMetadata {
	return {
		version: 1,
		timestamp: new Date().toISOString(),
		name: "pane-child",
		agent: "scout",
		mode: "interactive",
		sessionMode: "fork",
		autoExit: true,
		parentClosePolicy: "terminate",
		async: true,
		denyTools: [],
		noContextFiles: false,
		noSession: false,
		agentConfigDir: dir,
		cwd: dir,
		boundarySystemPrompt: false,
		timeout: 10,
		timeoutWarnThreshold: "80%",
	};
}

const idleWatch = async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 });

async function firstMessageFor(skills: string[]) {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagents-first-message-"));
	const taskPath = join(dir, "task.md");
	writeFileSync(taskPath, "Reply with exactly LIVE_A_OK.");
	const parsed = parseArgs(buildPiPromptArgsForTest(skills, `@${taskPath}`));
	const { text } = await processFileArguments(parsed.fileArgs, { autoResizeImages: false });
	const { initialMessage } = buildInitialMessage({ parsed, fileText: text });
	return { taskPath, initialMessage: initialMessage ?? "", laterMessages: parsed.messages };
}

describe("child first message", () => {
	// Requirement: a child reads its task file as its instruction, not as a file a user attached
	// (gpt children answered "What would you like me to do with the attached file?").
	for (const [label, skills] of [
		["launch without skills", []],
		["launch with skills", ["debugger", "pua"]],
	] as const) {
		it(`says after the task file that the file is the task: ${label}`, async () => {
			const { taskPath, initialMessage, laterMessages } = await firstMessageFor([...skills]);
			const fileBlock = `<file name="${taskPath}">\nReply with exactly LIVE_A_OK.\n</file>\n`;
			assert.ok(initialMessage.startsWith(fileBlock), initialMessage);
			const note = initialMessage.slice(fileBlock.length);
			assert.match(
				note,
				/\btask\b/i,
				`first message carries no line naming the file as the task: ${JSON.stringify(initialMessage)}`,
			);
			assert.deepEqual(
				laterMessages,
				skills.map((skill) => `/skill:${skill}`),
			);
		});
	}

	// Requirement (parent decision 2026-11-25): a pane resume and a pane time-limit wrap-up pass their
	// task as a file too, and their first message has the same shape as a fresh launch's.
	it("a pane resume says after its task file that the file is the task, as a fresh launch does", async () => {
		const dir = createTestDir();
		const logFile = useFakeTmux(dir);
		const sessionFile = writeChildSession(dir);
		await writeSubagentLaunchMetadataEntryForTest(sessionFile, interactiveMetadata(dir));
		await resumeSubagentSession(
			{
				resultsDir: testResultsDir(),
				parentSessionId: "test-parent",
				parent: { parentCwd: process.cwd(), warnings: [] },
				sessionFile,
				task: "Follow your instructions.",
			},
			{
				isMuxAvailable: () => true,
				getShellReadyDelayMs: () => 0,
				watchBackgroundSubagent: idleWatch,
				watchSubagent: idleWatch,
				getWatcherSignal: (_running: unknown, controller: AbortController) => controller.signal,
				startWidgetRefresh: () => {},
				getContextWindow: () => undefined,
				runningSubagents: new Map(),
			},
		);
		const { taskPath, initialMessage } = await paneFirstMessage(logFile);
		const fileBlock = `<file name="${taskPath}">\n${readFileSync(taskPath, "utf8")}\n</file>\n`;
		assert.equal(initialMessage, fileBlock + (await freshLaunchNote()));
	});

	it("a pane time-limit wrap-up says after its task file that the file is the task, as a fresh launch does", async () => {
		const dir = createTestDir();
		const logFile = useFakeTmux(dir);
		const sessionFile = writeChildSession(dir);
		const running: RunningSubagent = {
			id: "pane-child",
			name: "pane-child",
			task: "Do the long task",
			agent: "scout",
			mode: "interactive",
			parentClosePolicy: "terminate",
			async: true,
			autoExit: true,
			startTime: Date.now() - 8_000,
			sessionFile,
			timeoutBudget: { timeoutSeconds: 10 },
			timeoutWarnThreshold: 80,
			phase: { kind: "soft-limit", wrapUp: { wrapUp: { kind: "timeout", seconds: 10, threshold: 80 }, deadlineAt: 0 } },
			launchMetadata: interactiveMetadata(dir),
		};
		await restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 });
		const { taskPath, initialMessage } = await paneFirstMessage(logFile);
		const fileBlock = `<file name="${taskPath}">\n${readFileSync(taskPath, "utf8")}\n</file>\n`;
		assert.equal(initialMessage, fileBlock + (await freshLaunchNote()));
	});
});
