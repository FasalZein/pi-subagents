import {
	CONTEXT_FOLD_ENTRY,
	type FoldedRun,
	foldMessages,
	readFoldedRuns,
	runStub,
	settleFold,
} from "../../src/runtime/context-fold.ts";
import { assert, describe, it } from "../support/index.ts";

// The settle fold rules of statecharts/context-fold/target/Target.tla at the smallest boundary:
// the fold set a settle decides from the session branch, and the provider messages the context hook
// gets from that set. Expected values come from the rules of the slice brief, not from the code.

const A = "aaaa0001";
const B = "bbbb0002";
const C = "cccc0003";

let n = 0;
const entryId = () => `f${++n}`;

function userEntry(text: string) {
	return { type: "message", id: entryId(), message: { role: "user", content: [{ type: "text", text }] } };
}
function assistantEntry(text = "ok") {
	return { type: "message", id: entryId(), message: { role: "assistant", content: [{ type: "text", text }] } };
}
function resultEntry(id: string, name: string, report = `REPORT-${name}`) {
	return {
		type: "custom_message",
		id: entryId(),
		customType: "subagent_result",
		content: report,
		display: true,
		details: { id, name, status: "completed", outcome: "done", reportFile: `/r/${name}.md` },
	};
}
function foldEntry(runs: FoldedRun[]) {
	return { type: "custom", id: entryId(), customType: CONTEXT_FOLD_ENTRY, data: { runs } };
}
const notRunning = () => false;
/** The settle time a test passes; result messages of the fixtures are older (timestamp 1). */
const AT = 100;

describe("context fold: the fold set a settle decides", () => {
	it("folds a run whose result a later request saw; not one delivered in the settle step, not a running one", () => {
		const entries = [
			userEntry("delegate"),
			resultEntry(A, "one"),
			assistantEntry(),
			// Committed by the settle step after the last request: not seen yet.
			resultEntry(B, "two"),
		];
		assert.deepEqual(settleFold(entries, notRunning, AT), [
			{ id: A, name: "one", outcome: "done", report: "/r/one.md", foldedAt: AT },
		]);
		// A run that runs again (resumed) does not fold, even when an older result was seen.
		assert.deepEqual(
			settleFold(entries, (id) => id === A, AT),
			[],
		);
	});

	it("does not fold a run with no committed result (still running)", () => {
		const entries = [
			userEntry("delegate"),
			{
				type: "message",
				id: entryId(),
				message: {
					role: "toolResult",
					toolName: "subagent",
					toolCallId: "launch-1",
					content: [{ type: "text", text: "started" }],
					details: { id: C, name: "three", status: "started" },
				},
			},
			assistantEntry(),
		];
		assert.deepEqual(settleFold(entries, notRunning, AT), []);
	});

	it("counts a wait reply and a launch reply that carried the finished result", () => {
		const waitReply = {
			type: "message",
			id: entryId(),
			message: {
				role: "toolResult",
				toolName: "subagent_wait",
				toolCallId: "w1",
				content: [{ type: "text", text: "REPORT" }],
				details: {
					status: "complete",
					results: [{ runId: A, name: "one", text: "R", record: { outcome: "partial" } }],
				},
			},
		};
		const launchReply = {
			type: "message",
			id: entryId(),
			message: {
				role: "toolResult",
				toolName: "subagent",
				toolCallId: "l1",
				content: [{ type: "text", text: "REPORT" }],
				details: {
					status: "batch",
					children: [
						{ id: B, name: "two", status: "completed", outcome: "done" },
						{ id: C, name: "three", status: "started" },
					],
				},
			},
		};
		const runs = settleFold([userEntry("x"), waitReply, launchReply, assistantEntry()], notRunning, AT);
		assert.deepEqual(runs, [
			{ id: A, name: "one", outcome: "partial", foldedAt: AT },
			{ id: B, name: "two", outcome: "done", foldedAt: AT },
		]);
	});

	it("is monotone across two settles: a folded run stays folded, the second settle adds only new runs", () => {
		const first = [userEntry("a"), resultEntry(A, "one"), assistantEntry(), resultEntry(B, "two")];
		const decided = settleFold(first, notRunning, AT);
		assert.deepEqual(
			decided.map((run) => run.id),
			[A],
		);
		const second = [...first, foldEntry(decided), userEntry("b"), assistantEntry()];
		const added = settleFold(second, notRunning, AT);
		assert.deepEqual(
			added.map((run) => run.id),
			[B],
		);
		const third = [...second, foldEntry(added), userEntry("c"), assistantEntry()];
		assert.deepEqual(settleFold(third, notRunning, AT), []);
		assert.deepEqual([...readFoldedRuns(third).keys()], [A, B]);
	});

	it("a later wait reply for a folded run triggers no new fold; a resumed run's new result folds at a later settle", () => {
		const first = [userEntry("a"), resultEntry(A, "one"), assistantEntry()];
		const folded = [...first, foldEntry(settleFold(first, notRunning, AT))];
		const lookup = {
			type: "message",
			id: entryId(),
			message: {
				role: "toolResult",
				toolName: "subagent_wait",
				toolCallId: "w1",
				content: [{ type: "text", text: "R" }],
				details: { status: "complete", results: [{ runId: A, name: "one", text: "R" }] },
			},
		};
		const looked = [...folded, userEntry("b"), lookup, assistantEntry()];
		assert.deepEqual(settleFold(looked, notRunning, 200), []);
		const resumedEnd = {
			...resultEntry(A, "one", "SECOND-REPORT"),
			details: { id: A, name: "one", outcome: "partial" },
		};
		const ended = [...looked, userEntry("c"), resumedEnd];
		assert.deepEqual(settleFold(ended, notRunning, 300), [], "the new result was not seen yet");
		const seen = [...ended, assistantEntry()];
		assert.deepEqual(settleFold(seen, notRunning, 300), [
			{ id: A, name: "one", outcome: "partial", report: "/r/one.md", foldedAt: 300 },
		]);
	});
});

