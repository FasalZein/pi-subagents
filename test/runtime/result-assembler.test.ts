import { assembleResult, NO_REPORT_LINE } from "../../src/runtime/result-assembler.ts";
import { CUT_MARK, SUMMARY_MAX_CHARS } from "../../src/runtime/result-record.ts";
import type { SessionEntry } from "../../src/session/session.ts";
import { SUBAGENT_ACCEPTED_CALL_ENTRY } from "../../src/tools/completion-call.ts";
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
			facts([
				sessionHeader(),
				assistant("earlier text"),
				toolCall(CALLER_PING_TOOL_NAME, { message }, "p1"),
				toolResult(CALLER_PING_TOOL_NAME, "p1", "ok"),
			]),
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
		const args = { outcome: "done", summary: "s", data: { bad: true } };
		const fromExit = assembleResult(
			facts([sessionHeader(), toolCall(DONE, args, "c1"), toolResult(DONE, "c1", "ok")], {
				acceptedCall: { toolCallId: "c1", args, dataError: "data/count: must be integer" },
			}),
		).record;
		const fromSession = assembleResult(
			facts([
				sessionHeader(),
				toolCall(DONE, args, "c1"),
				{
					type: "custom",
					id: "acc-1",
					customType: SUBAGENT_ACCEPTED_CALL_ENTRY,
					data: { toolCallId: "c1", tool: DONE, args, autonomous: true, dataError: "data/count: must be integer" },
				} as unknown as SessionEntry,
			]),
		).record;
		for (const record of [fromExit, fromSession]) {
			assert.equal(record.typed, true);
			assert.equal(record.dataError, "data/count: must be integer");
			assert.equal(record.data, undefined);
		}
	});

	// T64 review P2: Pi coerces after prepareArguments, so the executed arguments are the source.
	it("a call's executed arguments win over its raw JSON-string arguments; raw ones are parsed as fallback", () => {
		const raw = { outcome: "done", summary: "s", data: '{"count":2}', artifacts: '["report.md",42]' };
		const call = [sessionHeader(), toolCall(DONE, raw, "c1"), toolResult(DONE, "c1", "ok")];
		const executed = { ...raw, data: { count: 2 }, artifacts: ["report.md", "42"] };
		const accepted = assembleResult(facts(call, { acceptedCall: { toolCallId: "c1", args: executed } })).record;
		assert.deepEqual(accepted.artifacts, ["report.md", "42"]);
		const fallback = assembleResult(facts(call)).record;
		assert.deepEqual(fallback.data, { count: 2 });
	});

	it("a call carries its data", () => {
		const { record } = assembleResult(
			facts([sessionHeader(), toolCall(DONE, { outcome: "done", summary: "s", data: { count: 2 } }, "c1"), toolResult(DONE, "c1", "ok")]),
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
				toolResult(DONE, "c1", "ok"),
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
			facts([sessionHeader(), toolCall(DONE, { outcome: "done", summary: "All good." }, "c1"), toolResult(DONE, "c1", "ok")]),
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
			toolResult(DONE, "c1", "ok"),
		];
		assert.equal(assembleResult(facts(entries, { nudgeEntryIndex: 2 })).report, "after nudge");
	});

	it("text in the same message before the call counts", () => {
		const { report } = assembleResult(
			facts([sessionHeader(), toolCall(DONE, { outcome: "done", summary: "s" }, "c1", "inline report"), toolResult(DONE, "c1", "ok")]),
		);
		assert.equal(report, "inline report");
	});
});

