import { mock } from "node:test";
import { buildBackgroundLaunchPlan } from "../../src/launch/background.ts";
import { assembleResult, NO_REPORT_LINE } from "../../src/runtime/result-assembler.ts";
import { CUT_MARK, SUMMARY_MAX_CHARS } from "../../src/runtime/result-record.ts";
import { CALLER_PING_TOOL_NAME, SUBAGENT_DONE_TOOL_NAME } from "../../src/tools/tool-names.ts";
import {
	ASSISTANT_MSG,
	assert,
	createTestDir,
	describe,
	it,
	join,
	MODEL_CHANGE,
	mkdirSync,
	SESSION_HEADER,
	USER_MSG,
	writeFileSync,
} from "../support/index.ts";
import { cleanupPaneChild as cleanup, loadPaneChild as loadChild } from "../support/pane-child.ts";
import { assistant, facts, sessionHeader, toolCall, toolResult, user } from "../support/result-fixtures.ts";

// T72 (D01 revert): child-side expected values come from cf6dbf4 (an auto-exit child has no
// subagent_done, no brief line, no refusal). Assembler cases keep D12's reading of older typed
// sessions: typed only with a valid outcome and a non-empty summary, the full text in the report.
const DONE = SUBAGENT_DONE_TOOL_NAME;
const PING = CALLER_PING_TOOL_NAME;

type Child = ReturnType<typeof loadChild>;

function withChild(options: { autoExit: boolean; pane: boolean }, run: (child: Child) => Promise<void> | void) {
	return async () => {
		mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		const child = loadChild(options);
		try {
			await run(child);
		} finally {
			cleanup(child.dir);
		}
	};
}

/** Runs subagent_done, then lets the deferred shutdown request fire (pane-takeover.ts requestShutdown). */
async function callDone(child: Child, args: Record<string, unknown>, id = "c1") {
	const result = await child.tools.get(DONE).execute(id, args, undefined, undefined, child.ctx);
	mock.timers.tick(5);
	return result;
}

/** A long text that ends in a marker, so a test can see the whole text survive. */
function longText(length: number, marker: string): string {
	return `${"x".repeat(length - marker.length)}${marker}`;
}

const kinds = [
	{ name: "an auto-exit pane child", options: { autoExit: true, pane: true } },
	{ name: "a headless child", options: { autoExit: true, pane: false } },
];

