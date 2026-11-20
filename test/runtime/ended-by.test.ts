import { join } from "node:path";
import { Value } from "typebox/value";
import { __pollForExitTest__ } from "../../src/mux/poll.ts";
import { watchSubagent } from "../../src/runtime/interactive-watch.ts";
import { assembleResult } from "../../src/runtime/result-assembler.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { ResultRecordSchema } from "../../src/runtime/result-record-schema.ts";
import { publishedResultFields, publishRunResult, type WatchedEnd } from "../../src/runtime/run-result.ts";
import { getSubagentWaitSuccessResult } from "../../src/runtime/wait-result.ts";
import { stopRunningSubagent } from "../../src/runtime/wiring.ts";
import type { SessionEntry } from "../../src/session/session.ts";
import { SUBAGENT_ACCEPTED_CALL_ENTRY } from "../../src/tools/completion-call.ts";
import { registerSubagentKillTool } from "../../src/tools/kill-tool.ts";
import { CALLER_PING_TOOL_NAME, SUBAGENT_DONE_TOOL_NAME } from "../../src/tools/tool-names.ts";
import { SUBAGENT_WRITTEN_FILE_ENTRY } from "../../src/tools/written-files.ts";
import type { CompletedSubagentResult, RunningSubagent } from "../../src/types.ts";
import {
	afterEach,
	assert,
	createSessionFile,
	createTestDir,
	describe,
	getLaunchedSubagentResultForTest,
	it,
	resetSubagentStateForTest,
	rmSync,
	setRunningSubagentForTest,
} from "../support/index.ts";
import { assistant, facts, toolCall, toolResult, user } from "../support/result-fixtures.ts";

const DONE = SUBAGENT_DONE_TOOL_NAME;

/** The rendered text (or summary) of a published result; fails the test when nothing was published. */
function textOf(published: { text: string; summary: string } | undefined, field: "text" | "summary" = "text"): string {
	assert.ok(published, "the run published a result");
	return published[field];
}
const dirs: string[] = [];

function setup(entries: object[], overrides: Partial<RunningSubagent> = {}) {
	const root = createTestDir();
	dirs.push(root);
	const sessionFile = createSessionFile(root, entries);
	const store = new ResultStore(join(root, "results"), () => {});
	const reservation = store.reserve();
	const running = {
		id: reservation.runId,
		name: "worker",
		task: "Work",
		agent: "scout",
		mode: "background",
		phase: "running",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		resultTarget: { store, reservation, parentCwd: root, warnings: [] },
		...overrides,
	} as RunningSubagent;
	return { running, store, reservation, sessionFile, root };
}

function watchedEnd(overrides: Partial<WatchedEnd> = {}): WatchedEnd {
	return {
		exitCode: 0,
		operatorClosed: false,
		closedByPerson: false,
		stopped: false,
		exitSignal: undefined,
		contextUsage: {},
		...overrides,
	};
}

/** A completion call the child's tool accepted; autonomous false means a person had taken over (D11). */
function acceptedEntry(callId: string, args: Record<string, unknown>, autonomous: boolean): SessionEntry {
	return {
		type: "custom",
		id: `acc-${callId}`,
		customType: SUBAGENT_ACCEPTED_CALL_ENTRY,
		data: { toolCallId: callId, tool: DONE, args, autonomous },
	} as unknown as SessionEntry;
}

const DONE_ARGS = { outcome: "done", summary: "All work finished.", artifacts: ["/abs/own.md"] };
const header = { type: "session", id: "h", cwd: "/work/child" };

