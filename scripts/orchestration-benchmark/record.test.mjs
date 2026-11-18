// Run: node --test scripts/orchestration-benchmark/record.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	canonicalJson,
	endsWithProviderError,
	findParentAnswer,
	rerunDecision,
	sampleKey,
	sampleKeyId,
	sealRecord,
	summarizeChildren,
	summarizeParent,
} from "./record.mjs";

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

const assistant = (usage, stopReason = "toolUse", text = "") => ({
	type: "message",
	message: {
		role: "assistant",
		stopReason,
		usage,
		content: text ? [{ type: "text", text }] : [],
	},
});

test("parent input is split into input, cache read and cache write over all requests", () => {
	const events = [
		{ type: "session" },
		{ type: "message", message: { role: "user", content: "go" } },
		assistant({
			input: 100,
			cacheRead: 0,
			cacheWrite: 2000,
			output: 50,
			cost: { total: 0.01 },
		}),
		assistant(
			{
				input: 30,
				cacheRead: 2000,
				cacheWrite: 400,
				output: 20,
				cost: { total: 0.002 },
			},
			"stop",
			"ANSWER: x",
		),
		{
			type: "usage",
			kind: "cache_warm",
			usage: {
				input: 0,
				cacheRead: 2400,
				cacheWrite: 0,
				cost: { total: 0.001 },
			},
		},
	];
	const summary = summarizeParent(events);
	assert.equal(summary.requests, 2);
	assert.deepEqual(summary.cumulativeInput, {
		input: 130,
		cacheRead: 2000,
		cacheWrite: 2400,
		total: 4530,
	});
	assert.equal(summary.otherUsage.cache_warm.requests, 1);
	assert.equal(summary.otherUsage.cache_warm.cacheRead, 2400);
});

test("children come in launch order with their roles and cost after the launch marker", () => {
	const child = (agent, startedAt, cost) => [
		{ type: "session", timestamp: startedAt },
		assistant({ input: 999, cost: { total: 5 } }), // seeded copy before the marker: not counted
		{
			type: "custom",
			customType: "pi-subagents_launch_metadata",
			data: { agent, name: agent },
		},
		assistant(
			{
				input: 10,
				cacheRead: 5,
				cacheWrite: 1,
				output: 2,
				cost: { total: cost },
			},
			"stop",
		),
	];
	const summary = summarizeChildren([
		child("reviewer", "2026-01-01T00:00:02Z", 0.25),
		child("worker", "2026-01-01T00:00:01Z", 0.5),
		[{ type: "session" }],
	]);
	assert.deepEqual(summary.roles, ["worker", "reviewer"]);
	assert.equal(summary.cost, 0.75);
	assert.equal(summary.children[0].input, 16);
});

test("the parent answer is the last ANSWER line of a normally ended reply", () => {
	assert.equal(
		findParentAnswer([assistant({}, "stop", "ANSWER: `lantern-4127`")]),
		"lantern-4127",
	);
	assert.equal(
		findParentAnswer([assistant({}, "toolUse", "ANSWER: early")]),
		null,
	);
	assert.equal(
		findParentAnswer([
			assistant({}, "stop", "ANSWER: a"),
			assistant({}, "stop", "ANSWER: b."),
		]),
		"b",
	);
});

test("a provider error is the last parent request ending in error", () => {
	assert.equal(endsWithProviderError([assistant({}, "error")]), true);
	assert.equal(
		endsWithProviderError([assistant({}, "error"), assistant({}, "stop")]),
		false,
	);
});
