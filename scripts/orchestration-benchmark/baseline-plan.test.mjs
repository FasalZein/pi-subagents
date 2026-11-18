// Run: node --test scripts/orchestration-benchmark/baseline-plan.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelOfRef, pendingSamples, samplePlan } from "./baseline-plan.mjs";
import { sampleKey, sealRecord } from "./record.mjs";

const MODELS = [
	{ label: "model 1", ref: "prov/alpha:high" },
	{ label: "model 2", ref: "prov/beta" },
];
const RUN = { commit: "cf6dbf4full", thinking: "high" };

function record({
	model,
	scenario,
	rep,
	outcome = "verdict",
	verdict = "pass",
	commit = RUN.commit,
	thinking = "high",
}) {
	return sealRecord({
		key: sampleKey({
			checkoutRevision: commit,
			fixtureHash: "f",
			harnessHash: "h",
			model,
			thinking,
			settingsHash: "s",
			scenario,
			rep,
		}),
		outcome,
		verdict: outcome === "verdict" ? verdict : null,
		infraReason: outcome === "verdict" ? null : "parent did not start",
	});
}

test("modelOfRef drops a thinking suffix only", () => {
	assert.equal(modelOfRef("prov/alpha:high"), "prov/alpha");
	assert.equal(modelOfRef("prov/beta"), "prov/beta");
});

test("the plan has 18 distinct samples, repetition-major", () => {
	const plan = samplePlan(MODELS);
	assert.equal(plan.length, 18);
	assert.equal(
		new Set(plan.map((s) => `${s.model}|${s.scenario}|${s.rep}`)).size,
		18,
	);
	assert.deepEqual(
		plan.slice(0, 6).map((s) => s.rep),
		[1, 1, 1, 1, 1, 1],
	);
	assert.equal(plan[0].model, "prov/alpha");
});

test("with no records every sample is pending", () => {
	assert.equal(pendingSamples(samplePlan(MODELS), [], RUN).length, 18);
});

test("a sealed verdict, failed ones included, keeps its sample out of the queue", () => {
	const records = [
		record({ model: "prov/alpha", scenario: "recon", rep: 1 }),
		record({
			model: "prov/beta",
			scenario: "review",
			rep: 2,
			verdict: "timeout",
		}),
		record({
			model: "prov/beta",
			scenario: "review-fix",
			rep: 3,
			verdict: "wrong-answer",
		}),
	];
	const pending = pendingSamples(samplePlan(MODELS), records, RUN);
	assert.equal(pending.length, 15);
	assert.ok(
		!pending.some(
			(s) => s.model === "prov/alpha" && s.scenario === "recon" && s.rep === 1,
		),
	);
});

test("an infrastructure failure, a broken checksum or another key runs again", () => {
	const broken = {
		...record({ model: "prov/alpha", scenario: "recon", rep: 1 }),
		verdict: "wrong-answer",
	};
	const records = [
		record({
			model: "prov/alpha",
			scenario: "recon",
			rep: 2,
			outcome: "infra-failure",
		}),
		broken,
		record({ model: "prov/alpha", scenario: "recon", rep: 3, commit: "other" }),
		record({ model: "prov/beta", scenario: "recon", rep: 1, thinking: "low" }),
	];
	assert.equal(pendingSamples(samplePlan(MODELS), records, RUN).length, 18);
});
