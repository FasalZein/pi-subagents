// Scenario (c) of G2.1: build, review, one fix round, judged by a held-out test.
// The build child makes the failing fixture test pass. The review child checks the
// code against a checklist that only its agent file holds (outside the workspace);
// after a correct build the code breaks exactly one rule, R-2, the planted finding
// (R-1 covers only positive integer quantities; review-fix.test.mjs checks this).
// The fix child gets the review report from the parent and fixes R-2.
// After the parent ends, the oracle (oracle.mjs) runs the held-out test, which no
// child can see, and compares the checksums of the fixture's test files.
// A build alone leaves R-2 open, so the held-out test fails without a review.
// Owner rule 2026-11-18T17:16Z: no read-tool rule for any child. The result, the
// child order, the handoff order and the phase facts decide instead.
import { inspectPhase, inspectWorkspace } from "./oracle.mjs";

const facts = { TESTS: "pass", FINDING: "R-2", FIXED: "R-2" };
const contract = (key, anyLine = false) => ({
	returns: [facts[key]],
	// Keyed: the value counts only on its own KEY line.
	facts: { [key]: facts[key] },
	reads: [],
	// A report of several findings counts when one of its KEY lines holds the value.
	anyLine,
});

export default {
	name: "review-fix",
	prompt:
		'Run three children one after another with the subagent tool, and launch each one only after the result of the one before it has arrived. First: name "build", agent "bench-build", task "The test test/cart.test.mjs fails. Make it pass.". Second: name "review", agent "bench-review", task "Review src/cart.mjs.". Third: name "fix", agent "bench-fix", and as its task the full report of the review child, copied verbatim. Do not read, edit or run anything yourself. When the result of the fix child has arrived, reply with exactly three lines: TESTS: <value the build child reported>, FINDING: <rule id the review child reported>, FIXED: <rule id the fix child reported>',
	expectedFacts: facts,
	// Fixed launch order: a build or a fix without the review before it fails.
	expectedChildRoles: ["bench-build", "bench-review", "bench-fix"],
	childResults: {
		"bench-build": contract("TESTS"),
		"bench-review": contract("FINDING", true),
		"bench-fix": contract("FIXED", true),
	},
	// Each next launch only after the previous result reached the parent.
	serialHandoff: true,
	// Phase facts when each child ends (oracle.mjs inspectPhase): the build makes
	// the visible test pass and leaves R-2 open; the fix round fixes R-2.
	// The review can only read, so it has no gate.
	inspectPhase,
	phaseGates: {
		"bench-build": { visibleTestPassed: true, findingFixed: false },
		"bench-fix": { visibleTestPassed: true, findingFixed: true },
	},
	parentToolAllowlist: ["subagent"],
	parentLoadTool: "subagent",
	childLoadTool: "caller_ping",
	digestOperations: [],
	// Runs after the parent ends; scoreAttempt fails the sample on its facts.
	inspectWorkspace,
};
