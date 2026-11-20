import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getSessionResultsDir } from "../../src/artifact-storage.ts";
import { assembleResult } from "../../src/runtime/result-assembler.ts";
import { parseRunId, type ResultOutcome, type ResumeFacts } from "../../src/runtime/result-record.ts";
import { CONTEXT_PRESSURE_RESUME_REASON, TIME_LIMIT_RESUME_REASON } from "../../src/runtime/run-result.ts";
import {
	type PersistedSubagentLaunchMetadata,
	writeSubagentLaunchMetadataEntry,
} from "../../src/session/session-files.ts";
import { registerSubagentResumeTool } from "../../src/tools/resume-tool.ts";
import type { RunningSubagent } from "../../src/types.ts";
import "../support/ambient-spawn-grant.ts";
import { assert, createTestDir, writeExecutable, writeFileSync } from "../support/index.ts";
import { assistant, facts, parentToolCtx, sessionHeader } from "../support/result-fixtures.ts";

// Parity D14 (decisions.md): "Run-ID lookup must not turn a historical verdict into authority after a
// later successful operator resume." The reverse also holds (T74 review, P1): a negative record keeps
// refusing until a later published done, partial or blocked run of the same session supersedes it. A
// cancelled override or a lost timeout sidecar supersedes nothing. Each session here has no timeout
// sidecar and no context-pressure marker, so the live guards pass and only the record can refuse.

type Fixture = { runId: string; outcome: ResultOutcome; endedAt: number; resume: ResumeFacts };

const TIMED_OUT: ResumeFacts = { resumable: false, reason: TIME_LIMIT_RESUME_REASON };
const CONTEXT_SPENT: ResumeFacts = { resumable: false, reason: CONTEXT_PRESSURE_RESUME_REASON };
const RESUMABLE: ResumeFacts = { resumable: true };

function writeSession(dir: string): string {
	const sessionFile = join(dir, "child.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: dir })}\n`,
	);
	writeSubagentLaunchMetadataEntry(sessionFile, {
		version: 1,
		timestamp: new Date().toISOString(),
		name: "child",
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
		timeout: 30,
		onTimeout: "block-resume",
	} as PersistedSubagentLaunchMetadata);
	return sessionFile;
}

/** Resume by run id `target` after the given records of one session; the error text, or "started". */
async function resumeAfter(records: Fixture[], target: string): Promise<string> {
	const dir = createTestDir();
	const saved = ["PI_SUBAGENT_PI_COMMAND", "PI_ARTIFACT_PROJECT_ROOT"].map(
		(name) => [name, process.env[name]] as const,
	);
	process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(dir, "quiet-pi", "#!/usr/bin/env bash\nexit 0\n");
	process.env.PI_ARTIFACT_PROJECT_ROOT = dir;
	try {
		const sessionFile = writeSession(dir);
		const ctx = parentToolCtx(dir, { hasUI: true });
		const resultsDir = getSessionResultsDir(dir, ctx.sessionManager.getSessionId());
		for (const { runId, outcome, endedAt, resume } of records) {
			const assembled = assembleResult(
				facts([sessionHeader(), assistant("earlier")], { runId: parseRunId(runId), sessionFile }),
			).record;
			const record = { ...assembled, outcome, endedAt, resume, report: { saved: false, error: "fixture" } };
			mkdirSync(join(resultsDir, runId), { recursive: true });
			writeFileSync(join(resultsDir, runId, "record.json"), JSON.stringify(record));
		}
		let tool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
		const runtime = {
			isMuxAvailable: () => true,
			getShellReadyDelayMs: () => 0,
			watchBackgroundSubagent: async () => ({ name: "child", task: "t", summary: "done", exitCode: 0, elapsed: 0 }),
			watchSubagent: async () => ({ name: "child", task: "t", summary: "done", exitCode: 0, elapsed: 0 }),
			getWatcherSignal: (_running: unknown, controller: AbortController) => controller.signal,
			startWidgetRefresh: () => {},
			getContextWindow: () => undefined,
			runningSubagents: new Map<string, RunningSubagent>(),
			wireSubagentSteerBack: () => {},
			getLaunchedSubagentResult: async () => ({ content: [], details: {} }),
		};
		registerSubagentResumeTool(
			{ registerTool: (definition: never) => (tool = definition) } as never,
			() => true,
			runtime as never,
		);
		const reply = await tool!.execute("c", { runId: target }, undefined, undefined, ctx).then(
			(result) => (result as { details: { status: string } }).details.status,
			(error: Error) => error.message,
		);
		for (const running of runtime.runningSubagents.values()) await running.completionPromise;
		return reply;
	} finally {
		for (const [name, value] of saved) {
			if (value == null) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

const refusal = (runId: string, reason: string) => `Run ${runId} cannot be resumed: ${reason}`;

describe("a run-id resume and the session verdict in older records (parity D14)", () => {
	it("refuses a timed-out run id whose timeout sidecar is lost and that no later run superseded", async () => {
		const reply = await resumeAfter(
			[{ runId: "aaaa0001", outcome: "timed_out", endedAt: 1_000, resume: TIMED_OUT }],
			"aaaa0001",
		);
		assert.equal(reply, refusal("aaaa0001", TIME_LIMIT_RESUME_REASON));
	});

	it("refuses a context-pressure run id after a later cancelled operator override", async () => {
		const reply = await resumeAfter(
			[
				{ runId: "aaaa0001", outcome: "done", endedAt: 1_000, resume: CONTEXT_SPENT },
				{ runId: "aaaa0002", outcome: "cancelled", endedAt: 2_000, resume: RESUMABLE },
			],
			"aaaa0001",
		);
		assert.equal(reply, refusal("aaaa0001", CONTEXT_PRESSURE_RESUME_REASON));
	});

	it("refuses a timed-out run id after a later failed run", async () => {
		const reply = await resumeAfter(
			[
				{ runId: "aaaa0001", outcome: "timed_out", endedAt: 1_000, resume: TIMED_OUT },
				{ runId: "aaaa0002", outcome: "failed", endedAt: 2_000, resume: RESUMABLE },
			],
			"aaaa0001",
		);
		assert.equal(reply, refusal("aaaa0001", TIME_LIMIT_RESUME_REASON));
	});

	it("resumes a timed-out run id after a later done run of the same session", async () => {
		const reply = await resumeAfter(
			[
				{ runId: "aaaa0001", outcome: "timed_out", endedAt: 1_000, resume: TIMED_OUT },
				{ runId: "aaaa0002", outcome: "done", endedAt: 2_000, resume: RESUMABLE },
			],
			"aaaa0001",
		);
		assert.equal(reply, "started");
	});

	it("keeps a later verdict authoritative over an earlier successful resume", async () => {
		const records: Fixture[] = [
			{ runId: "aaaa0001", outcome: "timed_out", endedAt: 1_000, resume: TIMED_OUT },
			{ runId: "aaaa0002", outcome: "done", endedAt: 2_000, resume: RESUMABLE },
			{ runId: "aaaa0003", outcome: "timed_out", endedAt: 3_000, resume: TIMED_OUT },
		];
		assert.equal(await resumeAfter(records, "aaaa0001"), refusal("aaaa0001", TIME_LIMIT_RESUME_REASON));
		assert.equal(await resumeAfter(records, "aaaa0003"), refusal("aaaa0003", TIME_LIMIT_RESUME_REASON));
	});
});