afterEach(() => {
	resetSubagentStateForTest();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("run records say who ended the run (T70)", () => {
	it("child: a completion call, a ping, an untyped exit and a crash are the child's own end", () => {
		const cases: Array<[object[], Partial<WatchedEnd>]> = [
			[[user("task"), toolCall(DONE, DONE_ARGS, "d1", "Report."), toolResult(DONE, "d1", "ok")], {}],
			[
				[user("task"), toolCall(CALLER_PING_TOOL_NAME, { message: "Need a key." }, "p1")],
				{ ping: { message: "Need a key." } },
			],
			[[user("task"), assistant("Untyped report.")], {}],
			[[user("task"), assistant("Partial.")], { exitCode: 1 }],
		];
		for (const [entries, end] of cases) {
			const { running, store, reservation } = setup(entries);
			const published = publishRunResult(running, watchedEnd(end));
			assert.equal(store.read(reservation.runId)?.endedBy, "child");
			assert.ok(!textOf(published).includes("ended by"), "the common case adds no text");
		}
	});

	it("operator: a person closed a manual pane, with or without an answer", () => {
		const answered = setup([user("task"), assistant("Design notes.")], { mode: "interactive", autoExit: false });
		const closed = publishRunResult(answered.running, watchedEnd({ closedByPerson: true }));
		assert.equal(closed?.record.outcome, "done");
		assert.equal(closed?.record.endedBy, "operator");
		assert.match(textOf(closed).split("\n")[0], / · ended by operator$/);
	});

	it("child: a manual pane's shell status without the child's close record names no person", () => {
		// A child that crashes before its exit record leaves only the launcher's status (review P1).
		const answered = setup([user("task"), assistant("Notes.")], { mode: "interactive", autoExit: false });
		const crashed = publishRunResult(answered.running, watchedEnd({ exitCode: 1, operatorClosed: true }));
		assert.equal(crashed?.record.outcome, "done", "T69's outcome rule stays");
		assert.equal(crashed?.record.endedBy, "child");
		const silent = setup([user("task")], { mode: "interactive", autoExit: false });
		const failed = publishRunResult(silent.running, watchedEnd({ exitCode: 130, operatorClosed: true }));
		assert.equal(failed?.record.outcome, "failed");
		assert.equal(failed?.record.endedBy, "child");
	});

	it("child: a call accepted during a takeover is no evidence of who ended the run later", () => {
		// Re-armed with /auto-exit, the child ended itself after the takeover call (review P1).
		const entries = [
			user("task"),
			toolCall(DONE, DONE_ARGS, "d1", "Report."),
			acceptedEntry("d1", DONE_ARGS, false),
			assistant("Final answer."),
		];
		const { running } = setup(entries, { mode: "interactive", autoExit: true });
		assert.equal(publishRunResult(running, watchedEnd())?.record.endedBy, "child");
	});

	it("operator and parent: a stop names who asked for it", async () => {
		const byOperator = setup([user("task")]);
		await stopRunningSubagent(byOperator.running, { operator: true });
		const operatorEnd = publishRunResult(byOperator.running, watchedEnd({ stopped: true }));
		assert.equal(operatorEnd?.record.outcome, "cancelled");
		assert.equal(operatorEnd?.record.endedBy, "operator");
		// The whole rendering names one actor: the header and the summary agree (review P1).
		assert.match(textOf(operatorEnd), /cancelled: stopped by the operator/);
		assert.ok(!textOf(operatorEnd).includes("stopped by the parent"));

		const byParent = setup([user("task")]);
		await stopRunningSubagent(byParent.running);
		const parentEnd = publishRunResult(byParent.running, watchedEnd({ stopped: true }));
		assert.equal(parentEnd?.record.endedBy, "parent");
		assert.match(textOf(parentEnd).split("\n")[0], / · ended by parent$/);
		assert.match(textOf(parentEnd), /cancelled: stopped by the parent/);
	});

	// T81: expected values from the owner's statecharts answer (2026-11-20): a person pressed Esc, so
	// the record names the operator. subagent_launch and subagent_resume both wait through
	// getLaunchedSubagentResult with the tool call's abort signal.
	it("operator: Esc on a waiting launch or resume; parent: subagent_kill", async () => {
		const escaped = setup([user("task")], { blocking: true, async: undefined });
		escaped.running.completionPromise = new Promise(() => {});
		setRunningSubagentForTest(escaped.running);
		const esc = new AbortController();
		esc.abort();
		const waited = await getLaunchedSubagentResultForTest(escaped.running, esc.signal);
		assert.equal((waited.details as { error?: string }).error, "interrupted");
		const escEnd = publishRunResult(escaped.running, watchedEnd({ stopped: true }));
		assert.equal(escEnd?.record.outcome, "cancelled");
		assert.equal(escEnd?.record.endedBy, "operator");
		assert.match(textOf(escEnd), /cancelled: stopped by the operator/);

		const killed = setup([user("task")]);
		setRunningSubagentForTest(killed.running);
		let killTool: { execute: (id: string, params: { id: string }) => Promise<unknown> } | undefined;
		const pi = { registerTool: (tool: typeof killTool) => (killTool = tool) } as unknown as Parameters<
			typeof registerSubagentKillTool
		>[0];
		registerSubagentKillTool(pi, () => true, stopRunningSubagent);
		assert.ok(killTool, "subagent_kill is registered");
		await killTool.execute("kill-1", { id: killed.running.id });
		const killEnd = publishRunResult(killed.running, watchedEnd({ stopped: true }));
		assert.equal(killEnd?.record.endedBy, "parent");
		assert.match(textOf(killEnd), /cancelled: stopped by the parent/);
	});

	it("time_limit: a hard kill and a report-only wrap-up", () => {
		const killed = setup([user("task"), assistant("Partial.")]);
		const kill = publishRunResult(
			killed.running,
			watchedEnd({ exitCode: 1, timedOut: { kind: "timeout", seconds: 60 } }),
		);
		assert.equal(kill?.record.endedBy, "time_limit");
		assert.match(textOf(kill).split("\n")[0], / · ended by time limit$/);
		const wrapped = setup([user("task"), assistant("Wrap-up report.")], {
			timeoutWrapUp: { kind: "timeout", seconds: 100, threshold: 80 },
			phase: "wrapping-up",
		});
		assert.equal(publishRunResult(wrapped.running, watchedEnd())?.record.endedBy, "time_limit");
	});

	for (const [record, expected] of [
		[{ type: "done", endedBy: "operator" }, "operator"],
		[{ type: "done" }, "child"],
	] as const) {
		it(`a pane watcher files the exit record ${JSON.stringify(record)} as ended by ${expected}`, async () => {
			const savedMux = process.env.PI_SUBAGENT_MUX;
			process.env.PI_SUBAGENT_MUX = "tmux";
			try {
				const { running, store, reservation } = setup([user("task"), assistant("Notes.")], {
					mode: "interactive",
					autoExit: false,
					surface: "pi-subagents-nonexistent-surface",
				});
				const ac = new AbortController();
				const result = await watchSubagent(
					running,
					{
						cleanupNoSessionSessionFile() {},
						async closeRunningSurface() {},
						async pollForExit() {
							return __pollForExitTest__.interpretExitSidecar(record);
						},
					} as never,
					ac.signal,
				);
				assert.equal(store.read(reservation.runId)?.endedBy, expected);
				assert.equal(result.resultEndedBy, expected);
			} finally {
				if (savedMux === undefined) delete process.env.PI_SUBAGENT_MUX;
				else process.env.PI_SUBAGENT_MUX = savedMux;
			}
		});
	}

	it("record readers carry it: the wait details and the record schema", () => {
		const { running, store, reservation } = setup([user("task"), assistant("Notes.")]);
		const published = publishRunResult(running, watchedEnd({ closedByPerson: true }));
		const record = store.read(reservation.runId);
		assert.ok(record && Value.Check(ResultRecordSchema, record));
		const { endedBy: _dropped, ...legacy } = record;
		assert.ok(Value.Check(ResultRecordSchema, legacy), "a record stored before T70 still reads");
		const cached = {
			id: running.id,
			name: "worker",
			summary: textOf(published, "summary"),
			...publishedResultFields(published),
		} as CompletedSubagentResult;
		assert.equal(getSubagentWaitSuccessResult(cached).details.endedBy, "operator");
	});
});

describe("untyped runs list the files they wrote (T70)", () => {
	const written = (path: string): SessionEntry =>
		({
			type: "custom",
			id: `w-${path}`,
			customType: SUBAGENT_WRITTEN_FILE_ENTRY,
			data: { path },
		}) as unknown as SessionEntry;
	const entries = (): SessionEntry[] => [
		header as SessionEntry,
		written("/work/child/before-launch.md"),
		user("task"),
		written("/work/child/notes/report.md"),
		written("/abs/plan.md"),
		written("/work/child/notes/report.md"),
		written("/work/child/design.md"),
		assistant("Report."),
	];

	it("an untyped run lists this run's recorded write targets, deduplicated, in first-write order", () => {
		const { record } = assembleResult(facts(entries(), { launchEntryCount: 2 }));
		assert.equal(record.typed, false);
		assert.deepEqual(record.artifacts, ["/work/child/notes/report.md", "/abs/plan.md", "/work/child/design.md"]);
	});

	it("a published untyped run lists them from its session file", () => {
		const { running, store, reservation } = setup(entries(), { launchEntryCount: 2 });
		publishRunResult(running, watchedEnd());
		assert.deepEqual(store.read(reservation.runId)?.artifacts, [
			"/work/child/notes/report.md",
			"/abs/plan.md",
			"/work/child/design.md",
		]);
	});

	it("a typed run keeps the child's own list", () => {
		const typed = [...entries(), toolCall(DONE, DONE_ARGS, "d1"), toolResult(DONE, "d1", "ok")];
		const { record } = assembleResult(facts(typed, { launchEntryCount: 2 }));
		assert.equal(record.typed, true);
		assert.deepEqual(record.artifacts, ["/abs/own.md"]);
	});
});
