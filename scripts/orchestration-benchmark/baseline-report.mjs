/**
 * Report of a gate run (G2.1): pure functions that turn sealed records into
 * medians per scenario and model. A sample counts when its record is sealed
 * and has a verdict; failed verdicts (wrong answer, wrong delegation, timeout)
 * count. A record without a verdict (infrastructure failure) or with a broken
 * checksum is listed and never counted.
 */
import { hasValidChecksum } from "./record.mjs";

/** Median of the numbers; the mean of the middle two for an even count; null when empty. */
export function median(values) {
	const sorted = values
		.filter((value) => typeof value === "number" && Number.isFinite(value))
		.sort((a, b) => a - b);
	if (!sorted.length) return null;
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Metrics of one sample, each with the record field it comes from.
 * Parent totals cover the last attempt (final.parent); a provider-error
 * retry is in allAttempts and not in these medians.
 */
export const METRICS = Object.freeze([
	[
		"parentCumulativeInput",
		"final.parent.cumulativeInput",
		"parent input + cache read + cache write, tokens",
	],
	[
		"parentInput",
		"final.parent.input",
		"parent fresh (uncached) input, tokens",
	],
	["parentCacheRead", "final.parent.cacheRead", "parent cache read, tokens"],
	["parentCacheWrite", "final.parent.cacheWrite", "parent cache write, tokens"],
	[
		"parentRequests",
		"final.parent.requests",
		"parent model requests (tool-result usage rows excluded)",
	],
	["wallTimeMs", "wallTimeMs", "prompt submission to answer or deadline, ms"],
	["childCost", "final.childCost", "sum of child session costs, USD"],
	[
		"transfers",
		"final.delivery.transfers",
		"result transfers into the parent, by run id",
	],
	[
		"cleanYields",
		"final.delivery.outcomeClasses.clean_yield",
		"children classed clean_yield",
	],
	[
		"extraCopies",
		"final.delivery.extraCopies",
		"result carriers beyond the first per run id",
	],
	[
		"undelivered",
		"final.delivery.undelivered",
		"runs whose result never reached the parent",
	],
]);

/** Parent input by source, scenario (a) only: conversation requests against tool-attributed usage. */
export const RECON_SOURCES = Object.freeze([
	[
		"conversationCumulativeInput",
		"final.parentConversation.cumulativeInput",
		"parent's own model requests",
	],
	[
		"toolAttributedCumulativeInput",
		"final.parentToolAttributed.cumulativeInput",
		"nested model work inside parent tool results",
	],
]);

function pick(record, path) {
	let value = record;
	for (const part of path.split(".")) value = value?.[part];
	return typeof value === "number" ? value : null;
}

/**
 * @param {Array<{file: string, record: object}>} entries - every JSON file of the run folder
 * @param {(model: string) => string | null} labelOf - model label, null for a model outside the run
 */
export function summarize(entries, labelOf) {
	const counted = [];
	const notCounted = [];
	for (const { file, record } of entries) {
		const label = record?.model ? labelOf(record.model) : null;
		if (!hasValidChecksum(record))
			notCounted.push({ file, label, reason: "checksum does not match" });
		else if (!label)
			notCounted.push({
				file,
				label,
				reason: "model is not one of the run models",
			});
		else if (record.outcome !== "verdict")
			notCounted.push({
				file,
				label,
				reason: `no verdict: ${record.infraReason ?? "unknown"}`,
			});
		else counted.push({ file, label, record });
	}
	const groups = new Map();
	for (const sample of counted) {
		const id = `${sample.record.key.scenario}\u0000${sample.label}`;
		if (!groups.has(id))
			groups.set(id, {
				scenario: sample.record.key.scenario,
				label: sample.label,
				samples: [],
			});
		groups.get(id).samples.push(sample);
	}
	const fields = [...METRICS, ...RECON_SOURCES];
	const summaries = [...groups.values()]
		.sort(
			(a, b) =>
				a.scenario.localeCompare(b.scenario) || a.label.localeCompare(b.label),
		)
		.map((group) => {
			group.samples.sort((a, b) => a.record.key.rep - b.record.key.rep);
			const metrics = {};
			for (const [name, path] of fields) {
				const values = group.samples.map(({ record }) => pick(record, path));
				const present = values.filter((value) => value !== null);
				metrics[name] = {
					median: median(present),
					min: present.length ? Math.min(...present) : null,
					max: present.length ? Math.max(...present) : null,
					n: present.length,
				};
			}
			return { ...group, metrics };
		});
	const harnessHashes = new Set(
		counted.map(({ record }) => record.key.harnessHash),
	);
	const commits = new Set(
		counted.map(({ record }) => record.key.checkoutRevision),
	);
	return {
		summaries,
		notCounted,
		counted,
		harnessHashes: [...harnessHashes],
		commits: [...commits],
	};
}

/** Why a failed verdict failed, from the scored last attempt. */
export function failureCause(record) {
	const attempt = record.attempts?.at(-1);
	if (record.verdict === "timeout")
		return "no answer before the 10-minute deadline";
	if (record.verdict === "wrong-answer")
		return `answer ${JSON.stringify(record.answer?.observed ?? null)} does not match the expected answer`;
	if (record.verdict === "wrong-delegation") {
		const outcomes = attempt?.childOutcomes;
		return `answer came without the expected children: ${JSON.stringify(outcomes ?? null)}`;
	}
	return "unknown";
}

const fmt = (value) =>
	value === null
		? "n/a"
		: Number.isInteger(value)
			? String(value)
			: value.toFixed(4);

/**
 * @param {ReturnType<typeof summarize>} summary
 * @param {{harnessCommit: string, generatedAt: string, expected: number}} meta
 */
export function renderReport(summary, meta) {
	const lines = [
		"# Orchestration benchmark: baseline gate (G2.1, T04)",
		"",
		`Generated ${meta.generatedAt}. Harness commit ${meta.harnessCommit}; harness hash(es) ${summary.harnessHashes.join(", ") || "none"}.`,
		`Measured commit(s): ${summary.commits.join(", ") || "none"}. Counted samples: ${summary.counted.length} of ${meta.expected} planned; not counted: ${summary.notCounted.length}.`,
		"",
		"## How to read the numbers",
		"",
		"- A sample counts when its sealed record has a verdict. Failed verdicts count; records without a verdict are listed under Not counted.",
		"- Each cell is the median over the counted samples of one scenario and model, with the range (min to max) and the sample count n. A metric missing in a record (n below the sample count) is left out of that median, not read as zero.",
		"- Values come from the last attempt of a sample. The parent ledger counts every usage-bearing entry of the parent session.",
		"- Spread: with n = 3 the median is the middle sample; a candidate difference smaller than the range here is inside run-to-run noise.",
		"- Limiter: not profiled. Wall time includes provider latency, Pi start-up and tmux, so it is a context number, not a gate metric.",
		"",
		"Metrics:",
		...METRICS.map(([name, path, text]) => `- ${name}: ${text} (\`${path}\`).`),
		"",
	];
	for (const group of summary.summaries) {
		lines.push(
			`## ${group.scenario}, ${group.label} (n = ${group.samples.length})`,
			"",
		);
		lines.push("| metric | median | min | max | n |", "|---|---|---|---|---|");
		for (const [name] of METRICS) {
			const m = group.metrics[name];
			lines.push(
				`| ${name} | ${fmt(m.median)} | ${fmt(m.min)} | ${fmt(m.max)} | ${m.n} |`,
			);
		}
		if (group.scenario === "recon") {
			lines.push("", "Parent input by source (cumulative input, tokens):", "");
			lines.push(
				"| source | median | min | max | n |",
				"|---|---|---|---|---|",
			);
			for (const [name, path, text] of [
				...RECON_SOURCES,
				["parentInput", "", "fresh input"],
				["parentCacheRead", "", "cache read"],
				["parentCacheWrite", "", "cache write"],
			]) {
				const m = group.metrics[name];
				lines.push(
					`| ${text}${path ? ` (\`${path}\`)` : ""} | ${fmt(m.median)} | ${fmt(m.min)} | ${fmt(m.max)} | ${m.n} |`,
				);
			}
		}
		lines.push(
			"",
			"Samples:",
			"",
			"| rep | verdict | wall time ms | cause of a failed verdict | file |",
			"|---|---|---|---|---|",
		);
		for (const { file, record } of group.samples) {
			const cause =
				record.verdict === "pass"
					? ""
					: failureCause(record).replaceAll("|", "\\|");
			lines.push(
				`| ${record.key.rep} | ${record.verdict} | ${fmt(record.wallTimeMs ?? null)} | ${cause} | ${file} |`,
			);
		}
		lines.push("");
	}
	lines.push("## Not counted", "");
	if (!summary.notCounted.length) lines.push("None.");
	for (const { file, label, reason } of summary.notCounted)
		lines.push(`- ${file} (${label ?? "unknown model"}): ${reason}`);
	lines.push("");
	return lines.join("\n");
}
