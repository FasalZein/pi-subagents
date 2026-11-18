import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupNoSessionSessionFile } from "../../src/launch/prep.ts";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { watchSubagent } from "../../src/runtime/interactive-watch.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import type { RunId } from "../../src/runtime/result-record.ts";
import { NO_SESSION_RESUME_REASON } from "../../src/runtime/run-result.ts";
import { shutdownSubagentsForParentExit, terminateBackgroundChildProcess } from "../../src/runtime/shutdown.ts";
import { writeSubagentExitSidecar } from "../../src/session/exit-sidecar.ts";
import { getInteractiveProcessFile } from "../../src/session/interactive-process.ts";
import type { ParentClosePolicy, RunningSubagent, SubagentResult } from "../../src/types.ts";
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
import { assistantText, END_MARKER, LONG_ANSWER, messageText, START_MARKER } from "../support/result-delivery.ts";

const dirs: string[] = [];
let savedMux: string | undefined;

function makeNoSessionRun(
	mode: "background" | "interactive",
	parentClosePolicy: ParentClosePolicy,
	entries: object[],
): { running: RunningSubagent; store: ResultStore; runId: RunId } {
	const root = createTestDir();
	dirs.push(root);
	const sessionFile = createSessionFile(root, entries);
	const store = new ResultStore(join(root, "results"), () => {});
	const reservation = store.reserve();
	const running: RunningSubagent = {
		id: reservation.runId,
		name: "No-session report",
		task: "Answer at length",
		agent: "scout",
		mode,
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy,
		async: true,
		noSession: true,
		startTime: Date.now(),
		sessionFile,
		...(mode === "background"
			? { childProcess: new EventEmitter() as ChildProcess }
			: { surface: "pi-subagents-nonexistent-surface" }),
		resultTarget: { store, reservation, parentCwd: root, warnings: [] },
	};
	return { running, store, runId: reservation.runId };
}

async function finishNoSessionRun(running: RunningSubagent, exitFacts: object = {}): Promise<SubagentResult> {
	writeSubagentExitSidecar(running.sessionFile, { type: "done", ...exitFacts });
	if (running.mode === "background") {
		const promise = watchBackgroundSubagent(
			running,
			{ cleanupNoSessionSessionFile, terminateBackgroundChildProcess() {} },
			new AbortController().signal,
		);
		running.childProcess!.emit("exit", 0);
		return promise;
	}
	return watchSubagent(
		running,
		{
			cleanupNoSessionSessionFile,
			async closeRunningSurface() {},
			async pollForExit() {
				return { reason: "sentinel", exitCode: 0 };
			},
		} as never,
		new AbortController().signal,
	);
}

const DELETE_ON_EXIT_MODULE = fileURLToPath(new URL("../../src/session/delete-on-exit.ts", import.meta.url));

/**
 * A stand-in for the child process that writes the session file: it registers the child-side
 * deletion hook when that module exists, then appends one last entry after a delay (on SIGTERM or
 * on a timer) and exits, the way Pi's shutdown handler appends by pathname.
 */
const FAKE_CHILD_SCRIPT = `
const { appendFileSync, rmSync, writeFileSync } = await import("node:fs");
const session = process.env.PI_SUBAGENT_SESSION;
try { (await import(process.env.FAKE_HOOK)).deleteMarkedSessionFileOnProcessExit(session); } catch {}
const pidFile = process.env.FAKE_PID_FILE;
if (pidFile) writeFileSync(pidFile, process.pid + "\\n");
const lastWrite = () => setTimeout(() => {
	writeFileSync(session + ".exit", JSON.stringify({ type: "done" }));
	appendFileSync(session, JSON.stringify({ type: "custom", customType: "shutdown-write" }) + "\\n");
	if (pidFile) rmSync(pidFile, { force: true });
	process.exit(0);
}, 300);
if (process.env.FAKE_WRITE_ON === "sigterm") process.on("SIGTERM", lastWrite); else lastWrite();
setInterval(() => {}, 1000);
process.stdout.write("ready\\n");
`;

