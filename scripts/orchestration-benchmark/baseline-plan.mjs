/**
 * Sample plan of a gate run (G2.1): pure functions only.
 *
 * A gate run is 3 scenarios x 2 models x 3 repetitions. The launcher computes
 * each planned sample's full key (checkout, fixture, harness, model and
 * thinking, settings with the Pi version, scenario, repetition; launcher
 * --plan), and the queue applies the launcher's own rerun rule to that key:
 * a sample runs unless its file holds a sealed verdict under the same key.
 */
import { rerunDecision, sampleKeyId } from "./record.mjs";

export const GATE_SCENARIOS = Object.freeze(["recon", "review", "review-fix"]);
/** The candidate gate (T59): scenario (b) runs as a workflow script (G2.1). */
export const CANDIDATE_SCENARIOS = Object.freeze([
	"recon",
	"review-workflow",
	"review-fix",
]);
export const GATE_REPETITIONS = 3;
/** Environment variables that hold the two owner-named model refs, in order. */
export const MODEL_ENV = Object.freeze(["BENCH_MODEL_1", "BENCH_MODEL_2"]);

/**
 * Repetition-major order, so a stopped run still has every scenario and model
 * at the lowest repetitions.
 * @param {Array<{label: string, ref: string}>} models
 * @param {readonly string[]} [scenarios]
 * @returns {Array<{label: string, ref: string, scenario: string, rep: number}>}
 */
export function samplePlan(models, scenarios = GATE_SCENARIOS) {
	const plan = [];
	for (let rep = 1; rep <= GATE_REPETITIONS; rep++)
		for (const scenario of scenarios)
			for (const { label, ref } of models)
				plan.push({ label, ref, scenario, rep });
	return plan;
}

/**
 * Refuses a plan where two samples share one full key (for example the same
 * model in both slots): such a plan counts one sample twice.
 * @param {Array<{key: object}>} planned
 */
export function assertDistinctKeys(planned) {
	const ids = new Set(planned.map(({ key }) => sampleKeyId(key)));
	if (ids.size !== planned.length)
		throw new Error(
			`the plan has ${planned.length} samples but ${ids.size} distinct keys`,
		);
}

/**
 * Planned samples that the launcher would run: no sealed verdict under their full key.
 * @template {{key: object, file: string}} T
 * @param {T[]} planned - plan entries with the launcher's key and sample file name
 * @param {(file: string) => string | null} readText - text of a top-level set file, null when absent
 * @returns {T[]}
 */
export function pendingSamples(planned, readText) {
	return planned.filter(
		({ key, file }) => rerunDecision(readText(file), key).action === "run",
	);
}
