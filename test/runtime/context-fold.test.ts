import { foldMessages, runStub } from "../../src/runtime/context-fold.ts";
import {
	CONTEXT_FOLD_ENTRY,
	type FoldedRun,
	readFoldedRuns,
	replyDigest,
	settleFold,
} from "../../src/runtime/context-fold-set.ts";
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
/** Every report path of these fixtures counts as saved; context-fold-safety.test.ts checks real files. */
const exists = () => true;
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
		assert.deepEqual(settleFold(entries, notRunning, AT, exists), [
			{ id: A, name: "one", outcome: "done", report: "/r/one.md", foldedAt: AT },
		]);
		// A run that runs again (resumed) does not fold, even when an older result was seen.
		assert.deepEqual(
			settleFold(entries, (id) => id === A, AT, exists),
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
		assert.deepEqual(settleFold(entries, notRunning, AT, exists), []);
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
					results: [
						{
							runId: A,
							name: "one",
							text: "R",
							record: { outcome: "partial", report: { saved: true, path: "/r/one.md" } },
						},
					],
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
						{ id: B, name: "two", status: "completed", outcome: "done", reportFile: "/r/two.md" },
						{ id: C, name: "three", status: "started" },
					],
				},
			},
		};
		const runs = settleFold([userEntry("x"), waitReply, launchReply, assistantEntry()], notRunning, AT, exists);
		assert.deepEqual(runs, [
			{ id: A, name: "one", outcome: "partial", report: "/r/one.md", foldedAt: AT },
			{ id: B, name: "two", outcome: "done", report: "/r/two.md", foldedAt: AT },
		]);
	});

	it("counts a waited resume reply with a finished status; not a started (detached) or an interrupted resume", () => {
		const resumeReply = (callId: string, details: Record<string, unknown>) => ({
			type: "message",
			id: entryId(),
			message: {
				role: "toolResult",
				toolName: "subagent_resume",
				toolCallId: callId,
				content: [{ type: "text", text: "RESUME-REPLY" }],
				details,
			},
		});
		const waited = resumeReply("r1", {
			id: A,
			name: "one",
			status: "completed",
			outcome: "done",
			reportFile: "/r/one.md",
		});
		const started = resumeReply("r2", { id: B, name: "two", status: "started", deliveryState: "detached" });
		// Esc during the wait of a resume: the wait error carries the run id and no status.
		const interrupted = resumeReply("r3", { error: "interrupted", id: C });
		const runs = settleFold([userEntry("x"), waited, started, interrupted, assistantEntry()], notRunning, AT, exists);
		assert.deepEqual(runs, [{ id: A, name: "one", outcome: "done", report: "/r/one.md", foldedAt: AT }]);
	});

	it("is monotone across two settles: a folded run stays folded, the second settle adds only new runs", () => {
		const first = [userEntry("a"), resultEntry(A, "one"), assistantEntry(), resultEntry(B, "two")];
		const decided = settleFold(first, notRunning, AT, exists);
		assert.deepEqual(
			decided.map((run) => run.id),
			[A],
		);
		const second = [...first, foldEntry(decided), userEntry("b"), assistantEntry()];
		const added = settleFold(second, notRunning, AT, exists);
		assert.deepEqual(
			added.map((run) => run.id),
			[B],
		);
		const third = [...second, foldEntry(added), userEntry("c"), assistantEntry()];
		assert.deepEqual(settleFold(third, notRunning, AT, exists), []);
		assert.deepEqual([...readFoldedRuns(third).keys()], [A, B]);
	});

	it("a later reply of a folded run refolds it at the next settle with the same facts (D3); a new result brings new facts", () => {
		const first = [userEntry("a"), resultEntry(A, "one"), assistantEntry()];
		const folded = [...first, foldEntry(settleFold(first, notRunning, AT, exists))];
		// A lookup copy: its record facts differ from the result message, so the old facts must win.
		const lookup = {
			type: "message",
			id: entryId(),
			message: {
				role: "toolResult",
				toolName: "subagent_wait",
				toolCallId: "w1",
				content: [{ type: "text", text: "R" }],
				details: {
					status: "complete",
					results: [{ runId: A, text: "R", record: { outcome: "other", report: { saved: true, path: "/r/x.md" } } }],
				},
			},
		};
		const unseen = [...folded, userEntry("b"), lookup];
		assert.deepEqual(settleFold(unseen, notRunning, 200, exists), [], "a reply no request saw does not refold");
		const seenLookup = [...unseen, assistantEntry()];
		const refolded = settleFold(seenLookup, notRunning, 200, exists);
		assert.deepEqual(refolded, [{ id: A, name: "one", outcome: "done", report: "/r/one.md", foldedAt: 200 }]);
		assert.deepEqual(
			settleFold(seenLookup, notRunning, 200, () => false),
			[],
			"no refold when the report file is gone; the reply stays full",
		);
		assert.deepEqual(
			settleFold(seenLookup, (id) => id === A, 200, exists),
			[],
			"no refold of a running run",
		);
		const looked = [...seenLookup, foldEntry(refolded)];
		assert.deepEqual(settleFold(looked, notRunning, 250, exists), [], "the refold entry settles it");
		const resumedEnd = {
			...resultEntry(A, "one", "SECOND-REPORT"),
			details: { id: A, name: "one", outcome: "partial", reportFile: "/r/one-2.md" },
		};
		const ended = [...looked, userEntry("c"), resumedEnd];
		assert.deepEqual(settleFold(ended, notRunning, 300, exists), [], "the new result was not seen yet");
		const seen = [...ended, assistantEntry()];
		assert.deepEqual(settleFold(seen, notRunning, 300, exists), [
			{ id: A, name: "one", outcome: "partial", report: "/r/one-2.md", foldedAt: 300 },
		]);
	});
});

