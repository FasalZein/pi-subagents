// Scenario (b) of G2.1, candidate arm: the same 8 review targets, children and keyed
// verdicts as scenarios/review, but the parent writes ONE workflow script (codemode)
// that launches the 8 children and returns; their results arrive as messages and the parent
// writes the digest (owner 2026-11-24: no wait tool). The baseline folder stays
// unchanged, so its fixture hash stays equal to T04's (T04 finding 1).
import review from "../review/scenario.mjs";

// Launch names: delivery.mjs joins children by launch name.
const launches = Object.keys(review.expectedFacts).map(
	(target) => `review-${target}`,
);

export default {
	...review,
	name: "review-workflow",
	prompt:
		'Call the codemode tool exactly once. Its script calls tools.subagent once with a children list of eight entries: name "review-billing", agent "bench-review-billing", task "Read review/billing.md and report its verdict line."; name "review-auth", agent "bench-review-auth", task "Read review/auth.md and report its verdict line."; name "review-cache", agent "bench-review-cache", task "Read review/cache.md and report its verdict line."; name "review-parser", agent "bench-review-parser", task "Read review/parser.md and report its verdict line."; name "review-router", agent "bench-review-router", task "Read review/router.md and report its verdict line."; name "review-scheduler", agent "bench-review-scheduler", task "Read review/scheduler.md and report its verdict line."; name "review-storage", agent "bench-review-storage", task "Read review/storage.md and report its verdict line."; name "review-telemetry", agent "bench-review-telemetry", task "Read review/telemetry.md and report its verdict line.". The launch result has a children list; each entry has runId, state and reportFolder. Then the script returns the run id and the reportFolder of each of the eight children; it does not wait for the children. Do not call any other tool, and do not read any file yourself, inside or outside the script. After the script has returned, end your turn: the result of each child arrives later as its own message. When all eight results have arrived, reply with exactly eight lines, one per target in the order billing, auth, cache, parser, router, scheduler, storage, telemetry, each as <target>: <verdict>',
	// The parent loads Pi's built-in codemode tool (launcher: --tools +codemode).
	parentTools: "+codemode",
	// subagent runs inside the script, as a nested call of codemode.
	parentToolAllowlist: ["codemode", "subagent"],
	// The gate (candidate-evidence.mjs workflowScript): one successful codemode
	// script launches a run of every launch name, each run's result message reaches
	// the parent, no direct launch and no wait tool call.
	workflow: { toolName: "codemode", launches },
	// The script returns run ids, no results: every verdict arrives by its own run id.
	digestOperations: [],
};
