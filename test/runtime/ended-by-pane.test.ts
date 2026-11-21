import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchSubagent } from "../../src/runtime/interactive-watch.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { SUBAGENT_ACCEPTED_CALL_ENTRY } from "../../src/tools/completion-call.ts";
import { SUBAGENT_DONE_TOOL_NAME } from "../../src/tools/tool-names.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { assert, createTestDir, describe, it, writeExecutable } from "../support/index.ts";
import { cleanupPaneChild, loadPaneChild } from "../support/pane-child.ts";
import { assistant, toolCall, user } from "../support/result-fixtures.ts";

const MUX_ENV_KEYS = ["PATH", "PI_SUBAGENT_MUX", "CMUX_SOCKET_PATH", "ZELLIJ_SESSION_NAME"] as const;
const toolUseEnd = {
	messages: [
		{
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
		},
	],
};
const answerEnd = {
	messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Final answer." }] }],
};

type PaneChild = ReturnType<typeof loadPaneChild>;

/** What the parent has done so far, for a check before the pane really closes (T85). */
interface ParentView {
	published(): boolean;
	surfaceCloses(): number;
	/** Each watcher poll asks the terminal once, after it looked for the exit record. */
	terminalQueries(): number;
}

/**
 * The two pane pollers: cmux has the shell poll (pollForExit reads the screen), zellij the direct
 * poll (pollForProgramSurfaceExit asks whether the pane is live). Each fake counts its queries.
 */
type Poller = "shell poll (cmux)" | "direct poll (zellij)";
const ZELLIJ_SESSION = "fake-zellij-session";

function fakeTerminal(poller: Poller, binDir: string, screenFile: string, queriesFile: string) {
	if (poller === "shell poll (cmux)") {
		writeExecutable(
			binDir,
			"cmux",
			`#!/bin/sh\nif [ "$1" = "read-screen" ]; then echo >> "${queriesFile}"; cat "${screenFile}" || exit 1; fi\n`,
		);
		process.env.PI_SUBAGENT_MUX = "cmux";
		process.env.CMUX_SOCKET_PATH = "fake-cmux-socket";
		return { surface: "surface:1" };
	}
	// The pane stays live: only the child's exit record can end this watch.
	writeExecutable(
		binDir,
		"zellij",
		`#!/bin/sh\necho >> "${queriesFile}"\necho '[{"id":1,"is_plugin":false,"exited":false}]'\n`,
	);
	process.env.PI_SUBAGENT_MUX = "zellij";
	process.env.ZELLIJ_SESSION_NAME = ZELLIJ_SESSION;
	return { surface: "pane:1", zellijTarget: { sessionName: ZELLIJ_SESSION, parentPaneId: 0 } };
}

/**
 * T70 from the pane to the record: the real child extension writes its exit record, and the real
 * watcher and poller publish the run's record. Only the Pi process and the terminal are fakes.
 */
async function paneRun(
	autoExit: boolean,
	act: (child: PaneChild, parent: ParentView) => unknown,
	session: object[] = [],
	poller: Poller = "shell poll (cmux)",
) {
	const binDir = createTestDir();
	const screenFile = join(binDir, "screen");
	writeFileSync(screenFile, "");
	const queriesFile = join(binDir, "queries");
	const savedEnv = Object.fromEntries(MUX_ENV_KEYS.map((key) => [key, process.env[key]]));
	process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
	const terminal = fakeTerminal(poller, binDir, screenFile, queriesFile);
	const child = loadPaneChild({
		autoExit,
		pane: true,
		onNotice: (message) => appendFileSync(screenFile, `${message}\n`),
	});
	const sessionFile = process.env.PI_SUBAGENT_SESSION as string;
	writeFileSync(sessionFile, session.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
	const store = new ResultStore(join(child.dir, "results"), () => {});
	const reservation = store.reserve();
	const running: RunningSubagent = {
		id: reservation.runId,
		name: "pane-child",
		task: "Fix the build",
		agent: "worker",
		mode: "interactive",
		phase: "running",
		parentClosePolicy: "terminate",
		async: true,
		autoExit,
		startTime: Date.now(),
		sessionFile,
		...terminal,
		resultTarget: { store, reservation, parentCwd: child.dir, warnings: [] },
	};
	const controller = new AbortController();
	let surfaceCloses = 0;
	const parent: ParentView = {
		published: () => store.read(reservation.runId) !== undefined,
		surfaceCloses: () => surfaceCloses,
		terminalQueries: () => (existsSync(queriesFile) ? readFileSync(queriesFile, "utf8").length : 0),
	};
	try {
		const watching = watchSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				async closeRunningSurface() {
					surfaceCloses += 1;
				},
			},
			controller.signal,
		);
		await act(child, parent);
		const result = await watching;
		const record = store.read(reservation.runId);
		assert.ok(record, "the watcher published a record");
		return { result, record };
	} finally {
		controller.abort();
		for (const key of MUX_ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		cleanupPaneChild(child.dir);
		rmSync(binDir, { recursive: true, force: true });
	}
}

const quit = (child: PaneChild) => child.emit("session_shutdown", { reason: "quit" });