describe("result assembler: completion facts (D12, D14)", () => {
	const PING = CALLER_PING_TOOL_NAME;

	it("a request without its result is not a completion", () => {
		const { record } = assembleResult(
			facts([sessionHeader(), assistant("notes"), toolCall(DONE, { outcome: "partial", summary: "s" }, "c1")], {
				end: { kind: "failed", error: "process died", code: 1 },
			}),
		);
		assert.equal(record.typed, false);
		assert.equal(record.outcome, "failed");
	});

	it("a codemode-only child's nested ping is a typed blocked result", () => {
		const nested = [{ id: "k1/1", name: PING, status: "ok" as const, arguments: { message: "Which database?" } }];
		const { record, report } = assembleResult(
			facts([
				sessionHeader(),
				assistant("I need a decision."),
				toolCall("codemode", { code: "await tools.caller_ping(...)" }, "k1"),
				toolResult("codemode", "k1", "script done", false, nested),
			]),
		);
		assert.equal(record.typed, true);
		assert.equal(record.outcome, "blocked");
		assert.equal(record.summary, "Which database?");
		assert.equal(report, "Which database?");
	});

	it("a nested completion call that succeeded types the result", () => {
		const nested = [{ id: "k1/1", name: DONE, status: "ok" as const, arguments: { outcome: "partial", summary: "Half." } }];
		const { record, report } = assembleResult(
			facts([
				sessionHeader(),
				assistant("Nested report."),
				toolCall("codemode", { code: "..." }, "k1"),
				toolResult("codemode", "k1", "ok", false, nested),
			]),
		);
		assert.equal(record.typed, true);
		assert.equal(record.outcome, "partial");
		assert.equal(report, "Nested report.");
	});

	for (const status of ["error", "unfinished"] as const) {
		it(`a nested completion call with status ${status} is not a completion`, () => {
			const nested = [{ id: "k1/1", name: DONE, status, arguments: { outcome: "done", summary: "s" } }];
			const { record } = assembleResult(
				facts([
					sessionHeader(),
					assistant("text"),
					toolCall("codemode", { code: "..." }, "k1"),
					toolResult("codemode", "k1", "ok", false, nested),
				]),
			);
			assert.equal(record.typed, false);
		});
	}

	// Pi omits nested arguments over 8 KiB per call (NESTED_CALL_LIMITS); 3,000 CJK characters are 9,000 UTF-8 bytes.
	const longQuestion = "どのデータベースを使いますか".repeat(215).slice(0, 3_000);
	const omittedPing = () => [
		sessionHeader(),
		assistant("I need a decision."),
		toolCall("codemode", { code: "await tools.caller_ping(...)" }, "k1"),
		toolResult("codemode", "k1", "script done", false, [{ id: "k1/1", name: PING, status: "ok", argumentsBytes: 9_015 }]),
	];

	it("a nested ping whose arguments Pi omitted keeps its accepted message as a typed blocked report", () => {
		const { record, report } = assembleResult(
			facts(omittedPing(), { acceptedCall: { toolCallId: "k1/1", args: { message: longQuestion } } }),
		);
		assert.equal(record.typed, true);
		assert.equal(record.outcome, "blocked");
		assert.equal(report, longQuestion, "the full ping message is the report (D12)");
		assert.equal(record.summary, longQuestion.slice(0, SUMMARY_MAX_CHARS - CUT_MARK.length) + CUT_MARK);
	});

	it("a nested done call whose arguments Pi omitted is typed from its accepted payload", () => {
		const summary = "s".repeat(9_000);
		const entries = [
			sessionHeader(),
			assistant("Nested report."),
			toolCall("codemode", { code: "..." }, "k1"),
			toolResult("codemode", "k1", "ok", false, [{ id: "k1/2", name: DONE, status: "ok", argumentsBytes: 9_040 }]),
		];
		const { record, report } = assembleResult(
			facts(entries, { acceptedCall: { toolCallId: "k1/2", args: { outcome: "partial", summary } } }),
		);
		assert.equal(record.typed, true);
		assert.equal(record.outcome, "partial");
		assert.equal(report, `${summary}\n\nNested report.`);
	});

	it("an accepted payload of another call does not type a call whose arguments Pi omitted", () => {
		const { record } = assembleResult(facts(omittedPing(), { acceptedCall: { toolCallId: "k9/1", args: { message: "other" } } }));
		assert.equal(record.typed, false);
	});
});

describe("result assembler: end precedence (D7, D12)", () => {
	const calledPartial = () => [
		sessionHeader(),
		assistant("Report before the stop."),
		toolCall(DONE, { outcome: "partial", summary: "s" }, "c1"),
		toolResult(DONE, "c1", "ok"),
	];

	it("a requested stop is cancelled and untyped, whatever the child wrote", () => {
		const { record, report } = assembleResult(facts(calledPartial(), { end: { kind: "cancelled", reason: "stopped" } }));
		assert.equal(record.outcome, "cancelled");
		assert.equal(record.typed, false);
		assert.equal(report, "Report before the stop.");
	});

	it("a report-only wrap-up is untyped and timed out, even with a call", () => {
		const { record } = assembleResult(
			facts(calledPartial(), { end: { kind: "timed_out", budget: "timeout", seconds: 60, wrapUp: true } }),
		);
		assert.equal(record.outcome, "timed_out");
		assert.equal(record.typed, false);
	});

	// A completion that beat the hard deadline never reaches the assembler as timed out: the watcher
	// files it as the child's own end (end-outcomes.test.ts). A hard timeout with a call in the
	// transcript is a call that never ended the run, such as a taken-over pane's (review b2 g1 P1).
	it("a hard time limit is untyped and timed out, even with a recorded call (D7)", () => {
		const { record } = assembleResult(
			facts(calledPartial(), { end: { kind: "timed_out", budget: "timeout", seconds: 60, wrapUp: false } }),
		);
		assert.equal(record.outcome, "timed_out");
		assert.equal(record.typed, false);
	});
});

