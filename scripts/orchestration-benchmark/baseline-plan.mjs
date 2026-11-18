/**
 * Sample plan of a gate run (G2.1): pure functions only.
 *
 * A gate run is 3 scenarios x 2 models x 3 repetitions. A planned sample is
 * finished when the run folder holds a sealed record with a verdict for its
 * scenario, repetition, model, thinking and checkout commit. Everything else
 * (no file, damaged file, infrastructure failure) runs again. The launcher
 * still decides on the full key; this plan only keeps finished samples out
 * of the job queue and the job log.
 */
import { hasValidChecksum } from "./record.mjs";

export const GATE_SCENARIOS = Object.freeze(["recon", "review", "review-fix"]);
export const GATE_REPETITIONS = 3;
/** Environment variables that hold the two owner-named model refs, in order. */
export const MODEL_ENV = Object.freeze(["BENCH_MODEL_1", "BENCH_MODEL_2"]);

/**
 * Model part of a ref, as the launcher records it (a thinking suffix is dropped).
 * @param {string} ref
 */
export function modelOfRef(ref) {
	const colon = ref.lastIndexOf(":");
	const slash = ref.indexOf("/");
	return colon > slash ? ref.slice(0, colon) : ref;
}

/**
 * Repetition-major order, so a stopped run still has every scenario and model
 * at the lowest repetitions.
 * @param {Array<{label: string, ref: string}>} models
 * @returns {Array<{label: string, ref: string, model: string, scenario: string, rep: number}>}
 */
export function samplePlan(models) {
	const plan = [];
	for (let rep = 1; rep <= GATE_REPETITIONS; rep++)
		for (const scenario of GATE_SCENARIOS)
			for (const { label, ref } of models)
				plan.push({ label, ref, model: modelOfRef(ref), scenario, rep });
	return plan;
}

/** A record that a rerun keeps: sealed, with a verdict. */
export function isFinishedRecord(record) {
	return (
		hasValidChecksum(record) &&
		record.outcome === "verdict" &&
		typeof record.verdict === "string"
	);
}

/**
 * Planned samples without a finished record.
 * @param {ReturnType<typeof samplePlan>} plan
 * @param {Array<object>} records - parsed records of the run folder (unparsable files left out)
 * @param {{commit: string, thinking: string}} run
 */
export function pendingSamples(plan, records, { commit, thinking }) {
	const finished = records.filter(isFinishedRecord);
	return plan.filter(
		(sample) =>
			!finished.some(
				({ key }) =>
					key.checkoutRevision === commit &&
					key.thinking === thinking &&
					key.model === sample.model &&
					key.scenario === sample.scenario &&
					key.rep === sample.rep,
			),
	);
}
