import { join } from "node:path";
import { after, describe, it } from "node:test";
import { getSessionResultsDir } from "../../src/artifact-storage.ts";
import { sessionResultStore } from "../../src/runtime/result-files.ts";
import { parseRunId } from "../../src/runtime/result-record.ts";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { TIME_LIMIT_RESUME_REASON } from "../../src/runtime/run-result.ts";
import {
	getLaunchedSubagentResult,
	getShellReadyDelayMs,
	getWatcherSignal,
	resetSubagentStateForTest,
	runningSubagents,
	stopRunningSubagent,
	watchBackgroundSubagent,
	watchSubagent,
	wireSubagentSteerBack,
} from "../../src/runtime/wiring.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import { writeSubagentLaunchMetadataEntry } from "../../src/session/session-files.ts";
import { readSubagentTimeoutSidecar } from "../../src/session/timeout-sidecar.ts";
import { registerSubagentKillTool } from "../../src/tools/kill-tool.ts";
import { registerSubagentResumeTool } from "../../src/tools/resume-tool.ts";
import type { RunningSubagent } from "../../src/types.ts";
import "../support/ambient-spawn-grant.ts";
import { assert, createTestDir, writeExecutable, writeFileSync } from "../support/index.ts";
import { assistant, parentToolCtx } from "../support/result-fixtures.ts";

/**
 * Review P1 #6 (T27): the real subagent_resume and subagent_kill tools and the real headless watcher,
 * with a fake Pi child script instead of a model. The script reads its behaviour from a file:
 * "answer" appends one assistant message, writes a done exit record and exits 0; "hang" sleeps until
 * a signal ends it.
 */
function writeFakePi(dir: string): string {
	return writeExecutable(
		dir,
		"fake-pi",
		[
			"#!/usr/bin/env bash",
			`mode=$(cat "${dir}/mode")`,
			'if [ "$mode" = answer ]; then',
			`  cat "${dir}/answer.jsonl" >> "$PI_SUBAGENT_SESSION"`,
			'  printf \'{"type":"done"}\' > "$PI_SUBAGENT_SESSION.exit"',
			"  exit 0",
			"fi",
			"exec sleep 30",
			"",
		].join("\n"),
	);
}

function writeSession(dir: string): string {
	const sessionFile = join(dir, "child.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: dir })}\n`,
	);
	writeSubagentLaunchMetadataEntry(sessionFile, {
		version: 1,
		timestamp: new Date().toISOString(),
		name: "lifecycle",
		mode: "background",
		sessionMode: "lineage-only",
		parentClosePolicy: "terminate",
		async: true,
		denyTools: [],
		noContextFiles: false,
		noSession: false,
		agentConfigDir: dir,
		cwd: dir,
		boundarySystemPrompt: false,
		// One second: a hanging child meets the time limit quickly; every other step ends long before it.
		timeout: 1,
		onTimeout: "block-resume",
	} as PersistedSubagentLaunchMetadata);
	return sessionFile;
}

type Tool = { execute: (...args: unknown[]) => Promise<unknown> };

/** The wiring the extension gives the two tools (subagents.ts), without the widget refresh timer. */
function realTools() {
	const tools = new Map<string, Tool>();
	const api = { registerTool: (definition: Tool & { name: string }) => tools.set(definition.name, definition) };
	const messages: unknown[] = [];
	const pi = { ...api, sendMessage: (message: unknown) => messages.push(message) };
	const runtime = {
		getShellReadyDelayMs,
		isMuxAvailable: () => false,
		watchBackgroundSubagent,
		watchSubagent,
		getWatcherSignal,
		wireSubagentSteerBack,
		startWidgetRefresh: () => {},
		getLaunchedSubagentResult,
		runningSubagents,
		getContextWindow: () => undefined,
	};
	registerSubagentKillTool(pi as never, () => true, stopRunningSubagent);
	registerSubagentResumeTool(pi as never, () => true, runtime as never);
	return {
		resume: tools.get("subagent_resume") as Tool,
		kill: tools.get("subagent_kill") as Tool,
		runtime,
		pi,
		messages,
	};
}

/** Waits for the run's watcher, its child process and the steer-back that drops it from the running map. */
async function settled(running: RunningSubagent): Promise<void> {
	await running.completionPromise;
	const child = running.childProcess;
	if (child && child.exitCode === null && child.signalCode === null) {
		await new Promise((resolve) => child.once("exit", resolve));
	}
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(runningSubagents.has(running.id), false, "the finished run left the running map");
}

const BLOCKED = /does not allow a resume/;