const RUN_A: FoldedRun = { id: A, name: "one", outcome: "done", report: "/r/one.md", foldedAt: AT };
const RUN_B: FoldedRun = { id: B, name: "two", outcome: "partial", report: "/r/two.md", foldedAt: AT };
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
	it("stub text names run id, name, outcome, report path and the lookup call", () => {
		const stub = runStub(RUN_A);
		assert.equal(
			stub,
			'[Folded subagent run aaaa0001 (one): done, report /r/one.md. Full result: subagent_wait({ runIds: ["aaaa0001"] })]',
		);
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

	it("folds the task text of a waited resume of a folded run; a started or interrupted resume stays", () => {
		const resumeCall = (callId: string, args: Record<string, unknown>) => ({
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "subagent_resume", arguments: args }],
		});
		const resumeReply = (callId: string, details: Record<string, unknown>) => ({
			role: "toolResult",
			toolCallId: callId,
			toolName: "subagent_resume",
			content: [{ type: "text", text: "RESUME-REPLY" }],
			details,
		});
		const call = resumeCall("r1", { runId: "older01", task: "FOLLOW-UP" });
		const reply = resumeReply("r1", { id: A, status: "completed", reportFile: "/r/one.md" });
		const out = foldMessages([call, reply], folded(RUN_A));
		assert.deepEqual((out[0] as { content: { arguments?: unknown }[] }).content[0].arguments, {
			runId: "older01",
			task: runStub(RUN_A),
		});
		assert.equal(out[1], reply, "the resume reply is unchanged");
		const started = [
			resumeCall("r2", { runId: "older01", task: "FOLLOW-UP" }),
			resumeReply("r2", { id: B, status: "started" }),
		];
		assert.equal(foldMessages(started, folded(RUN_A)), started, "a started resume of an unfolded run stays");
		const interrupted = [
			resumeCall("r3", { runId: "older01", task: "FOLLOW-UP" }),
			resumeReply("r3", { error: "interrupted", id: B }),
		];
		assert.equal(foldMessages(interrupted, folded(RUN_A)), interrupted, "an interrupted resume stays");
		const noTask = [resumeCall("r4", { runId: "older01" }), resumeReply("r4", { id: A, status: "completed" })];
		assert.equal(foldMessages(noTask, folded(RUN_A)), noTask, "a resume without a task has nothing to fold");
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
});

