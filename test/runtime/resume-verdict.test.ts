import { mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getSessionResultsDir } from "../../src/artifact-storage.ts";
import { assembleResult } from "../../src/runtime/result-assembler.ts";
import { parseRunId, type ResumeFacts } from "../../src/runtime/result-record.ts";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { runningSubagents } from "../../src/runtime/state.ts";
import { getSubagentExitSidecarPath } from "../../src/session/exit-sidecar.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import { writeSubagentLaunchMetadataEntry } from "../../src/session/session-files.ts";
import {
	getSubagentTimeoutSidecarPath,
	readSubagentTimeoutSidecar,
	writeSubagentTimeoutSidecar,
} from "../../src/session/timeout-sidecar.ts";
import { registerSubagentKillTool } from "../../src/tools/kill-tool.ts";
import { registerSubagentResumeTool } from "../../src/tools/resume-tool.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";
import "../support/ambient-spawn-grant.ts";
import { assert, createTestDir, existsSync, writeExecutable, writeFileSync } from "../support/index.ts";
import { assistant, facts, parentToolCtx, sessionHeader, testResultsDir } from "../support/result-fixtures.ts";

/** Runs with the fake Pi command set, then restores it; the ambient spawn grant hook clears the grant. */
async function withFakePi<T>(bin: string, run: () => Promise<T>): Promise<T> {
	const saved = ["PI_SUBAGENT_PI_COMMAND", "PI_ARTIFACT_PROJECT_ROOT"].map(
		(name) => [name, process.env[name]] as const,
	);
	process.env.PI_SUBAGENT_PI_COMMAND = bin;
	try {
		return await run();
	} finally {
		for (const [name, value] of saved) {
			if (value == null) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

function writeBlockedSession(dir: string, name: string): string {
	const sessionFile = join(dir, name);
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: dir })}\n`,
	);
	writeSubagentLaunchMetadataEntry(sessionFile, {
		version: 1,
		timestamp: new Date().toISOString(),
		name: "blocked",
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
	writeSubagentTimeoutSidecar(sessionFile, { kind: "timeout", blocksResume: true, budget: { timeoutSeconds: 30 } });
	return sessionFile;
}

type Watcher = (running: RunningSubagent) => Promise<SubagentResult>;

function createRuntime(watch: Watcher = async () => cleanResult()) {
	return {
		isMuxAvailable: () => true,
		getShellReadyDelayMs: () => 0,
		watchBackgroundSubagent: (running: RunningSubagent) => watch(running),
		watchSubagent: (running: RunningSubagent) => watch(running),
		getWatcherSignal: (_running: unknown, controller: AbortController) => controller.signal,
		startWidgetRefresh: () => {},
		getContextWindow: () => undefined,
		runningSubagents: new Map<string, RunningSubagent>(),
		wireSubagentSteerBack: () => {},
		getLaunchedSubagentResult: async () => ({ content: [], details: {} }),
	};
}

function cleanResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
	return { name: "blocked", task: "t", summary: "done", exitCode: 0, elapsed: 0, ...overrides };
}

/** A watcher that stays in flight until the test releases it, so the test can settle its leases. */
function heldWatcher() {
	let release: (result: SubagentResult) => void = () => {};
	const result = new Promise<SubagentResult>((resolve) => {
		release = resolve;
	});
	return { watch: () => result, release: () => release(cleanResult({ exitCode: 1, resultOutcome: "cancelled" })) };
}

function resumeTool(runtime: ReturnType<typeof createRuntime>) {
	let tool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
	registerSubagentResumeTool(
		{ registerTool: (definition: never) => (tool = definition) } as never,
		() => true,
		runtime as never,
	);
	return tool!;
}

function serviceResume(sessionFile: string, runtime: ReturnType<typeof createRuntime>, operatorOverride = false) {
	return resumeSubagentSession(
		{
			resultsDir: testResultsDir(),
			parentSessionId: "test-parent",
			parent: { parentCwd: process.cwd(), warnings: [] },
			sessionFile,
			mode: "background",
			...(operatorOverride ? { operatorOverride } : {}),
		},
		runtime as never,
	);
}

function waitForExit(running: RunningSubagent): Promise<void> {
	return new Promise((resolve) => {
		const child = running.childProcess;
		if (!child || child.exitCode !== null) resolve();
		else child.once("exit", () => resolve());
	});
}

const BLOCKED = /does not allow a resume/;

describe("resume by run id (D8)", () => {
	it("resumes the session of an earlier result by its run id, and refuses a no-session run with its reason", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "quiet-pi", "#!/usr/bin/env bash\nexit 0\n");
		await withFakePi(bin, async () => {
			process.env.PI_ARTIFACT_PROJECT_ROOT = dir;
			const sessionFile = writeBlockedSession(dir, "earlier.jsonl");
			writeSubagentTimeoutSidecar(sessionFile, { kind: "timeout", blocksResume: false });
			const ctx = parentToolCtx(dir, { hasUI: true });
			const resultsDir = getSessionResultsDir(dir, ctx.sessionManager.getSessionId());
			// A complete D13 record: the store reads only records whose identity and shape are valid.
			const writeRecord = (runId: string, fields: { sessionFile?: string; resume: ResumeFacts }) => {
				const overrides = { runId: parseRunId(runId), ...fields };
				const assembled = assembleResult(facts([sessionHeader(), assistant("earlier")], overrides)).record;
				const record = { ...assembled, sessionFile: fields.sessionFile, report: { saved: false, error: "fixture" } };
				mkdirSync(join(resultsDir, runId), { recursive: true });
				writeFileSync(join(resultsDir, runId, "record.json"), JSON.stringify(record));
			};
			writeRecord("aaaa0001", { sessionFile, resume: { resumable: true } });
			writeRecord("aaaa0002", {
				resume: { resumable: false, reason: "the run had no session file (session-mode: none)" },
			});

			const runtime = createRuntime();
			const started = (await resumeTool(runtime).execute(
				"c1",
				{ runId: "aaaa0001", agent: "fixture-agent" },
				undefined,
				undefined,
				ctx,
			)) as {
				content: { text: string }[];
				details: { id: string; sessionFile: string };
				structuredContent: { status: string; children: Record<string, unknown>[] };
			};
			assert.equal(started.details.sessionFile, sessionFile);
			// D16 (T28): a script gets the resumed child's data; the session file is data, not text.
			assert.deepEqual(started.structuredContent, {
				status: "launched",
				children: [
					{
						runId: started.details.id,
						name: "blocked",
						agent: "fixture-agent",
						sessionFile,
						where: "headless",
						// Owner decision 2026-11-24: the resume's new run folder, where its report lands.
						reportFolder: join(resultsDir, started.details.id),
						state: "started",
					},
				],
			});
			assert.ok(existsSync(join(resultsDir, started.details.id)), "the run folder exists before the reply");
			// D23 (T28 fix round 1): the direct reply has the launch facts: new run id, agent, model, headless.
			const text = started.content[0]?.text ?? "";
			assert.match(
				text,
				new RegExp(`^- blocked \\(agent fixture-agent\\): run ${started.details.id}, model .+, headless$`, "m"),
			);
			assert.match(text, /Each report arrives later/);
			assert.equal(text.includes(sessionFile), false);

			await assert.rejects(
				() => resumeTool(runtime).execute("c2", { runId: "aaaa0002" }, undefined, undefined, ctx),
				/Run aaaa0002 cannot be resumed: the run had no session file \(session-mode: none\)/,
			);
			await assert.rejects(
				() => resumeTool(runtime).execute("c3", { runId: "ffff9999" }, undefined, undefined, ctx),
				/No result with run id "ffff9999"/,
			);
		});
	});

	it("gives a waiting resume the launch facts before the child's report (T28 fix round 1)", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "quiet-pi", "#!/usr/bin/env bash\nexit 0\n");
		await withFakePi(bin, async () => {
			process.env.PI_ARTIFACT_PROJECT_ROOT = dir;
			const sessionFile = writeBlockedSession(dir, "waited.jsonl");
			writeSubagentTimeoutSidecar(sessionFile, { kind: "timeout", blocksResume: false });
			// A parent without UI awaits every resume.
			const ctx = parentToolCtx(dir, { hasUI: false });
			const runtime = {
				...createRuntime(),
				getLaunchedSubagentResult: async (running: RunningSubagent) => ({
					content: [{ type: "text", text: "CHILD-ANSWER" }],
					details: { id: running.id, status: "completed" },
				}),
			};
			const reply = (await resumeTool(runtime as never).execute(
				"c1",
				{ sessionFile, agent: "fixture-agent" },
				undefined,
				undefined,
				ctx,
			)) as {
				content: { text: string }[];
				details: { id: string };
				structuredContent: { children: { state: string; runId: string }[] };
			};
			const text = reply.content.map((block) => block.text).join("\n");
			assert.match(
				text,
				new RegExp(`^- blocked \\(agent fixture-agent\\): run ${reply.details.id}, model .+, headless\\n`),
			);
			assert.match(text, /This call waited for its children; each report follows below\.\n\nCHILD-ANSWER/);
			assert.equal(text.includes(sessionFile), false);
			assert.equal(reply.structuredContent.children[0]?.state, "ended");
		});
	});

	it("stops a running child by its run id", async () => {
		let kill: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
		const stopped: string[] = [];
		registerSubagentKillTool(
			{ registerTool: (definition: never) => (kill = definition) } as never,
			() => true,
			async (running) => {
				stopped.push(running.id);
			},
		);
		const running = { id: "bbbb0001", name: "worker", phase: { kind: "running" } } as RunningSubagent;
		runningSubagents.set(running.id, running);
		try {
			await kill!.execute("k1", { runId: "bbbb0001" });
			assert.deepEqual(stopped, ["bbbb0001"]);
		} finally {
			runningSubagents.delete(running.id);
		}
	});
});

describe("the block-resume verdict stays until the new run ends (D8)", () => {
	it("is replaced by an atomic rename, never by truncation", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "s.jsonl");
		writeSubagentTimeoutSidecar(sessionFile, { kind: "timeout", blocksResume: true });
		const before = statSync(getSubagentTimeoutSidecarPath(sessionFile)).ino;
		writeSubagentTimeoutSidecar(sessionFile, { kind: "idle-timeout", blocksResume: true });
		assert.notEqual(
			statSync(getSubagentTimeoutSidecarPath(sessionFile)).ino,
			before,
			"a new file replaced the old one",
		);
		assert.equal(readSubagentTimeoutSidecar(sessionFile)?.kind, "idle-timeout");
	});

	it("stays while the resumed run is in flight, as for a parent that dies before the outcome", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "quiet-pi", "#!/usr/bin/env bash\nexit 0\n");
		await withFakePi(bin, async () => {
			const sessionFile = writeBlockedSession(dir, "in-flight.jsonl");
			const held = heldWatcher();
			const running = await serviceResume(sessionFile, createRuntime(held.watch), true);
			await waitForExit(running);
			assert.equal(readSubagentTimeoutSidecar(sessionFile)?.blocksResume, true);
			held.release();
			await running.completionPromise;
		});
	});

	it("survives a resume that fails before the child starts, so a second resume is still refused (replay 7b)", async () => {
		const dir = createTestDir();
		await withFakePi(join(dir, "missing-pi"), async () => {
			const sessionFile = writeBlockedSession(dir, "failed-start.jsonl");
			await assert.rejects(() => serviceResume(sessionFile, createRuntime(), true), /ENOENT|spawn/);
			assert.equal(readSubagentTimeoutSidecar(sessionFile)?.blocksResume, true);
			await assert.rejects(() => serviceResume(sessionFile, createRuntime()), BLOCKED);
		});
	});

	it("refuses the second of two resumes of one session started together", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "quiet-pi", "#!/usr/bin/env bash\nexit 0\n");
		await withFakePi(bin, async () => {
			const sessionFile = writeBlockedSession(dir, "twice.jsonl");
			writeSubagentTimeoutSidecar(sessionFile, { kind: "timeout", blocksResume: false });
			const held = heldWatcher();
			const runtime = createRuntime(held.watch);
			const [first, second] = await Promise.allSettled([
				serviceResume(sessionFile, runtime),
				serviceResume(sessionFile, runtime),
			]);
			assert.equal(first.status, "fulfilled");
			assert.equal(second.status, "rejected");
			assert.match(String((second as PromiseRejectedResult).reason), /already being resumed/);
			if (first.status === "fulfilled") {
				await waitForExit(first.value);
				held.release();
				await first.value.completionPromise;
			}
		});
	});

	it("refuses a second resume of one session reached through a symlinked folder alias", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "quiet-pi", "#!/usr/bin/env bash\nexit 0\n");
		await withFakePi(bin, async () => {
			const realDir = join(dir, "real");
			mkdirSync(realDir);
			symlinkSync(realDir, join(dir, "alias"));
			const sessionFile = writeBlockedSession(realDir, "aliased.jsonl");
			const aliasFile = join(dir, "alias", "aliased.jsonl");
			writeSubagentTimeoutSidecar(sessionFile, { kind: "timeout", blocksResume: false });
			const held = heldWatcher();
			const runtime = createRuntime(held.watch);
			const [first, second] = await Promise.allSettled([
				serviceResume(sessionFile, runtime),
				serviceResume(aliasFile, runtime),
			]);
			assert.equal(first.status, "fulfilled");
			assert.equal(second.status, "rejected");
			assert.match(String((second as PromiseRejectedResult).reason), /already being resumed/);
			if (first.status === "fulfilled") {
				await waitForExit(first.value);
				held.release();
				await first.value.completionPromise;
			}

			const other = createRuntime();
			other.runningSubagents.set("cccc0001", {
				id: "cccc0001",
				name: "aliased",
				sessionFile: aliasFile,
			} as RunningSubagent);
			await assert.rejects(() => serviceResume(join(realDir, "..", "real", "aliased.jsonl"), other), /already running/);
		});
	});

	it("stays after an overlay resume with the override whose child is stopped, so a later resume is refused", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "quiet-pi", "#!/usr/bin/env bash\nexit 0\n");
		await withFakePi(bin, async () => {
			const sessionFile = writeBlockedSession(dir, "override-killed.jsonl");
			const running = await serviceResume(
				sessionFile,
				createRuntime(async () =>
					cleanResult({ exitCode: 1, error: "cancelled", summary: "Subagent cancelled.", resultOutcome: "cancelled" }),
				),
				true,
			);
			await running.completionPromise;
			await waitForExit(running);
			assert.equal(readSubagentTimeoutSidecar(sessionFile)?.blocksResume, true);
			await assert.rejects(() => serviceResume(sessionFile, createRuntime()), BLOCKED);
		});
	});

	it("reads the exit record of a child that exits at once, then a clean end removes the verdict", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(
			dir,
			"exit-pi",
			'#!/usr/bin/env bash\nprintf \'{"type":"done","run":"new"}\' > "$PI_SUBAGENT_SESSION.exit"\n',
		);
		await withFakePi(bin, async () => {
			const sessionFile = writeBlockedSession(dir, "exits-at-once.jsonl");
			writeFileSync(getSubagentExitSidecarPath(sessionFile), JSON.stringify({ type: "done", run: "old" }));
			let seen: unknown;
			const running = await serviceResume(
				sessionFile,
				createRuntime(async (child) => {
					await waitForExit(child);
					seen = JSON.parse(readFileSync(getSubagentExitSidecarPath(sessionFile), "utf8"));
					return cleanResult({ resultOutcome: "done" });
				}),
				true,
			);
			await running.completionPromise;
			assert.deepEqual(seen, { type: "done", run: "new" });
			assert.equal(existsSync(getSubagentTimeoutSidecarPath(sessionFile)), false, "a clean end removes the verdict");
		});
	});

	it("is removed when a resumed manual pane publishes success with a nonzero shell status", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "quiet-pi", "#!/usr/bin/env bash\nexit 0\n");
		await withFakePi(bin, async () => {
			const sessionFile = writeBlockedSession(dir, "manual-pane.jsonl");
			// The pane watcher's result for an operator close after an answer: the shell status
			// stays nonzero, and the published record says the run is done (interactive-watch.ts).
			const running = await serviceResume(
				sessionFile,
				createRuntime(async () => cleanResult({ exitCode: 1, resultOutcome: "done" })),
				true,
			);
			await running.completionPromise;
			await waitForExit(running);
			assert.equal(existsSync(getSubagentTimeoutSidecarPath(sessionFile)), false, "the published success removes it");
		});
	});

	it("keeps the verdict a resumed run writes when it times out again", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "quiet-pi", "#!/usr/bin/env bash\nexit 0\n");
		await withFakePi(bin, async () => {
			const sessionFile = writeBlockedSession(dir, "times-out-again.jsonl");
			const running = await serviceResume(
				sessionFile,
				createRuntime(async (child) => {
					writeSubagentTimeoutSidecar(sessionFile, {
						kind: "idle-timeout",
						blocksResume: child.timeoutBlocksResume === true,
					});
					return cleanResult({
						exitCode: 1,
						timedOut: "idle-timeout",
						timedOutAfter: 5,
						timeoutBlocksResume: true,
						resultOutcome: "timed_out",
					});
				}),
				true,
			);
			await running.completionPromise;
			await waitForExit(running);
			assert.deepEqual(readSubagentTimeoutSidecar(sessionFile), { kind: "idle-timeout", blocksResume: true });
		});
	});
});