describe("resume and stop through the real tools and the real headless watcher (T27, D8)", () => {
	after(() => resetSubagentStateForTest());

	it("resumes by run id, stops by run id, and settles the verdict from each published record", async () => {
		const dir = createTestDir();
		const saved = ["PI_SUBAGENT_PI_COMMAND", "PI_ARTIFACT_PROJECT_ROOT"].map(
			(name) => [name, process.env[name]] as const,
		);
		process.env.PI_SUBAGENT_PI_COMMAND = writeFakePi(dir);
		process.env.PI_ARTIFACT_PROJECT_ROOT = dir;
		try {
			writeFileSync(join(dir, "answer.jsonl"), `${JSON.stringify(assistant("RESUMED-ANSWER"))}\n`);
			const setMode = (mode: "answer" | "hang") => writeFileSync(join(dir, "mode"), mode);
			const sessionFile = writeSession(dir);
			const ctx = parentToolCtx(dir, { hasUI: true });
			const resultsDir = getSessionResultsDir(dir, ctx.sessionManager.getSessionId());
			const store = sessionResultStore(resultsDir);
			const { resume, kill, runtime, pi } = realTools();
			const toolResume = async (params: object): Promise<RunningSubagent> => {
				const started = (await resume.execute("c", params, undefined, undefined, ctx)) as { details: { id: string } };
				const running = runningSubagents.get(started.details.id);
				assert.ok(running, "the resumed run is in the running map under its run id");
				return running;
			};
			// The overlay's resume call (overlay/controller.ts doResume): the service with the override, then steer-back.
			const overlayResume = async (): Promise<RunningSubagent> => {
				const running = await resumeSubagentSession(
					{ sessionFile, resultsDir, parent: { parentCwd: dir, warnings: [] }, operatorOverride: true },
					runtime as never,
				);
				if (running.completionPromise) wireSubagentSteerBack(pi as never, running, running.completionPromise);
				return running;
			};
			const record = (runId: string) => store.read(parseRunId(runId));

			// 0. An earlier published result: a resume by session file that answers.
			setMode("answer");
			const first = await toolResume({ sessionFile });
			await settled(first);
			assert.equal(record(first.id)?.outcome, "done");
			assert.equal(readSubagentTimeoutSidecar(sessionFile), null);

			// 1. Resume by that run id; the child hangs and the time limit kills it. The watcher writes
			// its own verdict and the record says why the run cannot resume.
			setMode("hang");
			const limited = await toolResume({ runId: first.id });
			await settled(limited);
			const limitedRecord = record(limited.id);
			assert.equal(limitedRecord?.outcome, "timed_out");
			assert.deepEqual(limitedRecord?.resume, { resumable: false, reason: TIME_LIMIT_RESUME_REASON });
			assert.equal(readSubagentTimeoutSidecar(sessionFile)?.blocksResume, true);
			// The live verdict refuses by run id and by session file alike.
			await assert.rejects(() => resume.execute("c", { runId: limited.id }, undefined, undefined, ctx), BLOCKED);
			await assert.rejects(() => resume.execute("c", { sessionFile }, undefined, undefined, ctx), BLOCKED);

			// 2. The operator override resumes it; subagent_kill stops it by run id. The record is
			// cancelled and the verdict stays (parent decision), so a retry by the new run id is refused.
			const stopped = await overlayResume();
			await kill.execute("k", { id: stopped.id });
			await settled(stopped);
			assert.equal(record(stopped.id)?.outcome, "cancelled");
			assert.equal(readSubagentTimeoutSidecar(sessionFile)?.blocksResume, true);
			await assert.rejects(() => resume.execute("c", { runId: stopped.id }, undefined, undefined, ctx), BLOCKED);

			// 3. The override again; the child answers. The done record removes the verdict.
			setMode("answer");
			const answered = await overlayResume();
			await settled(answered);
			assert.equal(record(answered.id)?.outcome, "done");
			assert.deepEqual(record(answered.id)?.resume, { resumable: true });
			assert.equal(readSubagentTimeoutSidecar(sessionFile), null);

			// 3b. D14 (parity decisions): the old time-limit record is history, not authority. After the
			// operator's successful resume removed the verdict, its run id resumes the session.
			const fromOldRecord = await toolResume({ runId: limited.id });
			await settled(fromOldRecord);
			assert.equal(record(fromOldRecord.id)?.outcome, "done");
			assert.equal(record(fromOldRecord.id)?.sessionFile, sessionFile);

			// 4. A retry by the new run id agrees with its record: the plain tool resumes it.
			const retried = await toolResume({ runId: answered.id });
			await settled(retried);
			assert.equal(record(retried.id)?.outcome, "done");
			assert.equal(record(retried.id)?.sessionFile, sessionFile);
			assert.equal(readSubagentTimeoutSidecar(sessionFile), null);
		} finally {
			for (const [name, value] of saved) {
				if (value == null) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});
});
