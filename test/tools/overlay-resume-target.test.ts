import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { groupRunEnds, type RunEndMessage } from "../../src/runtime/run-end-message.ts";
import { completedSubagentResults } from "../../src/runtime/state.ts";
import { SubagentsOverlay } from "../../src/tools/subagents-view.ts";
import type { CompletedSubagentResult } from "../../src/types.ts";
import { afterEach, assert, createTestDir, describe, it, resetSubagentStateForTest } from "../support/index.ts";

// T22 fix round 1: overlay actions follow the selected run, not its list position.

const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";

function overlayOn(parentSession: string) {
	const notes: string[] = [];
	const ctx = {
		cwd: createTestDir(),
		ui: { confirm: async () => true, input: async () => "", notify: (text: string) => notes.push(text) },
		sessionManager: { getSessionFile: () => parentSession, getSessionId: () => "parent" },
	} as any;
	const theme = { fg: (_t: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
	const runtime = {
		startWidgetRefresh: () => {},
		runningSubagents: new Map(),
		pi: { on() {} },
		wireSubagentSteerBack: () => {},
	};
	const overlay = new SubagentsOverlay(
		() => {},
		ctx,
		theme,
		runtime as any,
		{ requestRender: () => {}, terminal: { columns: 100 } } as any,
	);
	return { overlay, notes };
}

/** Wait for the asynchronous completed-tab load. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function parentWith(dir: string, messages: object[]): string {
	const file = join(dir, "parent.jsonl");
	writeFileSync(
		file,
		`${messages.map((m) => JSON.stringify({ type: "custom_message", display: true, ...m })).join("\n")}\n`,
	);
	return file;
}

function footer(overlay: SubagentsOverlay): string {
	return overlay.render(100).slice(-3).join("\n");
}

describe("overlay actions follow the selected run (T22)", () => {
	afterEach(() => {
		delete process.env.PI_SUBAGENT_VF_RUN_DIR;
		resetSubagentStateForTest();
	});

	it("the resume hint follows the selected row: none for an ephemeral run", async () => {
		const dir = createTestDir();
		const group = groupRunEnds([
			{
				customType: "subagent_result",
				content: "a",
				display: true,
				details: { id: "eph", name: "eph", status: "completed" },
			} as RunEndMessage,
			{
				customType: "subagent_result",
				content: "b",
				display: true,
				details: { id: "kept", name: "kept", status: "completed", sessionFile: join(dir, "k.jsonl") },
			} as RunEndMessage,
		]);
		const { overlay } = overlayOn(parentWith(dir, [group]));
		try {
			overlay.handleInput(RIGHT);
			await settle();
			assert.doesNotMatch(footer(overlay), /resume/, "ephemeral row selected");
			overlay.handleInput(DOWN);
			assert.match(footer(overlay), /m resume/, "resumable row selected");
		} finally {
			overlay.dispose();
		}
	});

	it("a refresh that reorders rows while the reply editor is open does not redirect the answer", async () => {
		const dir = createTestDir();
		const pingSession = join(dir, "ping.jsonl");
		const group = groupRunEnds([
			{
				customType: "subagent_ping",
				content: "help",
				display: true,
				details: { id: "pinged", name: "pinged", message: "help", sessionFile: pingSession },
			} as RunEndMessage,
		]);
		const { overlay, notes } = overlayOn(parentWith(dir, [group]));
		try {
			overlay.handleInput(RIGHT);
			await settle();
			overlay.handleInput("m");
			// A sibling finishes; its cached row now comes before the recovered ping.
			completedSubagentResults.set("sibling", {
				id: "sibling",
				name: "sibling",
				task: "t",
				summary: "done",
				exitCode: 0,
				elapsed: 1,
				status: "completed",
				sessionFile: join(dir, "sibling.jsonl"),
			} as CompletedSubagentResult);
			(overlay as unknown as { refreshItems(): void }).refreshItems();
			await settle();
			// This env makes the resume refuse with an error that names the session it was given.
			process.env.PI_SUBAGENT_VF_RUN_DIR = dir;
			for (const key of "answer") overlay.handleInput(key);
			overlay.handleInput("\r");
			await settle();
			assert.equal(notes.length, 1, JSON.stringify(notes));
			assert.match(notes[0]!, new RegExp(`Session ${pingSession.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		} finally {
			overlay.dispose();
		}
	});
});
