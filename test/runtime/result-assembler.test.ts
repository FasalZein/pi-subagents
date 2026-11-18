import { assembleResult, NO_REPORT_LINE } from "../../src/runtime/result-assembler.ts";
import { CUT_MARK, SUMMARY_MAX_CHARS } from "../../src/runtime/result-record.ts";
import { CALLER_PING_TOOL_NAME, SUBAGENT_DONE_TOOL_NAME } from "../../src/tools/tool-names.ts";
import { assistant, facts, sessionHeader, syntheticReport, toolCall, toolResult, user } from "../support/result-fixtures.ts";
import { assert, describe, it } from "../support/index.ts";

const DONE = SUBAGENT_DONE_TOOL_NAME;

describe("result assembler: outcomes", () => {
	for (const outcome of ["done", "partial", "blocked"] as const) {
		it(`a valid completion call gives a typed ${outcome} result`, () => {
			const { record, report } = assembleResult(
				facts([
					sessionHeader(),
					user("task"),
					assistant("Full report text."),
					toolCall(DONE, { outcome, summary: "Short summary.", artifacts: ["/tmp/a.md", 3] }, "c1"),
					toolResult(DONE, "c1", "ok"),
				]),
			);
			assert.equal(record.outcome, outcome);
			assert.equal(record.typed, true);
			assert.equal(record.summary, "Short summary.");
			assert.equal(report, "Full report text.");
			assert.deepEqual(record.artifacts, ["/tmp/a.md"]);
		});
	}

	it("a failed run is untyped and failed, with the error in the exit facts", () => {
		const { record, report } = assembleResult(
			facts([sessionHeader(), user("task")], { end: { kind: "failed", error: "provider 529", code: 1 } }),
		);
		assert.equal(record.outcome, "failed");
		assert.equal(record.typed, false);
		assert.equal(record.exit.error, "provider 529");
		assert.equal(report, `${record.summary}\n\n${NO_REPORT_LINE}`);
		assert.match(record.summary, /provider 529/);
	});

	it("a timed-out wrap-up is untyped and timed out, built from its text", () => {
		const { record, report } = assembleResult(
			facts([sessionHeader(), user("task"), assistant("Wrap-up: half done.")], {
				end: { kind: "timed_out", budget: "timeout", seconds: 600, wrapUp: true },
			}),
		);
		assert.equal(record.outcome, "timed_out");
		assert.equal(record.typed, false);
		assert.deepEqual(record.timeLimit, { kind: "timeout", seconds: 600, wrapUp: true });
		assert.equal(record.summary, "Wrap-up: half done.");
		assert.equal(report, "Wrap-up: half done.");
	});

	it("a stopped run is untyped and cancelled", () => {
		const { record } = assembleResult(
			facts([sessionHeader(), assistant("partial notes")], { end: { kind: "cancelled", reason: "stopped by parent" } }),
		);
		assert.equal(record.outcome, "cancelled");
		assert.equal(record.typed, false);
		assert.equal(record.summary, "partial notes");
	});

	it("a caller_ping is a typed blocked result whose full message is the report", () => {
		const message = "x".repeat(SUMMARY_MAX_CHARS + 300);
		const { record, report } = assembleResult(
			facts([sessionHeader(), assistant("earlier text"), toolCall(CALLER_PING_TOOL_NAME, { message }, "p1")]),
		);
		assert.equal(record.outcome, "blocked");
		assert.equal(record.typed, true);
		assert.equal(report, message);
		assert.ok(record.summary.length <= SUMMARY_MAX_CHARS);
		assert.ok(record.summary.endsWith(CUT_MARK));
	});

	it("elapsed time comes from the start and end times", () => {
		assert.equal(assembleResult(facts([sessionHeader()])).record.elapsedSeconds, 65);
	});
});

