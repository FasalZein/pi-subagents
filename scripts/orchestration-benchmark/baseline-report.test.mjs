// Run: node --test scripts/orchestration-benchmark/baseline-report.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { median, renderReport, summarize } from "./baseline-report.mjs";
import { sampleKey, sampleKeyId, sealRecord } from "./record.mjs";

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
	harnessHash = "h",
	attemptCount = 1,
}) {
	return sealRecord({
		key: sampleKey({
			checkoutRevision: "c",
			fixtureHash: "f",
			harnessHash,
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
		attemptCount,
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

/** The set's plan as the job runner writes it: key ids and labels of the recorded run. */
const planOf = (entries, label = "model 1") =>
	entries.map(({ record }) => ({
		keyId: sampleKeyId(record.key),
		label,
		scenario: record.key.scenario,
		rep: record.key.rep,
	}));

test("failed verdicts count; infra failures, damaged files and other keys do not", () => {
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
				model: "prov/alpha-2",
			}),
		},
	];
	const plan = planOf(entries);
	entries.push(
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
	);
	const summary = summarize(entries, plan);
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
	assert.match(
		text,
		/\| 2 \| wrong-answer \| 1 \| 30 \| answer "y" does not match/,
	);
	assert.match(
		text,
		/\| 3 \| timeout \| 1 \| 20 \| no answer before the 10-minute deadline/,
	);
	assert.match(text, /d\.json \(model 1\): no verdict: tmux server failed/);
	assert.match(text, /g\.json \(unknown model\): key is not in the plan/);
	assert.match(text, /Parent input by source/);
	assert.match(text, /Counted samples: 3 of 18 planned; not counted: 4/);
});

// Review finding 3: the report reads only the planned keys of the current set.
test("[T04 finding 3] a record of another harness for the same model, scenario and rep is not counted", () => {
	const current = [1, 2, 3].map((rep) => ({
		file: `recon-rep${rep}.json`,
		record: sample({ rep, cumulative: 100 * rep, wall: rep }),
	}));
	const stray = {
		file: "recon-rep1-old.json",
		record: sample({ rep: 1, cumulative: 150, wall: 1, harnessHash: "old" }),
	};
	const summary = summarize([...current, stray], planOf(current));
	assert.equal(summary.counted.length, 3);
	assert.equal(summary.summaries[0].metrics.parentCumulativeInput.median, 200);
	assert.deepEqual(
		summary.notCounted.map(({ file }) => file),
		["recon-rep1-old.json"],
	);
});

test("[T04 finding 3] two records for one planned key stop the report", () => {
	const one = {
		file: "a.json",
		record: sample({ rep: 1, cumulative: 1, wall: 1 }),
	};
	const copy = { ...one, file: "a-copy.json" };
	assert.throws(
		() => summarize([one, copy], planOf([one])),
		/two records for one planned key: a\.json and a-copy\.json/,
	);
});

test("[T04 finding 3] the label comes from the recorded plan, and a planned key without a record is listed", () => {
	const entries = [
		{ file: "a.json", record: sample({ rep: 1, cumulative: 1, wall: 1 }) },
	];
	const plan = [
		...planOf(entries, "model 2"),
		{ keyId: "absent", label: "model 1", scenario: "review", rep: 3 },
	];
	const summary = summarize(entries, plan);
	assert.equal(summary.summaries[0].label, "model 2");
	const text = renderReport(summary, {
		harnessCommit: "abc",
		generatedAt: "now",
		expected: 2,
	});
	assert.match(text, /planned without a record: 1/);
	assert.match(text, /- review rep 3 \(model 1\): planned, no record/);
});

// Review finding 4: retries are visible per sample, with the method's limit.
test("[T04 finding 4] the report lists attempts per sample and marks a retried sample", () => {
	const entries = [
		{ file: "a.json", record: sample({ rep: 1, cumulative: 1, wall: 5 }) },
		{
			file: "b.json",
			record: sample({ rep: 2, cumulative: 1, wall: 6, attemptCount: 2 }),
		},
	];
	const text = renderReport(summarize(entries, planOf(entries)), {
		harnessCommit: "abc",
		generatedAt: "now",
		expected: 2,
	});
	assert.match(text, /\| 1 \| pass \| 1 \| 5 \|/);
	assert.match(text, /\| 2 \| pass \| 2 \(retried\) \| 6 \|/);
	assert.match(text, /Retried samples \(more than 1 attempt\): 1 of 2 counted/);
	assert.match(
		text,
		/A retried sample's metrics are its final attempt's; the spend of failed attempts is not included \(recorded limit\)/,
	);
});

test("[T04 finding 3] gate report reads the planned top-level records only, labelled by the plan", () => {
	const home = mkdtempSync(join(tmpdir(), "gate-report-"));
	try {
		const setDir = join(
			home,
			".pi",
			"artifacts",
			"pi-subagents",
			"benchmark",
			"t",
		);
		mkdirSync(join(setDir, "superseded"), { recursive: true });
		const current = [1, 2, 3].map((rep) => ({
			file: `recon-rep${rep}.json`,
			record: sample({ rep, cumulative: 100 * rep, wall: rep }),
		}));
		const stray = sample({
			rep: 1,
			cumulative: 150,
			wall: 1,
			harnessHash: "old",
		});
		for (const { file, record } of current)
			writeFileSync(join(setDir, file), JSON.stringify(record));
		writeFileSync(join(setDir, "recon-rep1-old.json"), JSON.stringify(stray));
		writeFileSync(join(setDir, "superseded", "x.json"), JSON.stringify(stray));
		writeFileSync(
			join(setDir, "gate-plan.jsonl"),
			planOf(current, "model 2")
				.map((line) => JSON.stringify(line))
				.join("\n"),
		);
		const gate = join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"orchestration-benchmark-gate.mjs",
		);
		const result = spawnSync(process.execPath, [gate, "report", "--set", "t"], {
			encoding: "utf8",
			// Fake refs: the old report needed them; the plan makes them unused.
			env: {
				PATH: process.env.PATH,
				HOME: home,
				BENCH_MODEL_1: "prov/alpha",
				BENCH_MODEL_2: "prov/beta",
			},
		});
		assert.equal(result.status, 0, result.stderr);
		const report = readFileSync(join(setDir, "report.md"), "utf8");
		assert.match(report, /Counted samples: 3 of 3 planned; not counted: 1/);
		assert.match(report, /## recon, model 2 \(n = 3\)/);
		assert.match(
			report,
			/recon-rep1-old\.json \(unknown model\): key is not in the plan/,
		);
		assert.doesNotMatch(report, /x\.json/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
