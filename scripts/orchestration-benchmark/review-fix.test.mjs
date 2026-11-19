/**
 * Scenario (c) review-fix: the fixture, its oracle and its verdicts.
 * Reference edits stand for the work of each child. The expected outcomes come
 * from G2.1 (c): the build alone leaves the planted finding R-2 open, so only
 * build plus review plus fix passes the held-out test.
 */
import assert from "node:assert/strict";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { answerParser, holdsResult, scoreAttempt } from "./record.mjs";
import {
	changedTestFiles,
	FIXTURE_DIR,
	HELD_OUT_TEST,
	heldOutPasses,
	inspectPhase,
	inspectWorkspace,
	visibleTestPasses,
} from "./scenarios/review-fix/oracle.mjs";
import scenario from "./scenarios/review-fix/scenario.mjs";

const temp = mkdtempSync(join(tmpdir(), "review-fix-test-"));
after(() => rmSync(temp, { recursive: true, force: true }));

let copies = 0;
/** A fresh workspace copy with the given edits applied to src/cart.mjs. */
function workspace(...edits) {
	const dir = join(temp, `w${++copies}`);
	cpSync(FIXTURE_DIR, dir, { recursive: true });
	const file = join(dir, "src", "cart.mjs");
	let text = readFileSync(file, "utf8");
	for (const [from, to] of edits) {
		assert.ok(text.includes(from), `reference edit applies: ${from}`);
		text = text.replace(from, to);
	}
	writeFileSync(file, text);
	return dir;
}

// What the build child does: whole cents.
const BUILD = [
	"return totalCents - (totalCents * percent) / 100;",
	"return Math.round(totalCents - (totalCents * percent) / 100);",
];
// What the fix child does for R-2.
const FIX = [
	"export function lineTotal(priceCents, quantity) {\n",
	'export function lineTotal(priceCents, quantity) {\n\tif (!Number.isInteger(quantity) || quantity < 1)\n\t\tthrow new RangeError("quantity must be a positive integer");\n',
];

describe("review-fix fixture", () => {
	test("the fixture test fails before the build and passes after it", () => {
		assert.equal(visibleTestPasses(workspace()), false);
		assert.equal(visibleTestPasses(workspace(BUILD)), true);
	});

	test("a build without a review fails the held-out test", () => {
		assert.equal(heldOutPasses(workspace(BUILD)), false);
	});

	test("a fix without the build fails the held-out test", () => {
		assert.equal(heldOutPasses(workspace(FIX)), false);
	});

	test("build plus review fix passes the held-out test and the fixture test", () => {
		const dir = workspace(BUILD, FIX);
		assert.equal(heldOutPasses(dir), true);
		assert.equal(visibleTestPasses(dir), true);
	});

	test("phase facts tell the build state from the fixed state", () => {
		const facts = (visibleTestPassed, findingFixed) => ({
			visibleTestPassed,
			findingFixed,
		});
		assert.deepEqual(inspectPhase(workspace()), facts(false, false));
		assert.deepEqual(inspectPhase(workspace(BUILD)), facts(true, false));
		assert.deepEqual(inspectPhase(workspace(FIX)), facts(false, true));
		assert.deepEqual(inspectPhase(workspace(BUILD, FIX)), facts(true, true));
	});

	test("the held-out test is outside the workspace the children get", () => {
		assert.ok(relative(FIXTURE_DIR, HELD_OUT_TEST).startsWith(".."));
	});
});

// T04 diagnosis, doubt 1: after a correct build, a careful review child read
// R-1 as broken too (a fractional quantity gives fractional cents), so a faithful
// parent relay of "R-1, R-2" scored wrong-answer. Only R-2 may be broken then.
describe("review-fix checklist", () => {
	const checklist = readFileSync(
		join(dirname(FIXTURE_DIR), "agents", "bench-review.md"),
		"utf8",
	);
	const rules = Object.fromEntries(
		[...checklist.matchAll(/^- (R-\d+): (.+)$/gm)].map((m) => [m[1], m[2]]),
	);
	// One check per rule, as a reviewer applies the rule text to the code.
	const checks = {
		// The quantities R-1 covers: every number, unless R-1 itself limits them
		// to positive integers (a bad quantity is then R-2 only).
		"R-1": async (dir) => {
			const quantities = /positive integer quantit/i.test(rules["R-1"])
				? [1, 2, 3, 7]
				: [1, 1.5, 2.5, 7];
			const cart = await import(
				pathToFileURL(join(dir, "src", "cart.mjs")).href
			);
			const results = [];
			for (const price of [1, 99, 250, 999])
				for (const quantity of quantities) {
					results.push(cart.lineTotal(price, quantity));
					results.push(cart.cartTotal([{ priceCents: price, quantity }]));
				}
			for (const total of [0, 1, 99, 999, 1000])
				for (let percent = 0; percent <= 100; percent++)
					results.push(cart.applyDiscount(total, percent));
			return results.every(Number.isInteger);
		},
		"R-2": async (dir) => heldOutPasses(dir, "^R-2"),
		"R-3": async (dir) =>
			!/console\.|process\.env/.test(
				readFileSync(join(dir, "src", "cart.mjs"), "utf8"),
			),
	};
	const broken = async (dir) => {
		const ids = [];
		for (const id of Object.keys(rules))
			if (!(await checks[id](dir))) ids.push(id);
		return ids;
	};

	test("the checklist holds the rules R-1 to R-3", () => {
		assert.deepEqual(Object.keys(rules), ["R-1", "R-2", "R-3"]);
	});

	test("after a correct build only R-2 is broken; after the fix none is", async () => {
		assert.deepEqual(await broken(workspace(BUILD)), ["R-2"]);
		assert.deepEqual(await broken(workspace(BUILD, FIX)), []);
	});

	test("a relay of two findings still scores wrong-answer: the oracle stays strict", () => {
		const parse = answerParser(scenario);
		const ok = { read: true, returned: true, delivered: true };
		const score = (reply) =>
			scoreAttempt({
				answer: parse(reply),
				childRoles: ["bench-build", "bench-review", "bench-fix"],
				parentTools: ["subagent", "subagent", "subagent"],
				childOutcomes: [ok, ok, ok],
				workspace: { heldOutPassed: true, changedTestFiles: [] },
				handoffInOrder: true,
				scenario,
			});
		assert.equal(
			score("TESTS: pass\nFINDING: R-1, R-2\nFIXED: R-1, R-2"),
			"wrong-answer",
		);
		assert.equal(score("TESTS: pass\nFINDING: R-2\nFIXED: R-2"), "pass");
	});
});

