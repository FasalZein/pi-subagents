// Run: node --test scripts/orchestration-benchmark/review-scenario.test.mjs
// Scenario (b) of G2.1: the keyed verdict oracle and the planted fixture. No model, no Pi.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { answerMatches, answerParser, terminalAnswer } from "./record.mjs";
import review from "./scenarios/review/scenario.mjs";

const reviewDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"scenarios",
	"review",
);
const reply = (text) => [
	{
		type: "message",
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text }],
		},
	},
];
const score = (text) =>
	answerMatches(
		terminalAnswer(reply(text), answerParser(review)).answer,
		review,
	);
// Expected values come from the planted files, not from the scenario module.
const planted = () => {
	const dir = join(reviewDir, "workspace", "review");
	return readdirSync(dir)
		.sort()
		.map((name) => {
			const lines = readFileSync(join(dir, name), "utf8")
				.trim()
				.split("\n");
			const match = lines.at(-1).match(/^([\w-]+): ((?:approve|reject)-\d{4})$/);
			assert.ok(match, `${name} ends with a verdict line`);
			assert.equal(`${match[1]}.md`, name);
			return [match[1], match[2]];
		});
};

test("[T03a-1] the review fixture plants 8 verdicts, one per target file, each read by one child", () => {
	const verdicts = planted();
	assert.equal(verdicts.length, 8);
	assert.deepEqual(
		Object.fromEntries(verdicts),
		review.expectedFacts,
	);
	// Both verdict kinds occur, so a constant guess cannot pass.
	assert.deepEqual(
		new Set(verdicts.map(([, v]) => v.split("-")[0])),
		new Set(["approve", "reject"]),
	);
	assert.equal(review.expectedChildRoles.length, 8);
	for (const [target, verdict] of verdicts) {
		assert.deepEqual(review.childResults[`bench-review-${target}`], {
			returns: [verdict],
			facts: { [target]: verdict },
			reads: [`review/${target}.md`],
		});
	}
	// No agent file holds a verdict: each one reaches the parent only through its child.
	const agents = join(reviewDir, "agents");
	for (const name of readdirSync(agents))
		assert.doesNotMatch(
			readFileSync(join(agents, name), "utf8"),
			/(approve|reject)-\d{4}/,
		);
});

test("[T03a-2] children get unique launch names (launcher limit Namesakes)", () => {
	const names = [...review.prompt.matchAll(/name "([\w-]+)"/g)].map((m) => m[1]);
	assert.equal(names.length, 8);
	assert.equal(new Set(names).size, 8);
	const agents = [...review.prompt.matchAll(/agent "([\w-]+)"/g)].map((m) => m[1]);
	assert.deepEqual([...agents].sort(), [...review.expectedChildRoles].sort());
});

test("[T03a-3] the oracle passes 8 verdicts keyed by target, in any order", () => {
	const lines = planted().map(([t, v]) => `${t}: ${v}`);
	assert.equal(score(lines.join("\n")), true);
	assert.equal(score(["Done.", ...lines.toReversed()].join("\n")), true);
});

test("[T03a-4] a digest of 8 lines that names the wrong targets fails", () => {
	const verdicts = planted();
	// Right verdict values, in the right order, under other target names.
	const wrongTargets = verdicts.map(([, v], i) => `target-${i + 1}: ${v}`);
	assert.equal(wrongTargets.length, 8);
	assert.equal(score(wrongTargets.join("\n")), false);
	// Right target names with the verdicts shifted by one target.
	const shifted = verdicts.map(
		([t], i) => `${t}: ${verdicts[(i + 1) % verdicts.length][1]}`,
	);
	assert.equal(score(shifted.join("\n")), false);
	// 7 of 8 targets.
	const seven = verdicts.slice(1).map(([t, v]) => `${t}: ${v}`);
	assert.equal(score(seven.join("\n")), false);
});