async function spawnFakeChild(
	sessionFile: string,
	options: { writeOn: "sigterm" | "timer"; pidFile?: string; detached?: boolean },
): Promise<ChildProcess> {
	const child = spawn(process.execPath, ["--input-type=module", "-e", FAKE_CHILD_SCRIPT], {
		env: {
			PATH: process.env.PATH,
			PI_SUBAGENT_SESSION: sessionFile,
			FAKE_HOOK: DELETE_ON_EXIT_MODULE,
			FAKE_WRITE_ON: options.writeOn,
			...(options.pidFile ? { FAKE_PID_FILE: options.pidFile } : {}),
		},
		detached: options.detached === true,
		stdio: ["ignore", "pipe", "inherit"],
	});
	await once(child.stdout!, "data");
	return child;
}

function shutdownRuntime(running: RunningSubagent, escalationMs: number) {
	return {
		runningSubagents: new Map([[running.id, running]]),
		completedSubagentResults: new Map(),
		parentCloseEscalationMs: escalationMs,
		updateWidget() {},
		async closeRunningSurface() {},
		cleanupNoSessionSessionFile,
	};
}

/** D13 (T08b): a no-session child keeps its report through its private temporary session file. */
describe("no-session child results", () => {
	beforeEach(() => {
		savedMux = process.env.PI_SUBAGENT_MUX;
		// The pane watcher's file-polling branch: tmux has no direct-program exit check.
		process.env.PI_SUBAGENT_MUX = "tmux";
	});

	afterEach(() => {
		if (savedMux === undefined) delete process.env.PI_SUBAGENT_MUX;
		else process.env.PI_SUBAGENT_MUX = savedMux;
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	for (const mode of ["background", "interactive"] as const) {
		for (const policy of ["terminate", "continue"] as const) {
			it(`${mode} / ${policy}: keeps both markers in the report and deletes the temporary session file after publication`, async () => {
				const { running, store, runId } = makeNoSessionRun(mode, policy, [assistantText(LONG_ANSWER)]);
				const result = await finishNoSessionRun(running);

				assert.ok(result.reportFile, "the result names its report file");
				const report = readFileSync(result.reportFile, "utf8");
				assert.ok(report.includes(START_MARKER) && report.includes(END_MARKER), "the report keeps both markers");
				assert.equal(existsSync(running.sessionFile), false, "the temporary session file is gone");
				assert.equal(result.sessionFile, undefined, "the result names no deleted session file");

				const record = store.read(runId);
				assert.ok(record, "the record is published");
				assert.equal(record.sessionFile, undefined);
				assert.deepEqual(record.resume, { resumable: false, reason: NO_SESSION_RESUME_REASON });
				assert.match(messageText(result, running), /not resumable: a no-session run keeps no session/);
			});
		}
	}

	it("pane completion: deletes the temporary session file only after the pane child's last shutdown write", async () => {
		const { running } = makeNoSessionRun("interactive", "terminate", [assistantText(LONG_ANSWER)]);
		running.doneSentinelFile = `${running.sessionFile}.done`;
		// The fake pane launcher appends once more on its way out, like Pi's shutdown handler.
		const child = await spawnFakeChild(running.sessionFile, {
			pidFile: getInteractiveProcessFile(running.doneSentinelFile),
			writeOn: "sigterm",
		});
		const exited = once(child, "exit");
		writeSubagentExitSidecar(running.sessionFile, { type: "done" });
		const result = await watchSubagent(
			running,
			{
				cleanupNoSessionSessionFile,
				async closeRunningSurface() {
					child.kill("SIGTERM");
				},
				async pollForExit() {
					return { reason: "done", exitCode: 0 };
				},
			} as never,
			new AbortController().signal,
		);
		await exited;
		assert.equal(child.exitCode, 0, "the child made its last write and exited");
		assert.ok(result.reportFile, "the result is published before the deletion");
		assert.equal(existsSync(running.sessionFile), false, "no file remains after the child's last write");
		assert.equal(existsSync(`${running.sessionFile}.exit`), false, "no late exit record remains");
	});

	it("terminate: a parent quit returns only after the child exited and its temporary session file is gone", async () => {
		const { running } = makeNoSessionRun("background", "terminate", [assistantText(LONG_ANSWER)]);
		// A headless child is a process group leader; it delays its exit after SIGTERM and writes on the way out.
		const child = await spawnFakeChild(running.sessionFile, { writeOn: "sigterm", detached: true });
		running.childProcess = child;
		const watcherAbort = new AbortController();
		running.abortController = watcherAbort;
		running.completionPromise = watchBackgroundSubagent(
			running,
			{ cleanupNoSessionSessionFile, terminateBackgroundChildProcess },
			watcherAbort.signal,
		);
		await shutdownSubagentsForParentExit(shutdownRuntime(running, 2000));
		// The parent process may exit here: nothing after this point deletes the file.
		assert.ok(child.exitCode !== null || child.signalCode !== null, "the child has exited");
		assert.equal(existsSync(running.sessionFile), false, "the temporary session file is gone");
	});

	it("continue: the detached child keeps running and its temporary session file is gone after it exits", async () => {
		const { running, store, runId } = makeNoSessionRun("background", "continue", [assistantText(LONG_ANSWER)]);
		const child = await spawnFakeChild(running.sessionFile, { writeOn: "timer" });
		running.childProcess = child;
		const exited = once(child, "exit");
		// No parent watcher runs after the detach: the parent process is modelled as gone.
		const actions = await shutdownSubagentsForParentExit(shutdownRuntime(running, 2000));
		assert.deepEqual(actions, [{ id: running.id, policy: "continue", action: "continue" }]);
		assert.equal(running.resultTarget, undefined, "no result is delivered for a detached child");
		assert.equal(child.exitCode, null, "the detached child keeps running");
		await exited;
		assert.equal(child.exitCode, 0, "the child made its last write and exited");
		assert.equal(existsSync(running.sessionFile), false, "no file remains after the child's last write");
		assert.equal(existsSync(`${running.sessionFile}.delete-on-exit`), false);
		assert.equal(existsSync(`${running.sessionFile}.exit`), false, "no unconsumed exit record remains");
		assert.equal(store.read(runId), undefined);
	});

	for (const mode of ["background", "interactive"] as const) {
		it(`${mode}: a child that obeyed its final context warning keeps the early-stop reason and the no-session fact`, async () => {
			const { running, store, runId } = makeNoSessionRun(mode, "terminate", [assistantText(LONG_ANSWER)]);
			const result = await finishNoSessionRun(running, { completionReason: "context-pressure" });
			const record = store.read(runId);
			assert.ok(record, "the record is published");
			assert.equal(record.resume.resumable, false);
			for (const text of [record.resume.reason, result.resultText, messageText(result, running)]) {
				assert.match(String(text), /stopped early by its context-warning policy/);
				assert.match(String(text), /no-session run keeps no session/);
			}
		});
	}

	it("a strict time-limit wrap-up sees a marker that the no-session child wrote before the interrupt", async () => {
		const MARKER = "PRE-INTERRUPT-MARKER-7f3a";
		const { running } = makeNoSessionRun("background", "terminate", [assistantText(`working: ${MARKER}`)]);
		running.timeoutBudget = { timeoutSeconds: 2 };
		running.timeoutWarnThreshold = 50;
		const firstChild = running.childProcess!;
		const wrapUpChild = new EventEmitter() as ChildProcess;
		let transcriptAtRestart = "";
		const result = await watchBackgroundSubagent(
			running,
			{
				cleanupNoSessionSessionFile,
				terminateBackgroundChildProcess(_current, signal) {
					if (signal === "SIGTERM") firstChild.emit("exit", 143);
				},
				async restartForTimeoutWrapUp(current) {
					transcriptAtRestart = existsSync(current.sessionFile) ? readFileSync(current.sessionFile, "utf8") : "";
					current.childProcess = wrapUpChild;
					appendFileSync(current.sessionFile, `${JSON.stringify(assistantText("wrap-up report"))}\n`);
					writeSubagentExitSidecar(current.sessionFile, { type: "done" });
					setTimeout(() => wrapUpChild.emit("exit", 0), 50);
				},
			},
			new AbortController().signal,
		);
		assert.ok(transcriptAtRestart.includes(MARKER), "the restart reads the interrupted transcript");
		assert.match(result.summary, /wrap-up report/);
		assert.equal(existsSync(running.sessionFile), false, "the temporary session file is gone after the run");
	});
});
