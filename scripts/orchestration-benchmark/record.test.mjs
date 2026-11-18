// Run: node --test scripts/orchestration-benchmark/record.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	answerMatches,
	answerParser,
	canonicalJson,
	endsWithProviderError,
	loadEvidence,
	rerunDecision,
	sampleKey,
	sampleKeyId,
	scoreAttempt,
	sealRecord,
	summarizeChildren,
	summarizeParent,
	terminalAnswer,
	totals,
} from "./record.mjs";
import recon from "./scenarios/recon/scenario.mjs";
import review from "./scenarios/review/scenario.mjs";
import reviewFix from "./scenarios/review-fix/scenario.mjs";

const KEY_PARTS = {
	checkoutRevision: "cf6dbf4",
	fixtureHash: "f1",
	harnessHash: "h1",
	model: "provider/model-x",
	thinking: "high",
	settingsHash: "s1",
	scenario: "smoke",
	rep: 1,
};
const KEY = sampleKey(KEY_PARTS);

function sealed(fields) {
	return JSON.stringify(sealRecord({ schema: 1, key: KEY, ...fields }));
}

test("a missing sample runs", () => {
	assert.equal(rerunDecision(null, KEY).action, "run");
});

test("a completed sample keeps its verdict, a timeout or a wrong answer included", () => {
	for (const verdict of ["pass", "wrong-answer", "timeout"]) {
		assert.deepEqual(
			rerunDecision(sealed({ outcome: "verdict", verdict }), KEY),
			{
				action: "skip",
				reason: `completed with verdict ${verdict}`,
			},
		);
	}
});

test("only a sample without a verdict for an infrastructure reason runs again", () => {
	const text = sealed({
		outcome: "infra-failure",
		verdict: null,
		infraReason: "parent startup timed out",
	});
	assert.deepEqual(rerunDecision(text, KEY), {
		action: "run",
		reason: "ended without a verdict: parent startup timed out",
	});
});

test("a file whose checksum does not match runs again", () => {
	const record = JSON.parse(sealed({ outcome: "verdict", verdict: "timeout" }));
	record.verdict = "pass";
	assert.equal(
		rerunDecision(JSON.stringify(record), KEY).reason,
		"checksum does not match",
	);
	assert.equal(rerunDecision("{half", KEY).reason, "sample file is not JSON");
});

test("a sealed file of another key does not count for this key", () => {
	const other = sampleKey({ ...KEY_PARTS, rep: 2 });
	assert.equal(
		rerunDecision(sealed({ outcome: "verdict", verdict: "pass" }), other)
			.action,
		"run",
	);
});

test("every key part changes the key id", () => {
	const base = sampleKeyId(KEY);
	const changed = {
		checkoutRevision: "x",
		fixtureHash: "x",
		harnessHash: "x",
		model: "x/y",
		thinking: "low",
		settingsHash: "x",
		scenario: "a",
		rep: 3,
	};
	for (const [name, value] of Object.entries(changed)) {
		assert.notEqual(
			sampleKeyId(sampleKey({ ...KEY_PARTS, [name]: value })),
			base,
			name,
		);
	}
	assert.throws(() => sampleKey({ ...KEY_PARTS, model: "" }), /missing model/);
});

test("canonical JSON ignores key order", () => {
	assert.equal(
		canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }),
		canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }),
	);
});

const usage = (input, cacheRead, cacheWrite, output, cost) => ({
	input,
	cacheRead,
	cacheWrite,
	output,
	cost: { total: cost },
});
const assistant = (u, stopReason = "toolUse", text = "") => ({
	type: "message",
	message: {
		role: "assistant",
		stopReason,
		usage: u,
		content: text ? [{ type: "text", text }] : [],
	},
});

test("[F9] parent totals include every usage-bearing entry; the conversation subtotal stays apart", () => {
	const events = [
		{ type: "session" },
		{ type: "message", message: { role: "user", content: "go" } },
		assistant(usage(100, 0, 2000, 50, 0.01)),
		assistant(usage(30, 2000, 400, 20, 0.002), "stop", "ANSWER: x"),
		{ type: "usage", kind: "cache_warm", usage: usage(0, 2400, 0, 0, 0.001) },
		{ type: "compaction", usage: usage(500, 0, 0, 100, 0.003) },
	];
	const summary = summarizeParent(events);
	assert.equal(summary.all.requests, 4);
	assert.equal(summary.all.cumulativeInput, 130 + 4400 + 2400 + 500);
	assert.equal(summary.conversation.requests, 2);
	assert.equal(summary.conversation.cumulativeInput, 4530);
	assert.equal(summary.ledger.length, 4);
});