describe("result assembler: report boundary (D12)", () => {
	it("with a call, the text after the nudge and before the call is the report", () => {
		const entries = [
			sessionHeader(),
			assistant("old text"),
			user("call subagent_done"),
			assistant("new text"),
			toolCall(DONE, {}, "c1"),
			toolResult(DONE, "c1", "ok"),
		];
		const { record, report } = assembleResult(facts(entries, { nudgeEntryIndex: 2 }));
		assert.equal(record.typed, false);
		assert.equal(report, "new text");
	});

	it("text after a call and a takeover is the report, even after a nudge", () => {
		const entries = [
			sessionHeader(),
			assistant("old text"),
			user("call subagent_done"),
			toolCall(DONE, { outcome: "done", summary: "s" }, "c1"),
			toolResult(DONE, "c1", "ok"),
			user("operator: one more thing"),
			assistant("new text"),
		];
		const { record, report } = assembleResult(facts(entries, { nudgeEntryIndex: 2 }));
		assert.equal(record.typed, false);
		assert.equal(report, "new text");
	});
});

describe("result assembler: report text is kept whole", () => {
	it("every text block of the selected message is kept, joined by a newline", () => {
		const message = assistant("first part", "last part");
		assert.equal(assembleResult(facts([sessionHeader(), message])).report, "first part\nlast part");
		const typed = assembleResult(
			facts([
				sessionHeader(),
				assistant("first part", "last part"),
				toolCall(DONE, { outcome: "done", summary: "s" }, "c1"),
				toolResult(DONE, "c1", "ok"),
			]),
		);
		assert.equal(typed.report, "first part\nlast part");
	});

	it("blocks of the call message after the call do not count", () => {
		const entry = {
			type: "message",
			id: "call-message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "before the call" },
					{ type: "toolCall", id: "c1", name: DONE, arguments: { outcome: "done", summary: "s" } },
					{ type: "text", text: "after the call" },
				],
			},
		};
		const { record, report } = assembleResult(facts([sessionHeader(), entry, toolResult(DONE, "c1", "ok")]));
		assert.equal(record.typed, true, "text in the call's own message is not text after a takeover");
		assert.equal(report, "before the call");
	});

	it("indentation and trailing space of report, summary and ping text stay", () => {
		const text = "    const x = 1;\n    return x;\n";
		assert.equal(assembleResult(facts([sessionHeader(), assistant(text)])).report, text);
		const long = ` ${"s".repeat(SUMMARY_MAX_CHARS + 10)}`;
		const typed = assembleResult(
			facts([
				sessionHeader(),
				assistant("body"),
				toolCall(DONE, { outcome: "done", summary: long }, "c1"),
				toolResult(DONE, "c1", "ok"),
			]),
		);
		assert.equal(typed.report, `${long}\n\nbody`);
		const ping = "  indented question\n";
		const pinged = assembleResult(
			facts([sessionHeader(), toolCall(CALLER_PING_TOOL_NAME, { message: ping }, "p1"), toolResult(CALLER_PING_TOOL_NAME, "p1", "ok")]),
		);
		assert.equal(pinged.report, ping);
		assert.equal(pinged.record.summary, ping);
	});
});

describe("result assembler: session path (D14)", () => {
	it("a watcher error that names the session file keeps the path in exit facts only", () => {
		const sessionFile = "/tmp/sessions/child-session-file.jsonl";
		const error = `Invalid session JSONL at ${sessionFile}:7: Unexpected end of JSON input`;
		const { record, report } = assembleResult(
			facts([sessionHeader()], { sessionFile, end: { kind: "failed", error, code: 1 } }),
		);
		assert.equal(record.exit.error, error);
		assert.ok(!record.summary.includes(sessionFile), record.summary);
		assert.ok(!report.includes(sessionFile), report);
	});
});