const RUN_A: FoldedRun = { id: A, name: "one", outcome: "done", report: "/r/one.md", foldedAt: AT };
const RUN_B: FoldedRun = { id: B, name: "two", outcome: "partial", foldedAt: AT };
const folded = (...runs: FoldedRun[]) => new Map(runs.map((run) => [run.id, run]));

function launchCall(callId: string, args: Record<string, unknown>) {
	const thinking = { type: "thinking", thinking: "plan", thinkingSignature: "sig-1" };
	return {
		role: "assistant",
		content: [thinking, { type: "toolCall", id: callId, name: "subagent", arguments: args }],
	};
}
function launchReply(callId: string, details: Record<string, unknown>) {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "subagent",
		content: [{ type: "text", text: "launched" }],
		details,
	};
}
function resultMessage(details: Record<string, unknown>, content: string) {
	return { role: "custom", customType: "subagent_result", content, display: true, details, timestamp: 1 };
}

describe("context fold: the provider messages", () => {
	it("stub text names run id, name, outcome, report path and the lookup call, in about 200 characters", () => {
		const stub = runStub(RUN_A);
		assert.equal(
			stub,
			'[Folded subagent run aaaa0001 (one): done, report /r/one.md. Full result: subagent_wait({ runIds: ["aaaa0001"] })]',
		);
		assert.ok(stub.length <= 200);
	});

	it("returns the same list when nothing is folded or no message belongs to a folded run", () => {
		const messages = [
			{ role: "user", content: "x" },
			launchCall("l1", { agent: "w", name: "one", task: "BRIEF" }),
			launchReply("l1", { id: A, status: "started" }),
		];
		assert.equal(foldMessages(messages, new Map()), messages);
		assert.equal(foldMessages(messages, folded(RUN_B)), messages);
	});

	it("replaces the brief of each folded child and keeps the call shape, ids and thinking", () => {
		const call = launchCall("l1", {
			children: [
				{ name: "one", agent: "w", title: "One", task: "BRIEF-ONE" },
				{ name: "two", agent: "w", title: "Two", task: "BRIEF-TWO" },
			],
		});
		const reply = launchReply("l1", { status: "started", children: [{ id: A }, { id: B }] });
		const messages = [call, reply];
		const out = foldMessages(messages, folded(RUN_A));
		assert.notEqual(out, messages);
		const block = (out[0] as typeof call).content[1] as unknown as {
			id: string;
			name: string;
			arguments: { children: unknown[] };
		};
		assert.equal(block.id, "l1");
		assert.equal(block.name, "subagent");
		assert.deepEqual(block.arguments.children, [
			{ name: "one", agent: "w", title: "One", task: runStub(RUN_A) },
			{ name: "two", agent: "w", title: "Two", task: "BRIEF-TWO" },
		]);
		assert.equal((out[0] as typeof call).content[0], call.content[0], "the thinking block is the same object");
		assert.equal(out[1], reply, "the launch reply is unchanged");
		// The input list is not changed.
		assert.equal(
			(call.content[1] as unknown as { arguments: { children: { task: string }[] } }).arguments.children[0].task,
			"BRIEF-ONE",
		);
	});

	it("folds the top-level single form and a children list sent as a JSON string", () => {
		const single = foldMessages(
			[launchCall("l1", { agent: "w", name: "one", task: "BRIEF" }), launchReply("l1", { id: A, status: "completed" })],
			folded(RUN_A),
		);
		assert.deepEqual((single[0] as { content: { arguments?: unknown }[] }).content[1].arguments, {
			agent: "w",
			name: "one",
			task: runStub(RUN_A),
		});
		const children = JSON.stringify([{ name: "one", agent: "w", task: "BRIEF" }]);
		const asString = foldMessages(
			[launchCall("l2", { children }), launchReply("l2", { status: "started", children: [{ id: A }] })],
			folded(RUN_A),
		);
		const args = (asString[0] as { content: { arguments?: { children: string } }[] }).content[1].arguments!;
		assert.equal(typeof args.children, "string");
		assert.deepEqual(JSON.parse(args.children), [{ name: "one", agent: "w", task: runStub(RUN_A) }]);
	});

	it("replaces a result message with its stub; a grouped message folds only when all its runs fold", () => {
		const single = resultMessage({ id: A, name: "one" }, "REPORT-ONE");
		const grouped = resultMessage(
			{
				results: [
					{ customType: "subagent_result", content: "REPORT-ONE", details: { id: A } },
					{ customType: "subagent_result", content: "REPORT-TWO", details: { id: B } },
				],
			},
			"REPORT-ONE\n\nREPORT-TWO",
		);
		const partly = foldMessages([single, grouped], folded(RUN_A));
		assert.equal((partly[0] as typeof single).content, runStub(RUN_A));
		assert.equal(partly[1], grouped, "a grouped message with an unfolded run stays full");
		const later = { ...single, timestamp: AT + 1 };
		const resumed = [later];
		assert.equal(foldMessages(resumed, folded(RUN_A)), resumed, "a result sent after the fold stays full");
		const all = foldMessages([grouped], folded(RUN_A, RUN_B));
		assert.equal((all[0] as typeof grouped).content, `${runStub(RUN_A)}\n${runStub(RUN_B)}`);
	});

	it("folds a codemode launch script only when every run its result names is folded", () => {
		const script = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "c1",
					name: "codemode",
					arguments: { code: "await tools.subagent({ task: 'BRIEF' })" },
				},
			],
		};
		const result = {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "codemode",
			content: [
				{
					type: "text",
					text: `{"status":"launched","children":[{"runId":"${A}","sessionFile":"/s/2026_8579cd68-9e5178db.jsonl"},{"runId":"${B}"}]}`,
				},
			],
			nestedCalls: { calls: [{ id: "c1/1", name: "subagent", status: "ok" }], complete: true },
		};
		const messages = [script, result];
		assert.equal(foldMessages(messages, folded(RUN_A)), messages, "one run not folded: the script stays full");
		const out = foldMessages(messages, folded(RUN_A, RUN_B));
		const code = (out[0] as { content: { arguments: { code: string } }[] }).content[0].arguments.code;
		assert.doesNotMatch(code, /BRIEF/);
		assert.match(code, new RegExp(`Folded launch script of runs ${A}, ${B}`));
		assert.equal(out[1], result);
		// A script that launched nothing is never folded.
		const plain = [
			script,
			{ ...result, nestedCalls: { calls: [{ id: "c1/1", name: "read", status: "ok" }], complete: true } },
		];
		assert.equal(foldMessages(plain, folded(RUN_A, RUN_B)), plain);
	});
});
