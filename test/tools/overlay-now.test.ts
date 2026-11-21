import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSessionResultsDir } from "../../src/artifact-storage.ts";
import { sessionResultStore } from "../../src/runtime/result-files.ts";
import type { ResultRecord } from "../../src/runtime/result-record.ts";
import { endRun } from "../../src/runtime/result-router.ts";
import { completedSubagentResults, runningSubagents, widgetManager } from "../../src/runtime/state.ts";
import { stopRunningSubagent } from "../../src/runtime/wiring.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import { registerSubagentKillTool } from "../../src/tools/kill-tool.ts";
import { buildCompletedItems, buildRunningItems } from "../../src/tools/overlay/data.ts";
import type { OverlayItem } from "../../src/tools/overlay/render-types.ts";
import { SubagentsOverlay } from "../../src/tools/subagents-view.ts";
import type { CompletedSubagentResult, RunningSubagent } from "../../src/types.ts";
import { afterEach, assert, createTestDir, describe, it, resetSubagentStateForTest } from "../support/index.ts";

// T83: each /subagents overlay row acts on and shows its own run as it is now.

const LAUNCH_METADATA = "pi-subagents_launch_metadata";
const PARENT_SESSION_ID = "parent-session";
const MODEL_A = "test-a/model-a";
const MODEL_B = "test-b/model-b";