/** A subagent_wait reply as Pi builds it (wait-tool.ts): text content, structured details, a creation time. */
function waitReply(details: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	return withDigest({
		role: "toolResult",
		toolCallId: "w1",
		toolName: "subagent_wait",
		content: [{ type: "text", text: "REPORT-ONE\n\nREPORT-TWO" }],
		details,
		isError: false,
		timestamp: 1,
		...extra,
	});
}

/**
 * The tools keep the digest of the one text block they built in the details (context-fold-e2e and
 * test/vf/winner-launch.test.ts drive the real tools); a fixture gets the digest of its first block.
 */
function withDigest<T extends { content: { text?: string }[]; details: Record<string, unknown> }>(reply: T): T {
	if ("replyDigest" in reply.details) return reply;
	return { ...reply, details: { ...reply.details, replyDigest: replyDigest(reply.content[0]?.text ?? "") } };
}

/** The reply after another extension changed its text and left its details (fold-waits review round 1). */
function annotated<T extends { content: { type: string; text?: string }[] }>(reply: T): T {
	return { ...reply, content: [{ type: "text", text: `${reply.content[0]?.text}\n\nNOTE` }] };
}
const complete = (...ids: string[]) => ({
	status: "complete",
	results: ids.map((runId) => ({ runId, name: runId, record: null })),
	pending: [],
	missing: [],
});

describe("context fold: wait replies (fold-waits S2)", () => {
	it("a clean join of folded runs becomes one stub line per run; call id, tool name, details and flag stay", () => {
		const reply = waitReply(complete(A, B));
		const out = foldMessages([reply], folded(RUN_A, RUN_B));
		assert.deepEqual(out[0], {
			...reply,
			content: [{ type: "text", text: `${runStub(RUN_A)}\n${runStub(RUN_B)}` }],
		});
		assert.equal((out[0] as typeof reply).details, reply.details, "details are the same object");
		assert.equal(reply.content[0].text, "REPORT-ONE\n\nREPORT-TWO", "the input reply is not changed");
	});

	it("stays the same object when it is not a clean, used join", () => {
		const cases: Array<[string, ReturnType<typeof waitReply>]> = [
			["a timeout with pending runs", waitReply({ ...complete(A), status: "timeout", pending: [B] })],
			["pending runs", waitReply({ ...complete(A), pending: [B] })],
			["a missing run", waitReply({ ...complete(A), missing: [{ runId: C, error: "no record" }] })],
			[
				"an interrupted wait",
				waitReply({ status: "interrupted", results: [], pending: [A], missing: [] }, { isError: true }),
			],
			["an error flag", waitReply(complete(A), { isError: true })],
			[
				"image content",
				waitReply(complete(A), {
					content: [
						{ type: "text", text: "REPORT-ONE" },
						{ type: "image", data: "AAAA", mimeType: "image/png" },
					],
				}),
			],
			["a reply created after the fold settle", waitReply(complete(A), { timestamp: AT + 1 })],
			["no creation time", waitReply(complete(A), { timestamp: undefined })],
			["a run that did not fold", waitReply(complete(A, C))],
			["the recent list", waitReply({ status: "recent", results: [], pending: [], missing: [], recent: [] })],
			["an empty join", waitReply({ status: "empty", results: [], pending: [], missing: [] })],
			["text another extension changed", annotated(waitReply(complete(A)))],
			[
				"a second text block",
				waitReply(complete(A), {
					content: [
						{ type: "text", text: "R" },
						{ type: "text", text: "NOTE" },
					],
				}),
			],
			["no digest (a reply written before the digest)", { ...waitReply(complete(A)), details: complete(A) }],
			[
				"a verified run by its report path",
				waitReply({
					...complete(A),
					results: [{ runId: A, name: "one", record: { report: { saved: true, path: "/v/run/result/g1/report.md" } } }],
				}),
			],
			[
				"a verified run",
				waitReply({ ...complete(A), results: [{ runId: A, name: "one", record: { verifiedRunId: "vf1" } }] }),
			],
		];
		for (const [what, reply] of cases) {
			const messages = [reply];
			assert.equal(foldMessages(messages, folded(RUN_A, RUN_B)), messages, what);
		}
	});

	it("leaves other tool results alone, also with the same details shape", () => {
		const other = { ...waitReply(complete(A)), toolName: "bash" };
		const messages = [other];
		assert.equal(foldMessages(messages, folded(RUN_A)), messages);
	});
});