describe("the pane records who ended the run (T70)", () => {
	it("operator: a person takes over an auto-exit pane, then quits it without a completion call", async () => {
		const { result, record } = await paneRun(true, (child) => {
			child.takeOver();
			quit(child);
		});
		assert.equal(record.outcome, "done");
		assert.equal(record.endedBy, "operator");
		assert.match(String(result.resultText).split("\n")[0], / · ended by operator$/);
	});

	it("operator: a person quits a taken-over pane that kept an unrecovered error", async () => {
		const { result, record } = await paneRun(true, (child) => {
			child.takeOver();
			for (let i = 0; i < 3; i++) child.emit("agent_end", toolUseEnd);
			quit(child);
		});
		assert.equal(record.outcome, "failed");
		assert.equal(record.endedBy, "operator");
		assert.match(String(result.errorMessage), /recovery exhausted/);
	});

	it("operator: a person closes a manual pane", async () => {
		const { record } = await paneRun(false, quit);
		assert.equal(record.endedBy, "operator");
	});

	it("child: a re-armed auto-exit child that ends itself after a call made during the takeover", async () => {
		const args = { outcome: "done", summary: "Recorded during the takeover." };
		const session = [
			user("task"),
			toolCall(SUBAGENT_DONE_TOOL_NAME, args, "d1", "Report."),
			{
				type: "custom",
				id: "acc-d1",
				customType: SUBAGENT_ACCEPTED_CALL_ENTRY,
				data: { toolCallId: "d1", tool: SUBAGENT_DONE_TOOL_NAME, args, autonomous: false },
			},
			assistant("Final answer."),
		];
		const { result, record } = await paneRun(
			true,
			async (child) => {
				child.takeOver();
				await child.commands.get("auto-exit")?.handler("", child.ctx);
				child.emit("agent_start", {});
				// One nudge toward the completion call, then the untyped exit of the child's own.
				child.emit("agent_end", answerEnd);
				child.emit("agent_end", answerEnd);
				const exit = child.readExit();
				assert.equal(exit?.type, "done", "the child wrote its own exit record");
				assert.equal(exit?.endedBy, undefined, "the child's own exit record names no operator");
				quit(child);
			},
			session,
		);
		assert.equal(record.endedBy, "child");
		assert.ok(!String(result.resultText).includes("ended by"));
	});
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const answered = [user("task"), assistant("Final answer.")];

/** Waits for two more terminal queries: the second poll looked for the exit record after the takeover. */
async function assertParentWaits(child: PaneChild, parent: ParentView) {
	const target = parent.terminalQueries() + 2;
	const deadline = Date.now() + 5_000;
	while (parent.terminalQueries() < target && !parent.published() && Date.now() < deadline) await sleep(25);
	assert.ok(parent.terminalQueries() >= target || parent.published(), "the watcher polled after the takeover");
	assert.equal(child.shutdowns, 0, "the child keeps its pane");
	assert.equal(parent.published(), false, "the parent publishes nothing while the person holds the pane");
	assert.equal(parent.surfaceCloses(), 0, "the parent closes no surface while the person holds the pane");
}

// T85 (F2): the child wrote its answer, then a person took over before the pane closed. The parent
// waits for the real close and then delivers the answer written before the takeover.
describe("a takeover after the answer and before the close (T85)", () => {
	for (const poller of ["shell poll (cmux)", "direct poll (zellij)"] as const) {
		it(`answer, ${poller}: the parent waits for the manual close, then names the operator`, async () => {
			const { result, record } = await paneRun(
				true,
				async (child, parent) => {
					child.emit("agent_start", {});
					child.emit("agent_end", answerEnd);
					child.press("h");
					await assertParentWaits(child, parent);
					quit(child);
				},
				answered,
				poller,
			);
			assert.equal(record.outcome, "done");
			assert.equal(record.endedBy, "operator");
			assert.match(String(result.resultText), /Final answer\./);
			assert.match(String(result.resultText).split("\n")[0], / · ended by operator$/);
		});

		it(`caller_ping, ${poller}: the parent waits for the manual close, then delivers the ping`, async () => {
			const message = "Which API key name should I use?";
			const { result, record } = await paneRun(
				true,
				async (child, parent) => {
					child.emit("agent_start", {});
					await child.tools.get("caller_ping").execute("p1", { message }, undefined, undefined, child.ctx);
					child.press("h");
					await assertParentWaits(child, parent);
					quit(child);
				},
				[],
				poller,
			);
			assert.equal(record.outcome, "blocked");
			// T70: a ping is the child's own end, also when a person closes the pane afterwards.
			assert.equal(record.endedBy, "child");
			assert.ok(String(result.resultText).includes(message));
		});
	}

	it("/auto-exit re-arm: the child closes itself and the record names the child", async () => {
		const { result, record } = await paneRun(
			true,
			async (child, parent) => {
				child.emit("agent_start", {});
				child.emit("agent_end", answerEnd);
				child.press("h");
				await assertParentWaits(child, parent);
				await child.commands.get("auto-exit")?.handler("", child.ctx);
				child.emit("agent_start", {});
				child.emit("agent_end", answerEnd);
				await sleep(5);
				assert.equal(child.shutdowns, 1, "the re-armed child closes itself");
				quit(child);
			},
			answered,
		);
		assert.equal(record.outcome, "done");
		assert.equal(record.endedBy, "child");
		assert.ok(!String(result.resultText).includes("ended by"));
	});
});