describe("completion call (T72, D12 records)", () => {
	for (const kind of kinds) {
		it(
			`${kind.name} has no subagent_done (cf6dbf4 getDeniedToolNames with autoExit)`,
			withChild(kind.options, (child) => {
				assert.equal(child.tools.has(DONE), false);
				assert.ok(child.tools.has(PING), "caller_ping stays");
			}),
		);
	}

	// T69 (v2.9.2): a manual pane child ends only when a person closes the pane, so it has no
	// completion tool, also without a deny entry, and it gets no nudge.
	it(
		"a manual pane child has no subagent_done without a deny entry, and no nudge",
		withChild({ autoExit: false, pane: true }, (child) => {
			assert.equal(child.tools.has(DONE), false);
			child.emit("agent_start", {});
			child.emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "answer" }] }] });
			assert.deepEqual(child.nudges, []);
			assert.equal(child.shutdowns, 0);
			for (const tool of child.tools.values()) assert.doesNotMatch(tool.description ?? "", /subagent_done/);
		}),
	);

	it("with subagent_done on deny-tools the tool is absent", async () => {
		process.env.PI_DENY_TOOLS = DONE;
		try {
			for (const kind of kinds) {
				await withChild(kind.options, (child) => assert.equal(child.tools.has(DONE), false, kind.name))();
			}
		} finally {
			delete process.env.PI_DENY_TOOLS;
		}
	});

	const briefCases = [
		{ deny: undefined, fork: false },
		{ deny: DONE, fork: false },
		{ deny: undefined, fork: true },
		{ deny: DONE, fork: true },
	];
	it("a headless brief, fork included, has no completion-call line (cf6dbf4 background.ts)", async () => {
		for (const { deny, fork } of briefCases) {
			const cwd = createTestDir();
			mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
			const frontmatter = [
				"---",
				"name: worker",
				"mode: background",
				...(fork ? ["session-mode: fork"] : []),
				...(deny ? [`deny-tools: ${deny}`] : []),
				"---",
				"Body.",
			];
			writeFileSync(join(cwd, ".pi", "agents", "worker.md"), frontmatter.join("\n"));
			const parentSession = join(cwd, "parent.jsonl");
			writeFileSync(
				parentSession,
				`${[SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			);
			const plan = await buildBackgroundLaunchPlan(
				{ name: "w", title: "W", task: "Do the work", agent: "worker" },
				{
					cwd,
					sessionManager: {
						getSessionFile: () => parentSession,
						getSessionId: () => "parent-session-id",
						getLeafId: () => "asst-001",
					},
				},
			);
			const label = `deny=${deny ?? "none"} fork=${fork}`;
			assert.equal(plan.launch.directTask, fork, label);
			if (fork) assert.ok(plan.fullTask.startsWith("Do the work"), `${label}: the fork task stays first and whole`);
			assert.doesNotMatch(plan.fullTask, /outcome \(done, partial or blocked\)|1,500 characters|refused once/, label);
			if (fork) assert.equal(plan.fullTask, "Do the work", label);
		}
	});

	it("without the tool, an auto-exit child ends untyped without a nudge", async () => {
		process.env.PI_DENY_TOOLS = DONE;
		try {
			await withChild({ autoExit: true, pane: false }, (child) => {
				child.emit("agent_start", {});
				child.emit("agent_end", {
					messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Report." }] }],
				});
				mock.timers.tick(5);
				assert.deepEqual(child.nudges, []);
				assert.equal(child.shutdowns, 1);
				assert.equal(child.readExit()?.acceptedCall, undefined);
			})();
		} finally {
			delete process.env.PI_DENY_TOOLS;
		}
		const { record, report } = assembleResult(facts([sessionHeader(), user("task"), assistant("Report.")]));
		assert.equal(record.typed, false);
		assert.equal(report, "Report.");
	});

	it("an older session's typed partial call still loads as a typed partial record", () => {
		const args = { outcome: "partial", summary: "Half of the files are fixed." };
		const { record, report } = assembleResult(
			facts(
				[
					sessionHeader(),
					user("task"),
					assistant("Details."),
					toolCall(DONE, args, "c1"),
					toolResult(DONE, "c1", "ok"),
				],
				{ acceptedCall: { toolCallId: "c1", args } },
			),
		);
		assert.equal(record.typed, true);
		assert.equal(record.outcome, "partial");
		assert.equal(record.summary, "Half of the files are fixed.");
		assert.equal(report, "Details.");
	});

	it(
		"a call with no arguments ends the child untyped",
		withChild({ autoExit: false, pane: false }, async (child) => {
			await callDone(child, {});
			assert.equal(child.shutdowns, 1);
			assert.equal(child.readExit()?.type, "done");
			const { record, report } = assembleResult(
				facts([
					sessionHeader(),
					user("task"),
					assistant("Plain report."),
					toolCall(DONE, {}, "c1"),
					toolResult(DONE, "c1", "ok"),
				]),
			);
			assert.equal(record.typed, false);
			assert.equal(report, "Plain report.");
		}),
	);

	it("a tool-only completion gives a report with the summary and the no-report line", () => {
		const args = { outcome: "done", summary: "Wrote the file." };
		const { record, report } = assembleResult(
			facts([sessionHeader(), user("task"), toolCall(DONE, args, "c1"), toolResult(DONE, "c1", "ok")]),
		);
		assert.equal(record.typed, true);
		assert.equal(report, `Wrote the file.\n\n${NO_REPORT_LINE}`);
	});

	it("an older session's typed summary over the limit is cut and kept whole in the report", () => {
		const summary = longText(2_000, "END-OF-SUMMARY");
		const args = { outcome: "done", summary };
		const { record, report } = assembleResult(
			facts([sessionHeader(), user("task"), toolCall(DONE, args, "c2"), toolResult(DONE, "c2", "ok")]),
		);
		assert.equal(record.typed, true);
		assert.ok(record.summary.length <= SUMMARY_MAX_CHARS);
		assert.ok(record.summary.endsWith(CUT_MARK));
		assert.ok(report.includes(summary), "the report holds the full summary with its last marker");
	});

	it(
		"a 3,000-character one-line caller_ping is accepted at once (cf6dbf4: no refusal)",
		withChild({ autoExit: true, pane: false }, async (child) => {
			const message = longText(3_000, "END-OF-PING");
			await child.tools.get(PING).execute("p1", { message }, undefined, undefined, child.ctx);
			const exit = child.readExit();
			assert.equal(exit?.type, "ping");
			assert.equal(exit?.message, message);
			const { record, report } = assembleResult(
				facts([sessionHeader(), user("task")], { end: { kind: "pinged", message } }),
			);
			assert.equal(record.outcome, "blocked");
			assert.ok(record.summary.length <= SUMMARY_MAX_CHARS);
			assert.ok(record.summary.endsWith(CUT_MARK));
			assert.equal(report, message);
			assert.ok(report.endsWith("END-OF-PING"));
		}),
	);

	// T69: a manual pane child has no completion call; only the person's close ends it, untyped (D12).
	describe("after operator input in a manual pane child", () => {
		it(
			"nothing ends the child before the close; the close writes the shutdown record",
			withChild({ autoExit: false, pane: true }, (child) => {
				child.takeOver();
				child.emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "answer" }] }] });
				assert.equal(child.shutdowns, 0);
				assert.equal(child.readExit(), null);
				child.emit("session_shutdown", { reason: "quit" });
				assert.equal(child.readExit()?.type, "done");
			}),
		);

		it("more text and a manual close give one untyped result built from the last text", () => {
			const { record, report } = assembleResult(
				facts([
					sessionHeader(),
					user("task"),
					assistant("first answer"),
					user("operator: also check the tests"),
					assistant("tests checked"),
					user("operator: thanks"),
					assistant("last words"),
				]),
			);
			assert.equal(record.typed, false);
			assert.equal(report, "last words");
		});
	});
});
