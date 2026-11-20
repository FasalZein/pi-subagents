import { join } from "node:path";
import { Value } from "typebox/value";
import { watchSubagent } from "../../src/runtime/interactive-watch.ts";
import { assembleResult } from "../../src/runtime/result-assembler.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { ResultRecordSchema } from "../../src/runtime/result-record-schema.ts";
import { publishedResultFields, publishRunResult, type WatchedEnd } from "../../src/runtime/run-result.ts";
import { getSubagentWaitSuccessResult } from "../../src/runtime/wait-result.ts";
import { stopRunningSubagent } from "../../src/runtime/wiring.ts";
import type { SessionEntry } from "../../src/session/session.ts";
import { SUBAGENT_ACCEPTED_CALL_ENTRY } from "../../src/tools/completion-call.ts";
import { CALLER_PING_TOOL_NAME, SUBAGENT_DONE_TOOL_NAME } from "../../src/tools/tool-names.ts";
import type { CompletedSubagentResult, RunningSubagent } from "../../src/types.ts";
import { afterEach, assert, createSessionFile, createTestDir, describe, it, rmSync } from "../support/index.ts";
import { assistant, facts, toolCall, toolResult, user } from "../support/result-fixtures.ts";

const DONE = SUBAGENT_DONE_TOOL_NAME;
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
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("run records say who ended the run (T70)", () => {
	it("child: a completion call, a ping, an untyped exit and a crash are the child's own end", () => {
		const cases: Array<[object[], Partial<WatchedEnd>]> = [
			[[user("task"), toolCall(DONE, DONE_ARGS, "d1", "Report."), toolResult(DONE, "d1", "ok")], {}],
			[[user("task"), toolCall(CALLER_PING_TOOL_NAME, { message: "Need a key." }, "p1")], { ping: { message: "Need a key." } }],
			[[user("task"), assistant("Untyped report.")], {}],
			[[user("task"), assistant("Partial.")], { exitCode: 1 }],
		];
		for (const [entries, end] of cases) {
			const { running, store, reservation } = setup(entries);
			const published = publishRunResult(running, watchedEnd(end));
			assert.equal(store.read(reservation.runId)?.endedBy, "child");
			assert.ok(!published!.text.includes("ended by"), "the common case adds no text");
		}
	});

	it("operator: a person closed a manual pane, with or without an answer", () => {
		const answered = setup([user("task"), assistant("Design notes.")], { mode: "interactive", autoExit: false });
		const closed = publishRunResult(answered.running, watchedEnd({ closedByPerson: true }));
		assert.equal(closed?.record.outcome, "done");
		assert.equal(closed?.record.endedBy, "operator");
		assert.match(closed!.text.split("\n")[0], / · ended by operator$/);

		const silent = setup([user("task")], { mode: "interactive", autoExit: false });
		const failed = publishRunResult(silent.running, watchedEnd({ exitCode: 130, operatorClosed: true }));
		assert.equal(failed?.record.outcome, "failed");
		assert.equal(failed?.record.endedBy, "operator");
	});

	it("operator: a person closed the pane after a takeover and a later completion call", () => {
		const entries = [user("task"), toolCall(DONE, DONE_ARGS, "d1", "Report."), acceptedEntry("d1", DONE_ARGS, false)];
		const { running } = setup(entries, { mode: "interactive", autoExit: true });
		assert.equal(publishRunResult(running, watchedEnd())?.record.endedBy, "operator");
		const autonomous = setup([user("task"), toolCall(DONE, DONE_ARGS, "d1"), acceptedEntry("d1", DONE_ARGS, true)]);
		assert.equal(publishRunResult(autonomous.running, watchedEnd())?.record.endedBy, "child");
	});

	it("operator and parent: a stop names who asked for it", async () => {
		const byOperator = setup([user("task")]);
		await stopRunningSubagent(byOperator.running, { operator: true });
		const operatorEnd = publishRunResult(byOperator.running, watchedEnd({ stopped: true }));
		assert.equal(operatorEnd?.record.outcome, "cancelled");
		assert.equal(operatorEnd?.record.endedBy, "operator");

		const byParent = setup([user("task")]);
		await stopRunningSubagent(byParent.running);
		const parentEnd = publishRunResult(byParent.running, watchedEnd({ stopped: true }));
		assert.equal(parentEnd?.record.endedBy, "parent");
		assert.match(parentEnd!.text.split("\n")[0], / · ended by parent$/);
	});

	it("time_limit: a hard kill and a report-only wrap-up", () => {
		const killed = setup([user("task"), assistant("Partial.")]);
		const kill = publishRunResult(killed.running, watchedEnd({ exitCode: 1, timedOut: { kind: "timeout", seconds: 60 } }));
		assert.equal(kill?.record.endedBy, "time_limit");
		assert.match(kill!.text.split("\n")[0], / · ended by time limit$/);
		const wrapped = setup([user("task"), assistant("Wrap-up report.")], {
			timeoutWrapUp: { kind: "timeout", seconds: 100, threshold: 80 },
			phase: "wrapping-up",
		});
		assert.equal(publishRunResult(wrapped.running, watchedEnd())?.record.endedBy, "time_limit");
	});

	for (const [autoExit, expected] of [
		[false, "operator"],
		[true, "child"],
	] as const) {
		it(`a pane watcher files a plain done record with auto-exit ${autoExit} as ended by ${expected}`, async () => {
			const savedMux = process.env.PI_SUBAGENT_MUX;
			process.env.PI_SUBAGENT_MUX = "tmux";
			try {
				const { running, store, reservation } = setup([user("task"), assistant("Notes.")], {
					mode: "interactive",
					autoExit,
					surface: "pi-subagents-nonexistent-surface",
				});
				const ac = new AbortController();
				const result = await watchSubagent(
					running,
					{
						cleanupNoSessionSessionFile() {},
						async closeRunningSurface() {},
						async pollForExit() {
							return { reason: "done", exitCode: 0 };
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
		const record = store.read(reservation.runId)!;
		assert.ok(Value.Check(ResultRecordSchema, record));
		const { endedBy: _dropped, ...legacy } = record;
		assert.ok(Value.Check(ResultRecordSchema, legacy), "a record stored before T70 still reads");
		const cached = {
			id: running.id,
			name: "worker",
			summary: published!.summary,
			...publishedResultFields(published),
		} as CompletedSubagentResult;
		assert.equal(getSubagentWaitSuccessResult(cached).details.endedBy, "operator");
	});
});

describe("untyped runs list the files they wrote (T70)", () => {
	const nested = (id: string, name: string, path: string, status: "ok" | "error" = "ok") => ({
		id,
		name,
		arguments: { path },
		status,
	});
	const entries = (): SessionEntry[] => [
		header as SessionEntry,
		toolCall("write", { path: "before-launch.md" }, "w0"),
		toolResult("write", "w0", "ok"),
		user("task"),
		toolCall("write", { path: "notes/report.md" }, "w1"),
		toolResult("write", "w1", "ok"),
		toolCall("edit", { path: "/abs/plan.md" }, "e1"),
		toolResult("edit", "e1", "ok"),
		toolCall("write", { path: "denied.md" }, "w2"),
		toolResult("write", "w2", "denied", true),
		toolCall("codemode", { code: "..." }, "c1"),
		toolResult("codemode", "c1", "ok", false, [
			nested("n1", "write", "./notes/report.md"),
			nested("n2", "edit", "design.md"),
			nested("n3", "write", "failed.md", "error"),
			nested("n4", "read", "read-only.md"),
		]),
		toolCall("edit", { path: "/work/child/design.md" }, "e2"),
		toolResult("edit", "e2", "ok"),
		assistant("Report."),
	];

	it("an untyped run lists this run's write and edit paths, absolute, deduplicated, in first-write order", () => {
		const { record } = assembleResult(facts(entries(), { launchEntryCount: 3 }));
		assert.equal(record.typed, false);
		assert.deepEqual(record.artifacts, ["/work/child/notes/report.md", "/abs/plan.md", "/work/child/design.md"]);
	});

	it("a published untyped run lists them from its session file", () => {
		const { running, store, reservation } = setup(entries(), { launchEntryCount: 3 });
		publishRunResult(running, watchedEnd());
		assert.deepEqual(store.read(reservation.runId)?.artifacts, [
			"/work/child/notes/report.md",
			"/abs/plan.md",
			"/work/child/design.md",
		]);
	});

	it("a typed run keeps the child's own list", () => {
		const typed = [...entries(), toolCall(DONE, DONE_ARGS, "d1"), toolResult(DONE, "d1", "ok")];
		const { record } = assembleResult(facts(typed, { launchEntryCount: 3 }));
		assert.equal(record.typed, true);
		assert.deepEqual(record.artifacts, ["/abs/own.md"]);
	});
});