test("[F9] nested usage of a tool result counts for parent and child, apart from the conversation", () => {
	const toolResult = (u) => ({
		type: "message",
		message: { role: "toolResult", toolName: "ask", isError: false, usage: u },
	});
	const parent = summarizeParent([
		assistant(usage(10, 0, 0, 1, 0.01)),
		toolResult(usage(21, 0, 0, 3, 0.01)),
		{ type: "message", message: { role: "toolResult", toolName: "read" } },
	]);
	assert.equal(parent.all.cumulativeInput, 31);
	assert.equal(parent.all.cost, 0.02);
	assert.equal(parent.conversation.cumulativeInput, 10);
	assert.equal(parent.toolAttributed.cumulativeInput, 21);
	assert.equal(parent.missingUsage, 0);
	const child = summarizeChildren([
		[
			{
				type: "custom",
				customType: "pi-subagents_launch_metadata",
				data: { agent: "r" },
			},
			assistant(usage(5, 0, 0, 1, 0.5), "stop"),
			toolResult(usage(7, 0, 0, 1, 0.25)),
		],
	]);
	assert.equal(child.cost, 0.75);
	assert.equal(child.children[0].cumulativeInput, 12);
	assert.equal(child.children[0].toolAttributed.cumulativeInput, 7);
});

test("a usage-bearing tool result adds tokens and cost but is no request; it counts as a tool usage entry", () => {
	const toolResult = (u) => ({
		type: "message",
		message: { role: "toolResult", toolName: "ask", isError: false, usage: u },
	});
	const parent = summarizeParent([
		assistant(usage(10, 0, 0, 1, 0.01)),
		toolResult(usage(21, 0, 0, 3, 0.01)),
	]);
	const counts = (t) => [t.requests, t.toolUsageEntries, t.cumulativeInput];
	assert.deepEqual(counts(parent.all), [1, 1, 31]);
	assert.deepEqual(counts(parent.conversation), [1, 0, 10]);
	assert.deepEqual(counts(parent.toolAttributed), [0, 1, 21]);
	const child = summarizeChildren([
		[
			{
				type: "custom",
				customType: "pi-subagents_launch_metadata",
				data: { agent: "r" },
			},
			assistant(usage(5, 0, 0, 1, 0.5), "stop"),
			toolResult(usage(7, 0, 0, 1, 0.25)),
		],
	]).children[0];
	assert.deepEqual(counts(child), [1, 1, 12]);
	assert.deepEqual(counts(child.toolAttributed), [0, 1, 7]);
	// All-attempt totals sum the ledgers of two attempts with the same rule.
	assert.deepEqual(
		counts(totals([...parent.ledger, ...parent.ledger])),
		[2, 2, 62],
	);
});

test("[F8] a request without usage is counted as missing evidence, not as zero", () => {
	const events = [
		{
			type: "message",
			message: { role: "assistant", stopReason: "stop", content: [] },
		},
	];
	assert.equal(summarizeParent(events).missingUsage, 1);
});

test("children come in launch order; a nested fork counts from its own (last) launch marker", () => {
	const marker = (agent, timestamp, id) => ({
		type: "custom",
		customType: "pi-subagents_launch_metadata",
		timestamp,
		id,
		data: { agent, name: agent },
	});
	const child = (agent, at, cost) => [
		{ type: "session" },
		marker("ancestor", "2026-01-01T00:00:00Z", "m0"),
		assistant(usage(999, 0, 0, 0, 5)), // inherited before its own marker: not counted
		marker(agent, at, `m-${agent}`),
		assistant(usage(10, 5, 1, 2, cost), "stop"),
	];
	const summary = summarizeChildren([
		child("reviewer", "2026-01-01T00:00:02Z", 0.25),
		child("worker", "2026-01-01T00:00:01Z", 0.5),
		[{ type: "session" }],
	]);
	assert.deepEqual(summary.roles, ["worker", "reviewer"]);
	assert.equal(summary.cost, 0.75);
	assert.equal(summary.children[0].cumulativeInput, 16);
});