/**
 * A waited launch or resume reply as the launch tools build it (launch-reply.ts, D23): one line per
 * child, the waited return line, then each report after a blank line. Written out here from the
 * documented reply format, not built by the code.
 */
const WAITED = "This call waited for its children; each report follows below.";
const childLine = (name: string, id: string) => `- ${name} (agent w): run ${id}, model not set, headless`;
function launchToolReply(text: string, details: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	return withDigest({
		role: "toolResult",
		toolCallId: "l1",
		toolName: "subagent",
		content: [{ type: "text", text }],
		details,
		isError: false,
		timestamp: 1,
		...extra,
	});
}
const finished = (id: string, name: string) => ({
	id,
	name,
	status: "completed",
	outcome: "done",
	reportFile: `/r/${name}.md`,
});
const SINGLE_HEAD = `${childLine("one", A)}\n${WAITED}`;
const BATCH_HEAD = `${childLine("one", A)}\n${childLine("two", B)}\n${WAITED}`;
const single = (extra: Record<string, unknown> = {}) =>
	launchToolReply(`${SINGLE_HEAD}\n\nREPORT-ONE`, finished(A, "one"), extra);
const batch = (children: Record<string, unknown>[], head = BATCH_HEAD) =>
	launchToolReply(`${head}\n\nREPORT-ONE\n\nREPORT-TWO`, { status: "batch", children });