describe("result assembler: typed and untyped", () => {
	const untypedCalls: Array<[string, Record<string, unknown>]> = [
		["the old call with no arguments", {}],
		["an unknown outcome", { outcome: "failed", summary: "s" }],
		["an empty summary", { outcome: "done", summary: "   " }],
		["a summary that is not a string", { outcome: "done", summary: 42 }],
	];
	for (const [label, args] of untypedCalls) {
		it(`${label} ends the run untyped`, () => {
			const { record, report } = assembleResult(
				facts([sessionHeader(), assistant("Last text."), toolCall(DONE, args, "c1"), toolResult(DONE, "c1", "ok")]),
			);
			assert.equal(record.typed, false);
			assert.equal(record.outcome, "done");
			assert.equal(record.summary, "Last text.");
			assert.equal(report, "Last text.");
			assert.equal(record.data, undefined);
			assert.equal(record.dataError, undefined);
		});
	}

	it("without a call the summary is the report start cut at a line end within the limit", () => {
		const text = syntheticReport(4_964);
		const { record, report } = assembleResult(facts([sessionHeader(), assistant(text)]));
		assert.equal(record.typed, false);
		assert.equal(report, text);
		assert.ok(record.summary.length <= SUMMARY_MAX_CHARS);
		assert.ok(record.summary.endsWith(CUT_MARK));
		const kept = record.summary.slice(0, -CUT_MARK.length);
		assert.ok(text.startsWith(kept));
		assert.equal(text[kept.length], "\n", "the cut falls on a line end");
	});

	it("a refused completion call does not count; the accepted second one does", () => {
		const long = "s".repeat(SUMMARY_MAX_CHARS + 100);
		const { record, report } = assembleResult(
			facts([
				sessionHeader(),
				assistant("Report body."),
				toolCall(DONE, { outcome: "done", summary: long }, "c1"),
				toolResult(DONE, "c1", "summary over 1500 characters", true),
				toolCall(DONE, { outcome: "partial", summary: long }, "c2"),
				toolResult(DONE, "c2", "ok"),
			]),
		);
		assert.equal(record.typed, true);
		assert.equal(record.outcome, "partial");
		assert.ok(record.summary.length <= SUMMARY_MAX_CHARS);
		assert.ok(record.summary.endsWith(CUT_MARK));
		assert.equal(report, `${long}\n\nReport body.`);
	});

	it("a call with a data error is typed with the error and no data", () => {
		const { record } = assembleResult(
			facts([sessionHeader(), toolCall(DONE, { outcome: "done", summary: "s", data: { bad: true } }, "c1")], {
				dataError: "data/count: must be integer",
			}),
		);
		assert.equal(record.typed, true);
		assert.equal(record.dataError, "data/count: must be integer");
		assert.equal(record.data, undefined);
	});

	it("a call carries its data", () => {
		const { record } = assembleResult(
			facts([sessionHeader(), toolCall(DONE, { outcome: "done", summary: "s", data: { count: 2 } }, "c1")]),
		);
		assert.deepEqual(record.data, { count: 2 });
	});

	it("assistant text after the call (a takeover) makes the result untyped, from that text", () => {
		const { record, report } = assembleResult(
			facts([
				sessionHeader(),
				assistant("before"),
				toolCall(DONE, { outcome: "done", summary: "s" }, "c1"),
				toolResult(DONE, "c1", "ok"),
				user("operator: one more thing"),
				assistant("after the takeover"),
			]),
		);
		assert.equal(record.typed, false);
		assert.equal(report, "after the takeover");
	});
});

describe("result assembler: report source (D12)", () => {
	it("the report is the last assistant text before the call, never later tool output", () => {
		const { report } = assembleResult(
			facts([
				sessionHeader(),
				assistant("first draft"),
				assistant("final report"),
				toolCall("bash", { command: "ls" }, "b1"),
				toolResult("bash", "b1", "BASH OUTPUT"),
				toolCall(DONE, { outcome: "done", summary: "s" }, "c1"),
			]),
		);
		assert.equal(report, "final report");
	});

	it("a trailing bash result is ignored without a call", () => {
		const { record, report } = assembleResult(
			facts([
				sessionHeader(),
				assistant("the real report"),
				toolCall("bash", { command: "cat log" }, "b1"),
				toolResult("bash", "b1", "BASH OUTPUT"),
			]),
		);
		assert.equal(report, "the real report");
		assert.equal(record.summary, "the real report");
	});

	it("text from before the launch entry count never counts", () => {
		const entries = [sessionHeader(), assistant("fork history text"), user("new task"), user("nudge")];
		const { record, report } = assembleResult(facts(entries, { launchEntryCount: 2, end: { kind: "exited" } }));
		assert.ok(!report.includes("fork history"));
		assert.equal(report, `${record.summary}\n\n${NO_REPORT_LINE}`);
	});

	it("a typed call with no assistant text gives the summary plus the no-report line", () => {
		const { record, report } = assembleResult(
			facts([sessionHeader(), toolCall(DONE, { outcome: "done", summary: "All good." }, "c1")]),
		);
		assert.equal(record.summary, "All good.");
		assert.equal(report, `All good.\n\n${NO_REPORT_LINE}`);
	});

	it("text before the nudge wins over text after it", () => {
		const entries = [sessionHeader(), assistant("before nudge"), user("call subagent_done"), assistant("after nudge")];
		assert.equal(assembleResult(facts(entries, { nudgeEntryIndex: 2 })).report, "before nudge");
	});

	it("text after the nudge counts when there was none before it", () => {
		const entries = [sessionHeader(), user("task"), user("call subagent_done"), assistant("after nudge")];
		assert.equal(assembleResult(facts(entries, { nudgeEntryIndex: 2 })).report, "after nudge");
	});

	it("a call after the nudge takes the last text before the call", () => {
		const entries = [
			sessionHeader(),
			assistant("before nudge"),
			user("call subagent_done"),
			assistant("after nudge"),
			toolCall(DONE, { outcome: "done", summary: "s" }, "c1"),
		];
		assert.equal(assembleResult(facts(entries, { nudgeEntryIndex: 2 })).report, "after nudge");
	});

	it("text in the same message before the call counts", () => {
		const { report } = assembleResult(
			facts([sessionHeader(), toolCall(DONE, { outcome: "done", summary: "s" }, "c1", "inline report")]),
		);
		assert.equal(report, "inline report");
	});
});
