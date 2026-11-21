import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { endRun } from "../../src/runtime/result-router.ts";
import { completedSubagentResults, runningSubagents, widgetManager } from "../../src/runtime/state.ts";
import { stopRunningSubagent } from "../../src/runtime/wiring.ts";
import { buildCompletedItems, buildRunningItems } from "../../src/tools/overlay/data.ts";
import type { OverlayItem } from "../../src/tools/overlay/render-types.ts";
import type { CompletedSubagentResult, RunningSubagent } from "../../src/types.ts";
import { afterEach, assert, createTestDir, describe, it, resetSubagentStateForTest } from "../support/index.ts";

// T83: the /subagents overlay acts on and shows the run as it is now.

const LAUNCH_METADATA = "pi-subagents_launch_metadata";

function writeSession(file: string, entries: object[]): void {
	writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function launchEntry(data: object) {
	return { type: "custom", customType: LAUNCH_METADATA, data: { version: 1, mode: "background", ...data } };
}

function overlayCtx(notes: string[] = []) {
	const cwd = createTestDir();
	return {
		cwd,
		ui: { notify: (message: string) => notes.push(message) },
		sessionManager: { getSessionFile: () => undefined, getSessionId: () => "parent-session" },
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

function cacheCompletion(sessionFile: string): void {
	completedSubagentResults.set("run-1", {
		id: "run-1",
		name: "worker-1",
		task: "t",
		summary: "done",
		exitCode: 0,
		elapsed: 2,
		status: "completed",
		sessionFile,
	} as CompletedSubagentResult);
}

function field(item: OverlayItem, label: string): string | undefined {
	return item.detailSections.flatMap((section) => section.fields).find((f) => f.label === label)?.value;
}

describe("overlay acts on and shows the run as it is now (T83)", () => {
	afterEach(() => resetSubagentStateForTest());

	it("Kill on a run that ended after the overlay opened sends no signal and says the run already ended", async () => {
		const notes: string[] = [];
		const signals: Array<[number, string | number | undefined]> = [];
		let surfaceCloses = 0;
		const running = runningChild(join(createTestDir(), "child.jsonl"), {
			surface: "fake-surface",
			// closeRunningSurface awaits an open close; this thenable records that a close was awaited.
			surfaceClosePromise: {
				// biome-ignore lint/suspicious/noThenProperty: a thenable that records the awaited close
				then: (resolve: () => void) => {
					surfaceCloses++;
					resolve();
				},
			} as unknown as Promise<void>,
			childProcess: { pid: 999_999_991, kill: () => true } as unknown as RunningSubagent["childProcess"],
		});
		runningSubagents.set(running.id, running);
		const [item] = buildRunningItems(overlayCtx(notes));
		// The run ends while the overlay item stays open.
		endRun(running);
		runningSubagents.delete(running.id);

		const originalKill = process.kill;
		process.kill = ((pid: number, signal?: string | number) => {
			signals.push([pid, signal]);
			return true;
		}) as typeof process.kill;
		try {
			await item.onKill?.();
			// Every caller of the stop, not only the overlay, leaves an ended run as it is.
			await stopRunningSubagent(running, { operator: true });
		} finally {
			process.kill = originalKill;
		}

		assert.deepEqual(signals, []);
		assert.equal(surfaceCloses, 0);
		assert.equal(running.phase, "ended");
		assert.equal(running.stopRequestedBy, undefined);
		assert.deepEqual(notes, ["worker-1 already ended"]);
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

	it("after a resume on model B, Running and Completed show B and keep the grants of the first entry", async () => {
		const sessionFile = join(createTestDir(), "child.jsonl");
		writeSession(sessionFile, [
			launchEntry({ modelRef: "test-a/model-a", modelSource: "agent", tools: "read", allowModelOverride: true }),
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "first run" }] } },
			launchEntry({
				modelRef: "test-b/model-b",
				invocationModelRef: "test-b/model-b",
				model: "test-b/model-b",
				modelSource: "resume-override",
				tools: "read,bash",
				allowModelOverride: true,
			}),
		]);

		const running = runningChild(sessionFile, { modelRef: "test-b/model-b" });
		runningSubagents.set(running.id, running);
		const [runningItem] = buildRunningItems(overlayCtx());
		assert.equal(runningItem.modelRef, "test-b/model-b");
		assert.equal(field(runningItem, "resolved"), "test-b/model-b");
		assert.equal(field(runningItem, "override-model"), "test-b/model-b");
		assert.equal(field(runningItem, "tools"), "read");

		runningSubagents.delete(running.id);
		cacheCompletion(sessionFile);
		const [completedItem] = await buildCompletedItems(overlayCtx());
		assert.equal(completedItem.modelRef, "test-b/model-b");
		assert.equal(field(completedItem, "resolved"), "test-b/model-b");
		assert.equal(field(completedItem, "tools"), "read");
	});
});
