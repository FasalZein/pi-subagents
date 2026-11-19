// Scenario (b) of G2.1, candidate arm: the same 8 review targets, children and keyed
// verdicts as scenarios/review, but the parent writes ONE workflow script (codemode)
// that launches the 8 children, waits and returns a digest. The baseline folder stays
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
		'Call the codemode tool exactly once. Its script calls tools.subagent once with a children list of eight entries: name "review-billing", agent "bench-review-billing", task "Read review/billing.md and report its verdict line."; name "review-auth", agent "bench-review-auth", task "Read review/auth.md and report its verdict line."; name "review-cache", agent "bench-review-cache", task "Read review/cache.md and report its verdict line."; name "review-parser", agent "bench-review-parser", task "Read review/parser.md and report its verdict line."; name "review-router", agent "bench-review-router", task "Read review/router.md and report its verdict line."; name "review-scheduler", agent "bench-review-scheduler", task "Read review/scheduler.md and report its verdict line."; name "review-storage", agent "bench-review-storage", task "Read review/storage.md and report its verdict line."; name "review-telemetry", agent "bench-review-telemetry", task "Read review/telemetry.md and report its verdict line.". The launch result has a children list; each entry has runId and state. Then the script calls tools.subagent_wait once with ids set to all eight run ids and returns a digest: one line per target, <target>: <verdict>, taken from each result. Do not read any file yourself, inside or outside the script. When the script has returned, reply with exactly eight lines, one per target in the order billing, auth, cache, parser, router, scheduler, storage, telemetry, each as <target>: <verdict>',
	// The parent loads Pi's built-in codemode tool (launcher: --tools +codemode).
	parentTools: "+codemode",
	// subagent and subagent_wait run inside the script, as nested calls of codemode.
	parentToolAllowlist: ["codemode", "subagent", "subagent_wait"],
	// The gate (candidate-evidence.mjs workflowScript): one successful codemode
	// script launches and joins a run of every launch name; no direct launch.
	workflow: { toolName: "codemode", launches },
	// The script's result is a deliberate digest; it counts for a run only when
	// that script joined the run.
	digestOperations: [{ toolName: "codemode", covers: launches }],
};
