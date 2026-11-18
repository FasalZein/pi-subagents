// Run: node --test scripts/orchestration-benchmark/baseline-report.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { median, renderReport, summarize } from "./baseline-report.mjs";
import { sampleKey, sealRecord } from "./record.mjs";

test("median of odd and even counts, ignoring non-numbers", () => {
	assert.equal(median([5, 1, 3]), 3);
	assert.equal(median([4, 1, 3, 2]), 2.5);
	assert.equal(median([null, 7]), 7);
	assert.equal(median([]), null);
});

function sample({
	rep,
	cumulative,
	wall,
	verdict = "pass",
	outcome = "verdict",
	model = "prov/alpha",
	scenario = "recon",
}) {
	return sealRecord({
		key: sampleKey({
			checkoutRevision: "c",
			fixtureHash: "f",
			harnessHash: "h",
			model,
			thinking: "high",
			settingsHash: "s",
			scenario,
			rep,
		}),
		model,
		outcome,
		verdict: outcome === "verdict" ? verdict : null,
		infraReason: outcome === "verdict" ? null : "tmux server failed",
		wallTimeMs: wall,
		answer: { expected: "x", observed: "y" },
		final: {
			parent: {
				cumulativeInput: cumulative,
				input: 1,
				cacheRead: cumulative - 1,
				cacheWrite: 0,
				requests: rep,
			},
			parentConversation: { cumulativeInput: cumulative },
			parentToolAttributed: { cumulativeInput: 0 },
			childCost: 0.5,
			delivery: {
				transfers: 6,
				extraCopies: 0,
				undelivered: 0,
				outcomeClasses: { clean_yield: 6 },
			},
		},
	});
}

const labelOf = (model) => (model === "prov/alpha" ? "model 1" : null);

test("failed verdicts count; infra failures, damaged files and other models do not", () => {
	const entries = [
		{ file: "a.json", record: sample({ rep: 1, cumulative: 100, wall: 10 }) },
		{
			file: "b.json",
			record: sample({
				rep: 2,
				cumulative: 300,
				wall: 30,
				verdict: "wrong-answer",
			}),
		},
		{
			file: "c.json",
			record: sample({ rep: 3, cumulative: 200, wall: 20, verdict: "timeout" }),
		},
		{
			file: "d.json",
			record: sample({
				rep: 3,
				cumulative: 9000,
				wall: 1,
				outcome: "infra-failure",
			}),
		},
		{
			file: "e.json",
			record: {
				...sample({ rep: 1, cumulative: 9000, wall: 1 }),
				wallTimeMs: 2,
			},
		},
		{ file: "f.json", record: null },
		{
			file: "g.json",
			record: sample({
				rep: 1,
				cumulative: 9000,
				wall: 1,
				model: "prov/other",
			}),
		},
	];
	const summary = summarize(entries, labelOf);
	assert.equal(summary.counted.length, 3);
	assert.equal(summary.notCounted.length, 4);
	const [group] = summary.summaries;
	assert.equal(group.label, "model 1");
	assert.deepEqual(group.metrics.parentCumulativeInput, {
		median: 200,
		min: 100,
		max: 300,
		n: 3,
	});
	assert.equal(group.metrics.wallTimeMs.median, 20);
	assert.equal(group.metrics.parentRequests.median, 2);
	const text = renderReport(summary, {
		harnessCommit: "abc",
		generatedAt: "now",
		expected: 18,
	});
	assert.match(text, /\| 2 \| wrong-answer \| 30 \| answer "y" does not match/);
	assert.match(
		text,
		/\| 3 \| timeout \| 20 \| no answer before the 10-minute deadline/,
	);
	assert.match(text, /d\.json \(model 1\): no verdict: tmux server failed/);
	assert.match(text, /Parent input by source/);
	assert.match(text, /Counted samples: 3 of 18 planned; not counted: 4/);
});
