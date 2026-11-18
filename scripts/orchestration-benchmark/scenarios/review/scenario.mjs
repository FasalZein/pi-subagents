// Scenario (b) of G2.1: 8 read-only review children launched directly (v2.9.2 has
// no workflow script). Each child reads one review target and returns the verdict
// planted in it. The oracle compares the parent's final reply keyed by target name,
// so a reply with 8 lines under other target names fails.
// Launch names are unique (launcher limit "Namesakes").
const verdicts = {
	billing: "reject-5530",
	auth: "approve-4417",
	cache: "approve-2864",
	parser: "reject-7192",
	router: "approve-9305",
	scheduler: "reject-3648",
	storage: "approve-6071",
	telemetry: "reject-1286",
};

const childResults = Object.fromEntries(
	Object.entries(verdicts).map(([target, verdict]) => [
		`bench-review-${target}`,
		{
			returns: [verdict],
			// Keyed: a verdict counts only under its own target.
			facts: { [target]: verdict },
			reads: [`review/${target}.md`],
		},
	]),
);

export default {
	name: "review",
	prompt:
		'Call the subagent tool once with a children list of eight entries: name "review-billing", agent "bench-review-billing", task "Read review/billing.md and report its verdict line."; name "review-auth", agent "bench-review-auth", task "Read review/auth.md and report its verdict line."; name "review-cache", agent "bench-review-cache", task "Read review/cache.md and report its verdict line."; name "review-parser", agent "bench-review-parser", task "Read review/parser.md and report its verdict line."; name "review-router", agent "bench-review-router", task "Read review/router.md and report its verdict line."; name "review-scheduler", agent "bench-review-scheduler", task "Read review/scheduler.md and report its verdict line."; name "review-storage", agent "bench-review-storage", task "Read review/storage.md and report its verdict line."; name "review-telemetry", agent "bench-review-telemetry", task "Read review/telemetry.md and report its verdict line.". Do not read any file yourself. Wait until all eight results have arrived. Then reply with exactly eight lines, one per target in the order billing, auth, cache, parser, router, scheduler, storage, telemetry, each as <target>: <verdict>',
	expectedFacts: verdicts,
	expectedChildRoles: Object.keys(childResults),
	// One batch launch: the eight children have no fixed launch order.
	childOrder: "any",
	childResults,
	parentToolAllowlist: ["subagent"],
	parentLoadTool: "subagent",
	childLoadTool: "caller_ping",
	// v2.9.2 has no digest-producing operation: every verdict must arrive by its own run id.
	digestOperations: [],
};