test("[F6] the answer is the last line of the terminal reply only", () => {
	assert.equal(
		terminalAnswer([assistant({}, "stop", "ANSWER: `lantern-4127`")]).answer,
		"lantern-4127",
	);
	assert.deepEqual(
		terminalAnswer([assistant({}, "toolUse", "ANSWER: early")]),
		{ terminal: false, answer: null },
	);
	// An embedded quotation is not the answer line.
	assert.equal(
		terminalAnswer([
			assistant(
				{},
				"stop",
				"The note says ANSWER: lantern-4127 but I am unsure.",
			),
		]).answer,
		null,
	);
	assert.equal(
		terminalAnswer([
			assistant({}, "stop", "ANSWER: a"),
			assistant({}, "stop", "Thinking.\nANSWER: b."),
		]).answer,
		"b",
	);
	assert.deepEqual(
		terminalAnswer([assistant({}, "stop", "I could not find it.")]),
		{ terminal: true, answer: null },
	);
});

const SCENARIO = {
	expectedAnswer: "w",
	expectedChildRoles: ["reader"],
	parentToolAllowlist: ["subagent"],
};

test("[F6] a right answer passes only through exactly the expected children and allowed parent tools", () => {
	const delivered = { read: true, returned: true, delivered: true };
	const score = (childRoles, parentTools, answer = "w", outcome = delivered) =>
		scoreAttempt({
			answer,
			childRoles,
			parentTools,
			childOutcomes: childRoles.map(() => outcome),
			scenario: SCENARIO,
		});
	assert.equal(score(["reader"], ["subagent"]), "pass");
	for (const missing of ["read", "returned", "delivered"])
		assert.equal(
			score(["reader"], ["subagent"], "w", { ...delivered, [missing]: false }),
			"wrong-delegation",
		);
	assert.equal(score([], ["read"]), "wrong-delegation");
	assert.equal(score(["reader"], ["subagent", "read"]), "wrong-delegation");
	assert.equal(score(["reader", "reader"], ["subagent"]), "wrong-delegation");
	assert.equal(score(["other"], ["subagent"]), "wrong-delegation");
	assert.equal(score(["reader"], ["subagent"], null), "wrong-answer");
});

test("[F7] load evidence needs a registered tool from the checkout per session, not a named path", () => {
	const tool = (name, path) => ({ name, path });
	const probes = [
		{
			sessionFile: "/s/p.jsonl",
			agent: null,
			model: "p/m",
			thinking: "high",
			tools: [tool("subagent", "/c/src/index.ts")],
		},
		{
			sessionFile: "/s/c1.jsonl",
			agent: "reader",
			tools: [tool("subagent_done", "/c/src/tools/subagent-done.ts")],
		},
		{
			sessionFile: "/s/c2.jsonl",
			agent: "reader",
			tools: [tool("read", "builtin:read")],
		},
	];
	const input = {
		parentFile: "/s/p.jsonl",
		otherFiles: [],
		checkout: "/c",
		parentTool: "subagent",
		childTool: "subagent_done",
	};
	const one = loadEvidence(probes, { ...input, childFiles: ["/s/c1.jsonl"] });
	assert.equal(one.parentLoadedCheckout && one.childrenLoadedCheckout, true);
	// One reporting child cannot stand in for another that did not load.
	assert.equal(
		loadEvidence(probes, {
			...input,
			childFiles: ["/s/c1.jsonl", "/s/c2.jsonl"],
		}).childrenLoadedCheckout,
		false,
	);
	assert.equal(
		loadEvidence(probes, {
			...input,
			childFiles: ["/s/c1.jsonl", "/s/c3.jsonl"],
		}).missingProbes,
		1,
	);
});

test("a provider error is the last parent request ending in error", () => {
	assert.equal(endsWithProviderError([assistant({}, "error")]), true);
	assert.equal(
		endsWithProviderError([assistant({}, "error"), assistant({}, "stop")]),
		false,
	);
});

// Review finding 6: a parent answer with two different values for one key is a
// wrong answer in every keyed scenario; the same value repeated is fine.
for (const scenario of [recon, review, reviewFix])
	test(`[T04 finding 6] ${scenario.name}: a key with two different values does not match`, () => {
		const parse = answerParser(scenario);
		const facts = Object.entries(scenario.expectedFacts);
		const answer = (extra) =>
			[...extra, ...facts.map(([key, value]) => `${key}: ${value}`)].join(
				"\n",
			);
		const [firstKey, firstValue] = facts[0];
		assert.equal(answerMatches(parse(answer([])), scenario), true);
		// The conflicting line comes first, so a last-line-wins parser would pass it.
		const conflict = parse(answer([`${firstKey}: wrong-value-1`]));
		assert.equal(answerMatches(conflict, scenario), false);
		assert.deepEqual(conflict[firstKey], ["wrong-value-1", firstValue]);
		const repeated = parse(answer([`${firstKey}: ${firstValue}`]));
		assert.equal(answerMatches(repeated, scenario), true);
	});
