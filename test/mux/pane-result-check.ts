import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { MuxBackendAdapter } from "../../src/mux/backend.ts";
import { watchSubagent } from "../../src/runtime/interactive-watch.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { RESULT_TEXT_MAX_CHARS } from "../../src/runtime/result-render.ts";
import { getSubagentExitSidecarPath, writeSubagentExitSidecar } from "../../src/session/exit-sidecar.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";
import { assert, createSessionFile } from "../support/index.ts";
import {
	assistantText,
	END_MARKER,
	LONG_ANSWER,
	messageText,
	START_MARKER,
	waitText,
} from "../support/result-delivery.ts";

/** Makes the fake drop the surface during its next liveness query, after it writes one file (the child's exit). */
export type VanishDuringLivenessQuery = (surface: string, file: { path: string; content: string }) => void;

interface PaneRun {
	running: RunningSubagent;
	store: ResultStore;
	closed: string[];
	watch(): Promise<SubagentResult>;
}

function startPaneRun(
	adapter: MuxBackendAdapter,
	root: string,
	surface: string,
	extra: Partial<RunningSubagent> = {},
): PaneRun {
	assert.equal(LONG_ANSWER.length, 20_000);
	const sessionFile = createSessionFile(root, [assistantText(LONG_ANSWER)]);
	const store = new ResultStore(join(root, "results"), () => {});
	const reservation = store.reserve();
	const running: RunningSubagent = {
		id: reservation.runId,
		name: "Long pane answer",
		task: "Answer at length",
		agent: "scout",
		mode: "interactive",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		surface,
		resultTarget: { store, reservation, parentCwd: root, warnings: [] },
		...extra,
	};
	const closed: string[] = [];
	const watch = () =>
		watchSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				async closeRunningSurface(current) {
					closed.push(current.surface ?? "");
					await adapter.closeSurface(current.surface ?? "", current.zellijTarget);
				},
			},
			new AbortController().signal,
		);
	return { running, store, closed, watch };
}

/**
 * Both carriers show one capped text that names the report; the report locator, resolved from the
 * parent's cwd as the parent's read tool resolves it, holds the whole answer.
 */
async function assertCappedWithReport(result: SubagentResult, running: RunningSubagent, root: string): Promise<string> {
	const message = messageText(result, running);
	assert.ok(message.length <= RESULT_TEXT_MAX_CHARS, `text is ${message.length} characters: ${message.slice(0, 300)}`);
	assert.ok(message.includes(START_MARKER), message);
	assert.ok(!message.includes(END_MARKER));
	assert.ok(message.includes(`run: ${running.id}`), message);
	const locator = message.match(/^report: (.+)$/m)?.[1];
	assert.ok(locator, "the text names its report file");
	const shown = locator.startsWith("~/") ? join(homedir(), locator.slice(2)) : resolve(root, locator);
	assert.equal(readFileSync(shown, "utf8"), LONG_ANSWER);
	assert.equal(result.reportFile, shown);
	assert.equal(await waitText(result, running), message);
	return message;
}

/**
 * T08a (D13, D14): a pane child on this backend's fake ends with a 20,000-character last message.
 * The real watcher polls the fake surface, reads the exit record, publishes the result and closes
 * the surface. The message path and the waiting launch must show one capped text that names the
 * report file, and the report file must hold the whole answer.
 */
export async function checkPaneResultThroughAssembler(adapter: MuxBackendAdapter, root: string): Promise<void> {
	const surface = await adapter.createSurface("Pane Result");
	const run = startPaneRun(adapter, root, surface);
	const watching = run.watch();
	// The watcher has polled once without an exit record; the child's completion tool writes it now.
	writeSubagentExitSidecar(run.running.sessionFile, { type: "done" });
	const result = await watching;

	assert.deepEqual(run.closed, [surface], "the watcher closes the pane once");
	await assertCappedWithReport(result, run.running, root);
}

/**
 * T08a review P1: an operator closes a manual pane (auto-exit: false) after its real final answer;
 * the shell's exit trap records a nonzero status and the child wrote no error. The close is a
 * successful end: both carriers show the capped text naming the report, and the stored record keeps
 * the actual exit code.
 */
export async function checkManualPaneCloseWithNonzeroStatus(adapter: MuxBackendAdapter, root: string): Promise<void> {
	const surface = await adapter.createSurface("Manual Pane");
	const doneSentinelFile = join(root, "manual.done");
	const run = startPaneRun(adapter, root, surface, { autoExit: false, doneSentinelFile });
	const watching = run.watch();
	// The pane's shell writes its exit status after the operator closes the pane.
	await new Promise((resolveTick) => setTimeout(resolveTick, 20));
	writeFileSync(doneSentinelFile, "__SUBAGENT_DONE_1__\n");
	const result = await watching;

	await assertCappedWithReport(result, run.running, root);
	assert.equal(result.exitCode, 1, "the result keeps the shell's exit code");
	const target = run.running.resultTarget;
	assert.ok(target);
	const record = target.store.read(target.reservation.runId);
	assert.equal(record?.exit.code, 1, "the record keeps the shell's exit code");
	assert.equal(record?.outcome, "done");
}

/**
 * T08a review P1: a direct-program pane child writes its done record and exits while the watcher's
 * liveness query is in flight, so the query reports the pane gone. The done record decides the
 * outcome: both carriers show the capped text naming the report, not a watcher error.
 */
export async function checkProgramPaneExitDuringLivenessQuery(
	adapter: MuxBackendAdapter,
	root: string,
	vanish: VanishDuringLivenessQuery,
): Promise<void> {
	assert.ok(adapter.openProgramSession, "the fixture declares openProgramSession; the adapter lacks it");
	const session = await adapter.openProgramSession();
	const surface = await session.start("Program Pane", { shellCommand: "true", launcherArgv: ["true"] });
	const run = startPaneRun(adapter, root, surface, { zellijTarget: session.target });
	vanish(surface, {
		path: getSubagentExitSidecarPath(run.running.sessionFile),
		content: JSON.stringify({ type: "done" }),
	});
	const result = await run.watch();

	assert.equal(result.error, undefined, result.summary);
	await assertCappedWithReport(result, run.running, root);
}