function writeSession(file: string, entries: object[]): void {
	writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function launchData(data: Partial<PersistedSubagentLaunchMetadata>): PersistedSubagentLaunchMetadata {
	return { version: 1, mode: "background", denyTools: [], ...data } as PersistedSubagentLaunchMetadata;
}

function launchEntry(data: Partial<PersistedSubagentLaunchMetadata>) {
	return { type: "custom", customType: LAUNCH_METADATA, data: launchData(data) };
}

/** Run B: a resume of the same session on model B. */
const RESUME_B = {
	modelRef: MODEL_B,
	invocationModelRef: MODEL_B,
	model: MODEL_B,
	modelSource: "resume-override" as const,
	tools: "read,bash",
	allowModelOverride: true,
};

function overlayCtx(cwd = createTestDir(), notes: string[] = []) {
	return {
		cwd,
		ui: { notify: (message: string) => notes.push(message) },
		sessionManager: { getSessionFile: () => undefined, getSessionId: () => PARENT_SESSION_ID },
	} as never;
}

function runningChild(sessionFile: string, extra: Partial<RunningSubagent> = {}): RunningSubagent {
	return {
		id: "run-1",
		name: "worker-1",
		task: "t",
		mode: "background",
		phase: "running",
		parentClosePolicy: "terminate",
		startTime: Date.now(),
		sessionFile,
		...extra,
	} as RunningSubagent;
}

function cacheCompletion(sessionFile: string, extra: Partial<CompletedSubagentResult> = {}): void {
	completedSubagentResults.set("run-1", {
		id: "run-1",
		name: "worker-1",
		task: "t",
		summary: "done",
		exitCode: 0,
		elapsed: 2,
		status: "completed",
		sessionFile,
		...extra,
	} as CompletedSubagentResult);
}

/** Publishes one run's record in the parent session's results, as the production publisher does. */
function publishRecord(cwd: string, run: { modelRef: string; sessionFile: string; endedAt: number }): ResultRecord {
	const store = sessionResultStore(getSessionResultsDir(cwd, PARENT_SESSION_ID));
	const reservation = store.reserve();
	return store.publish(reservation, {
		record: {
			runId: reservation.runId,
			name: "worker-1",
			agent: "granted",
			modelRef: run.modelRef,
			outcome: "done",
			endedBy: "child",
			summary: "done",
			sessionFile: run.sessionFile,
			artifacts: [],
			endedAt: run.endedAt,
			elapsedSeconds: 2,
			exit: { code: 0 },
			resume: { resumable: true },
			typed: false,
		},
		report: "done",
		summarySource: "subagent",
	});
}

function field(item: OverlayItem, label: string): string | undefined {
	return item.detailSections.flatMap((section) => section.fields).find((f) => f.label === label)?.value;
}

/** Records every signal and every awaited surface close of the stop path. */
function watchStop(running: RunningSubagent) {
	const seen = { signals: [] as Array<[number, string | number | undefined]>, surfaceCloses: 0 };
	running.surface = "fake-surface";
	// closeRunningSurface awaits an open close; this thenable records that a close was awaited.
	running.surfaceClosePromise = {
		// biome-ignore lint/suspicious/noThenProperty: a thenable that records the awaited close
		then: (resolve: () => void) => {
			seen.surfaceCloses++;
			resolve();
		},
	} as unknown as Promise<void>;
	running.childProcess = { pid: 999_999_991, kill: () => true } as unknown as RunningSubagent["childProcess"];
	const originalKill = process.kill;
	process.kill = ((pid: number, signal?: string | number) => {
		seen.signals.push([pid, signal]);
		return true;
	}) as typeof process.kill;
	return { seen, restore: () => (process.kill = originalKill) };
}

describe("overlay acts on and shows the run as it is now (T83)", () => {
	afterEach(() => resetSubagentStateForTest());

	it("k then Enter on a run that ends between the keys sends no signal and says the run already ended", async () => {
		const notes: string[] = [];
		const running = runningChild(join(createTestDir(), "child.jsonl"));
		runningSubagents.set(running.id, running);
		const ctx = { ...(overlayCtx(createTestDir(), notes) as object), hasUI: true };
		const tui = { requestRender: () => {}, terminal: { columns: 80 } } as never;
		const runtime = { startWidgetRefresh: () => {} };
		const theme = { fg: (_t: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
		const overlay = new SubagentsOverlay((() => {}) as never, ctx as never, theme as never, runtime as never, tui);
		const stop = watchStop(running);
		try {
			overlay.handleInput("k");
			assert.ok(overlay.render(80).join("\n").includes("Kill subagent?"));
			// The run ends while the confirmation is open.
			endRun(running);
			runningSubagents.delete(running.id);
			overlay.handleInput("\r");
			await new Promise((resolve) => setImmediate(resolve));
			// Every caller of the stop, not only the overlay, leaves an ended run as it is.
			await stopRunningSubagent(running, { operator: true });
		} finally {
			stop.restore();
			overlay.dispose();
		}

		assert.deepEqual(stop.seen.signals, []);
		assert.equal(stop.seen.surfaceCloses, 0);
		assert.equal(running.phase, "ended");
		assert.equal(running.stopRequestedBy, undefined);
		assert.deepEqual(notes, ["worker-1 already ended"]);
	});

	it("subagent_kill on an ended run that its watcher still holds reports the end and sends no signal", async () => {
		// An adopted watcher ends the run before it awaits delivery and leaves the map only after it.
		const running = runningChild(join(createTestDir(), "child.jsonl"));
		runningSubagents.set(running.id, running);
		endRun(running);
		let killTool: { execute: (id: string, params: { runId: string }) => Promise<unknown> } | undefined;
		const pi = { registerTool: (tool: typeof killTool) => (killTool = tool) } as never;
		registerSubagentKillTool(
			pi,
			() => true,
			(child) => stopRunningSubagent(child),
		);
		assert.ok(killTool, "subagent_kill is registered");
		const stop = watchStop(running);
		let result: { content: Array<{ text: string }>; details: { status?: string } };
		try {
			result = (await killTool.execute("kill-1", { runId: running.id })) as typeof result;
		} finally {
			stop.restore();
		}
		assert.deepEqual(stop.seen.signals, []);
		assert.equal(running.phase, "ended");
		assert.equal(result.details.status, "ended");
		assert.equal(result.content[0].text, `Subagent "worker-1" (run-1) already ended.`);
	});

	it("one tool call with its result counts as one in Running and Completed", async () => {
		const sessionFile = join(createTestDir(), "child.jsonl");
		writeSession(sessionFile, [
			launchEntry({}),
			{ type: "message", message: { role: "user", content: "go" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash" }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "c1" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
		]);

		const running = runningChild(sessionFile);
		runningSubagents.set(running.id, running);
		// The live refresh reads the child session, as the widget does every tick.
		widgetManager.attachContext({
			hasUI: true,
			ui: { theme: { fg: (_t: string, s: string) => s, bold: (s: string) => s }, setWidget: () => {} },
		} as never);
		const [runningItem] = buildRunningItems(overlayCtx());
		assert.equal(field(runningItem, "tool uses"), "1");
		assert.ok(runningItem.stats.includes("1 tool"), JSON.stringify(runningItem.stats));

		runningSubagents.delete(running.id);
		cacheCompletion(sessionFile);
		const [completedItem] = await buildCompletedItems(overlayCtx());
		assert.equal(field(completedItem, "tool calls"), "1");
		assert.ok(completedItem.stats.includes("1 tool"), JSON.stringify(completedItem.stats));
	});

	it("each row shows its own run's model: run A while B runs on model B, then B after it ends", async () => {
		const cwd = createTestDir();
		const sessionFile = join(cwd, "child.jsonl");
		const runA = launchData({ modelRef: MODEL_A, modelSource: "agent", tools: "read", allowModelOverride: true });
		writeSession(sessionFile, [
			{ type: "custom", customType: LAUNCH_METADATA, data: runA },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "first run" }] } },
		]);
		publishRecord(cwd, { modelRef: MODEL_A, sessionFile, endedAt: 1_000 });
		// B resumes on model B and appends its metadata.
		writeSession(sessionFile, [
			{ type: "custom", customType: LAUNCH_METADATA, data: runA },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "first run" }] } },
			launchEntry(RESUME_B),
		]);
		const runB = runningChild(sessionFile, { id: "run-b", modelRef: MODEL_B, launchMetadata: launchData(RESUME_B) });
		runningSubagents.set(runB.id, runB);

		const [runningItem] = buildRunningItems(overlayCtx(cwd));
		assert.equal(runningItem.modelRef, MODEL_B);
		assert.equal(field(runningItem, "resolved"), MODEL_B);
		assert.equal(field(runningItem, "override-model"), MODEL_B);
		assert.equal(field(runningItem, "tools"), "read");
		const [rowA] = await buildCompletedItems(overlayCtx(cwd));
		assert.equal(rowA.modelRef, MODEL_A);
		assert.equal(field(rowA, "resolved"), MODEL_A);
		assert.equal(field(rowA, "override-model"), undefined);

		runningSubagents.delete(runB.id);
		publishRecord(cwd, { modelRef: MODEL_B, sessionFile, endedAt: 2_000 });
		const [rowB] = await buildCompletedItems(overlayCtx(cwd));
		assert.equal(rowB.modelRef, MODEL_B);
		assert.equal(field(rowB, "resolved"), MODEL_B);
		assert.equal(field(rowB, "override-model"), MODEL_B);
		assert.equal(field(rowB, "tools"), "read");
	});

	it("a resume on model B whose metadata append failed still shows B in Running and Completed", async () => {
		const sessionFile = join(createTestDir(), "child.jsonl");
		// Only run A's entry: B's append failed after B started.
		writeSession(sessionFile, [launchEntry({ modelRef: MODEL_A, modelSource: "agent", allowModelOverride: true })]);
		const runB = runningChild(sessionFile, { modelRef: MODEL_B, launchMetadata: launchData(RESUME_B) });
		runningSubagents.set(runB.id, runB);
		const [runningItem] = buildRunningItems(overlayCtx());
		assert.equal(runningItem.modelRef, MODEL_B);
		assert.equal(field(runningItem, "resolved"), MODEL_B);

		runningSubagents.delete(runB.id);
		cacheCompletion(sessionFile, { modelRef: MODEL_B });
		const [completedItem] = await buildCompletedItems(overlayCtx());
		assert.equal(completedItem.modelRef, MODEL_B);
		assert.equal(field(completedItem, "resolved"), MODEL_B);
	});

	it("both views show the first launch entry's saved grants, not the changed definition", async () => {
		const agentDir = createTestDir();
		mkdirSync(join(agentDir, "agents"));
		// The definition as it reads now: other grants than the run got at launch.
		writeFileSync(
			join(agentDir, "agents", "granted.md"),
			"---\nname: granted\ntools: read,bash,write\nskills: other\ninject-skills: other\nspawning: true\nextensions: ext-now\n---\nAgent.\n",
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const sessionFile = join(createTestDir(), "child.jsonl");
		writeSession(sessionFile, [
			// Saved at launch: deny bash, tools read, no skills setting (all), no extensions, one spawnable agent.
			launchEntry({ agent: "granted", tools: "read", denyTools: ["bash"], extensions: [], spawnableAgents: ["scout"] }),
			launchEntry({ ...RESUME_B, tools: "read,bash,write", denyTools: [], spawnableAgents: true }),
		]);
		const expected = {
			tools: "read",
			"deny-tools": "bash",
			skills: "all",
			"inject-skills": "none",
			spawning: "scout",
			extensions: "none",
		};
		const running = runningChild(sessionFile, { agent: "granted", modelRef: MODEL_B });
		runningSubagents.set(running.id, running);
		const [runningItem] = buildRunningItems(overlayCtx());
		runningSubagents.delete(running.id);
		cacheCompletion(sessionFile, { agent: "granted", modelRef: MODEL_B });
		const [completedItem] = await buildCompletedItems(overlayCtx());
		for (const item of [runningItem, completedItem]) {
			const shown = Object.fromEntries(Object.keys(expected).map((label) => [label, field(item, label)]));
			assert.deepEqual(shown, expected);
		}
	});
});
