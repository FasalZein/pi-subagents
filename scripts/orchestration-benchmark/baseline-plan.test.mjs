// Run: node --test scripts/orchestration-benchmark/baseline-plan.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assertDistinctKeys,
	CANDIDATE_SCENARIOS,
	pendingSamples,
	samplePlan,
} from "./baseline-plan.mjs";
import { sampleFileName, sampleKey, sealRecord } from "./record.mjs";

const MODELS = [
	{ label: "model 1", ref: "prov/alpha:high" },
	{ label: "model 2", ref: "prov/beta" },
];
const BASE = {
	checkoutRevision: "cf6dbf4full",
	fixtureHash: "f",
	harnessHash: "h",
	model: "prov/alpha",
	thinking: "high",
	settingsHash: "s",
	scenario: "recon",
	rep: 1,
};

/** A planned entry as the gate builds it from launcher --plan. */
const planned = (parts) => {
	const key = sampleKey({ ...BASE, ...parts });
	return { key, file: sampleFileName(key) };
};

function recordText(key, { outcome = "verdict", verdict = "pass" } = {}) {
	return JSON.stringify(
		sealRecord({
			key,
			outcome,
			verdict: outcome === "verdict" ? verdict : null,
			infraReason: outcome === "verdict" ? null : "parent did not start",
		}),
	);
}

/** A set folder: file name to text. */
const folder = (files) => (file) => files.get(file) ?? null;

test("the plan has 18 distinct samples, repetition-major", () => {
	const plan = samplePlan(MODELS);
	assert.equal(plan.length, 18);
	assert.equal(
		new Set(plan.map((s) => `${s.label}|${s.scenario}|${s.rep}`)).size,
		18,
	);
	assert.deepEqual(
		plan.slice(0, 6).map((s) => s.rep),
		[1, 1, 1, 1, 1, 1],
	);
});

test("a plan with one key twice is refused", () => {
	assert.throws(
		() => assertDistinctKeys([planned({}), planned({})]),
		/2 samples but 1 distinct keys/,
	);
	assertDistinctKeys([planned({}), planned({ model: "prov/beta" })]);
});

test("with no files every sample is pending", () => {
	const plan = [planned({}), planned({ rep: 2 })];
	assert.equal(pendingSamples(plan, folder(new Map())).length, 2);
});

test("a sealed verdict under the full key, failed ones included, keeps its sample out of the queue", () => {
	const plan = ["pass", "timeout", "wrong-answer"].map((verdict, index) => ({
		...planned({ rep: index + 1 }),
		verdict,
	}));
	const files = new Map(
		plan.map(({ key, file, verdict }) => [file, recordText(key, { verdict })]),
	);
	assert.deepEqual(pendingSamples(plan, folder(files)), []);
});

test("an infrastructure failure or a broken checksum runs again", () => {
	const infra = planned({ rep: 1 });
	const broken = planned({ rep: 2 });
	const files = new Map([
		[infra.file, recordText(infra.key, { outcome: "infra-failure" })],
		[
			broken.file,
			JSON.stringify({
				...JSON.parse(recordText(broken.key)),
				verdict: "timeout",
			}),
		],
	]);
	assert.equal(pendingSamples([infra, broken], folder(files)).length, 2);
});

// Review finding 2: a verdict that matches checkout, model, thinking, scenario
// and rep but not the fixture, harness or settings (Pi version) hash is another
// sample. Each component is varied alone; the old verdict stays intact.
for (const [part, value] of Object.entries({
	checkoutRevision: "other",
	fixtureHash: "f2",
	harnessHash: "h2",
	model: "prov/beta",
	thinking: "low",
	settingsHash: "s-other-pi-version",
	scenario: "review",
	rep: 2,
}))
	test(`[T04 finding 2] an old verdict with another ${part} does not finish the planned sample`, () => {
		const now = planned({ [part]: value });
		const old = sampleKey(BASE);
		// The old verdict sits in the planned file name, so only the key can tell them apart.
		const files = new Map([[now.file, recordText(old)]]);
		assert.deepEqual(pendingSamples([now], folder(files)), [now]);
	});

test("[T59a] the candidate gate plans 18 samples with the workflow arm of scenario (b)", () => {
	const plan = samplePlan(MODELS, CANDIDATE_SCENARIOS);
	assert.equal(plan.length, 18);
	assert.deepEqual([...new Set(plan.map((s) => s.scenario))], ["recon", "review-workflow", "review-fix"]);
	assert.equal(samplePlan(MODELS).some((s) => s.scenario === "review-workflow"), false);
});