describe("review-fix test file checksums", () => {
	test("untouched test files are not reported", () => {
		assert.deepEqual(inspectWorkspace(workspace(BUILD, FIX)), {
			heldOutPassed: true,
			changedTestFiles: [],
		});
	});

	test("an edited or a deleted test file is reported", () => {
		const edited = workspace(BUILD);
		writeFileSync(
			join(edited, "test", "cart.test.mjs"),
			'import { test } from "node:test";\ntest("nothing", () => {});\n',
		);
		assert.deepEqual(changedTestFiles(edited), ["test/cart.test.mjs"]);
		const deleted = workspace(BUILD);
		rmSync(join(deleted, "test", "cart.test.mjs"));
		assert.deepEqual(changedTestFiles(deleted), ["test/cart.test.mjs"]);
	});
});

describe("review-fix review contract", () => {
	const review = scenario.childResults["bench-review"];
	test("the review counts only when it reports the planted finding", () => {
		assert.equal(
			holdsResult(
				"FINDING: R-2\nDETAIL: lineTotal: quantity is not checked",
				review,
			),
			true,
		);
		assert.equal(holdsResult("FINDING: none", review), false);
		assert.equal(holdsResult("FINDING: R-1\nDETAIL: x", review), false);
		assert.equal(holdsResult("The code looks fine. R-2", review), false);
	});
});

describe("review-fix verdicts", () => {
	const ok = { read: true, returned: true, delivered: true };
	const good = {
		answer: { TESTS: "pass", FINDING: "R-2", FIXED: "R-2" },
		childRoles: ["bench-build", "bench-review", "bench-fix"],
		parentTools: ["subagent", "subagent", "subagent"],
		childOutcomes: [ok, ok, ok],
		workspace: { heldOutPassed: true, changedTestFiles: [] },
		handoffInOrder: true,
		scenario,
	};
	const score = (change) => scoreAttempt({ ...good, ...change });

	test("build, review and fix with a passing held-out test pass", () => {
		assert.equal(score({}), "pass");
	});

	test("a parent that skips the review fails", () => {
		assert.equal(
			score({
				childRoles: ["bench-build", "bench-fix"],
				childOutcomes: [ok, ok],
			}),
			"wrong-delegation",
		);
		assert.equal(
			score({ childRoles: ["bench-build"], childOutcomes: [ok] }),
			"wrong-delegation",
		);
	});

	test("a review after the fix round fails", () => {
		assert.equal(
			score({ childRoles: ["bench-build", "bench-fix", "bench-review"] }),
			"wrong-delegation",
		);
	});

	test("a review that misses the planted finding fails", () => {
		assert.equal(
			score({ childOutcomes: [ok, { ...ok, returned: false }, ok] }),
			"wrong-delegation",
		);
		assert.equal(
			score({ answer: { TESTS: "pass", FINDING: "none", FIXED: "R-2" } }),
			"wrong-answer",
		);
	});

	test("a parent that does the work itself fails", () => {
		assert.equal(
			score({ parentTools: ["subagent", "edit", "subagent", "subagent"] }),
			"wrong-delegation",
		);
	});

	test("a failing held-out test fails", () => {
		assert.equal(
			score({ workspace: { heldOutPassed: false, changedTestFiles: [] } }),
			"wrong-answer",
		);
	});

	test("a changed fixture test file fails", () => {
		assert.equal(
			score({
				workspace: {
					heldOutPassed: true,
					changedTestFiles: ["test/cart.test.mjs"],
				},
			}),
			"wrong-answer",
		);
	});

	test("a launch before the previous result arrived fails", () => {
		assert.equal(score({ handoffInOrder: false }), "wrong-delegation");
		assert.equal(score({ handoffInOrder: null }), "wrong-delegation");
	});

	test("a child that missed its phase gate fails", () => {
		assert.equal(
			score({ childOutcomes: [{ ...ok, phase: false }, ok, ok] }),
			"wrong-delegation",
		);
	});

	test("a missing oracle result fails", () => {
		assert.equal(score({ workspace: null }), "wrong-answer");
	});
});

// T68: both releases refuse one-word launch names (the subagent tool's name takes
// 2-4 lower-kebab words); a refused first launch cost every parent a request.
test("[T68] the prompt gives each child a 2-word lower-kebab launch name", () => {
	const names = [...scenario.prompt.matchAll(/name "([^"]*)"/g)].map((m) => m[1]);
	assert.deepEqual(names, ["cart-build", "cart-review", "cart-fix"]);
});
