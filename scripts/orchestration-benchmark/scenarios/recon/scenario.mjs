// Scenario (a) of G2.1: 6 read-only recon children launched directly.
// Each child reads one planted fact from the shared workspace. The 7th fact is in
// child 4's private instructions (its agent file, outside the workspace), so no
// sibling can read it and it reaches the parent only through child 4's own report.
// The oracle compares the parent's final reply by key.
// archive/area-3.md is a decoy with a stale value: a read counts by fixture path only.
const facts = {
	"FACT-1": "cobalt-3318",
	"FACT-2": "meadow-5021",
	"FACT-3": "quartz-7764",
	"FACT-4": "harbor-1409",
	"FACT-5": "juniper-8836",
	"FACT-6": "signal-2257",
	"FACT-7": "ember-6093",
};

const childResults = {};
for (let i = 1; i <= 6; i++) {
	const keys = i === 4 ? ["FACT-4", "FACT-7"] : [`FACT-${i}`];
	childResults[`bench-recon-${i}`] = {
		returns: keys.map((key) => facts[key]),
		// Keyed: a child's value counts only under its own key.
		facts: Object.fromEntries(keys.map((key) => [key, facts[key]])),
		reads: [`recon/area-${i}.md`],
	};
}

export default {
	name: "recon",
	prompt:
		'Call the subagent tool once with a children list of six entries: name "recon-1", agent "bench-recon-1", task "Read recon/area-1.md and report every FACT line."; name "recon-2", agent "bench-recon-2", task "Read recon/area-2.md and report every FACT line."; name "recon-3", agent "bench-recon-3", task "Read recon/area-3.md and report every FACT line."; name "recon-4", agent "bench-recon-4", task "Read recon/area-4.md and report every FACT line."; name "recon-5", agent "bench-recon-5", task "Read recon/area-5.md and report every FACT line."; name "recon-6", agent "bench-recon-6", task "Read recon/area-6.md and report every FACT line.". Do not read any file yourself. Wait until all six results have arrived. One report holds an extra fact. Then reply with exactly seven lines, FACT-1 to FACT-7 in order, each as FACT-<n>: <value>',
	expectedFacts: facts,
	expectedChildRoles: Object.keys(childResults),
	// One batch launch: the six children have no fixed launch order.
	childOrder: "any",
	childResults,
	parentToolAllowlist: ["subagent"],
	parentLoadTool: "subagent",
	childLoadTool: "caller_ping",
	// No digest-producing operation: every result must arrive by its own run id.
	digestOperations: [],
};