describe("context fold: launch and resume replies (fold-waits S3)", () => {
	it("a waited single launch keeps its head lines, then one stub per run; call id, details and flag stay", () => {
		const reply = single();
		const out = foldMessages([reply], folded(RUN_A));
		assert.deepEqual(out[0], { ...reply, content: [{ type: "text", text: `${SINGLE_HEAD}\n\n${runStub(RUN_A)}` }] });
		assert.equal((out[0] as typeof reply).details, reply.details, "details are the same object");
		assert.match(reply.content[0].text, /REPORT-ONE/, "the input reply is not changed");
	});

	it("a waited batch (a batch barrier) keeps its child lines and folds every report", () => {
		const reply = batch([finished(A, "one"), finished(B, "two")]);
		const out = foldMessages([reply], folded(RUN_A, RUN_B));
		const text = `${BATCH_HEAD}\n\n${runStub(RUN_A)}\n${runStub(RUN_B)}`;
		assert.deepEqual(out[0], { ...reply, content: [{ type: "text", text }] });
	});

	it("a waited resume reply folds the same way", () => {
		const reply = single({ toolName: "subagent_resume", toolCallId: "r1" });
		const out = foldMessages([reply], folded(RUN_A));
		assert.deepEqual(out[0], { ...reply, content: [{ type: "text", text: `${SINGLE_HEAD}\n\n${runStub(RUN_A)}` }] });
	});

	it("a lookup copy created before the fold settle folds as a used reply (D3)", () => {
		const reply = launchToolReply(`${SINGLE_HEAD}\n\nLOOKUP-TEXT`, { ...finished(A, "one"), runId: A, lookup: true });
		const out = foldMessages([reply], folded(RUN_A));
		assert.equal((out[0] as typeof reply).content[0].text, `${SINGLE_HEAD}\n\n${runStub(RUN_A)}`);
	});

	it("a lookup reply after the fold stays full until a refold moves foldedAt; earlier stubs keep their text (D3)", () => {
		const brief = resultMessage({ id: A, name: "one" }, "REPORT-ONE");
		const lookup = launchToolReply(`${SINGLE_HEAD}\n\nLOOKUP-TEXT`, finished(A, "one"), { timestamp: AT + 1 });
		const messages = [brief, lookup];
		const before = foldMessages(messages, folded(RUN_A));
		assert.equal(before[1], lookup, "in its own turn the lookup reply stays full");
		const after = foldMessages(messages, folded({ ...RUN_A, foldedAt: AT + 50 }));
		assert.equal(
			(after[0] as typeof brief).content,
			(before[0] as typeof brief).content,
			"the earlier stub is the same text",
		);
		assert.equal((after[1] as typeof lookup).content[0].text, `${SINGLE_HEAD}\n\n${runStub(RUN_A)}`);
	});

	it("stays the same object when not every child delivered a used, finished report", () => {
		const PARTLY = "Each report of a finished child follows below.";
		const cases: Array<[string, ReturnType<typeof launchToolReply>]> = [
			[
				"a partly waited batch",
				batch(
					[finished(A, "one"), { id: B, name: "two", status: "started" }],
					`${childLine("one", A)}\n${childLine("two", B)}\n${PARTLY}\nReturn line.`,
				),
			],
			[
				"a launch failure",
				launchToolReply(
					"Error: child 2 of 2, two (agent w), failed to launch: boom",
					{
						status: "launch_failed",
						children: [finished(A, "one")],
					},
					{ isError: true },
				),
			],
			[
				"an interrupted wait",
				launchToolReply(`${childLine("one", A)}\nInterrupted.`, { id: A, name: "one", status: "interrupted" }),
			],
			[
				"a batch with a wait error",
				batch(
					[finished(A, "one"), { id: B, name: "two", status: "wait_failed" }],
					`${childLine("one", A)}\n${childLine("two", B)}\n${PARTLY}\nTimed out.`,
				),
			],
			[
				"a started (detached) launch",
				launchToolReply(`${childLine("one", A)}\nReturn line.`, { id: A, status: "started" }),
			],
			[
				"a lookup copy created after the fold settle",
				launchToolReply(
					`${SINGLE_HEAD}\n\nLOOKUP-TEXT`,
					{ ...finished(A, "one"), lookup: true },
					{ timestamp: AT + 1 },
				),
			],
			["text another extension changed", annotated(single())],
			["no digest (a reply written before the digest)", { ...single(), details: finished(A, "one") }],
			[
				"a verified child by its report path",
				launchToolReply(`${SINGLE_HEAD}\n\nR`, { ...finished(A, "one"), reportFile: "/v/run/result/g2/report.md" }),
			],
			["a verified child", launchToolReply(`${SINGLE_HEAD}\n\nR`, { ...finished(A, "one"), verifiedRunId: "vf1" })],
			["a provenance notice", launchToolReply(`${SINGLE_HEAD}\n\nR`, { ...finished(A, "one"), provenance: true })],
			["a run that did not fold", batch([finished(A, "one"), finished(C, "three")])],
			["an error flag", single({ isError: true })],
			["no creation time", single({ timestamp: undefined })],
			[
				"image content",
				single({
					content: [
						{ type: "text", text: `${SINGLE_HEAD}\n\nR` },
						{ type: "image", data: "AAAA", mimeType: "image/png" },
					],
				}),
			],
			[
				"a head without the waited return line",
				launchToolReply(`${childLine("one", A)}\nOther line.\n\nR`, finished(A, "one")),
			],
			["a head with a warning line", launchToolReply(`${SINGLE_HEAD}\nWarning: x\n\nR`, finished(A, "one"))],
		];
		for (const [what, reply] of cases) {
			const messages = [reply];
			assert.equal(foldMessages(messages, folded(RUN_A, RUN_B)), messages, what);
		}
	});
});
