/**
 * Scenario (c) review-fix: whole session histories replayed through the scorer
 * (classifyAttempt), with the same final workspace facts in every history.
 * Expected outcomes come from G2.1 (c) and the owner rule of 2026-11-18T17:16Z:
 * correctness is the keyed answer, the child order, a review before the fix, the
 * held-out test and unchanged test checksums; no child needs a read-tool call.
 * The build must make the visible test pass and leave R-2 open; the fix round
 * must fix R-2; each next child launches only after the previous result arrived.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifyAttempt } from "./attempt.mjs";
import scenario from "./scenarios/review-fix/scenario.mjs";

const WORK = "/r/work";
const CLI = { checkout: "/c", model: "p/m", thinking: "high" };
const usage = {
	input: 1,
	cacheRead: 0,
	cacheWrite: 0,
	output: 1,
	cost: { total: 0.001 },
};
const ANSWER = { TESTS: "pass", FINDING: "R-2", FIXED: "R-2" };
const FINAL = { heldOutPassed: true, changedTestFiles: [] };
const ROLE = { build: "bench-build", review: "bench-review", fix: "bench-fix" };
// Launch names as the scenario prompt gives them (lower-kebab, 2 words).
const LAUNCH_NAME = { build: "cart-build", review: "cart-review", fix: "cart-fix" };
const runId = (name) => `run-${name}`;
const file = (name) => `/r/${name}.jsonl`;

const assistant = (stopReason, text, calls = []) => ({
	type: "message",
	message: {
		role: "assistant",
		stopReason,
		usage,
		content: [{ type: "text", text }, ...calls],
	},
});
// One launch call of the parent: its tool call and the started tool result.
const launch = (callId, names) => [
	assistant("toolUse", "", [
		{ type: "toolCall", id: callId, name: "subagent", arguments: {} },
	]),
	{
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName: "subagent",
			isError: false,
			content: [{ type: "text", text: "started" }],
			details: {
				status: "started",
				children: names.map((name) => ({
					id: runId(name),
					name: LAUNCH_NAME[name],
					status: "started",
				})),
			},
		},
	},
];
const result = (name, text) => ({
	type: "custom_message",
	customType: "subagent_result",
	content: text,
	details: { id: runId(name) },
});
const finalReply = assistant(
	"stop",
	Object.entries(ANSWER)
		.map(([key, value]) => `${key}: ${value}`)
		.join("\n"),
);

const childSession = (name, order, text, tools = []) => ({
	file: file(name),
	events: [
		{ type: "session", cwd: WORK },
		{
			type: "custom",
			customType: "pi-subagents_launch_metadata",
			id: `m${order}`,
			timestamp: `2026-11-18T17:00:0${order}.000Z`,
			data: { agent: ROLE[name], name: LAUNCH_NAME[name] },
		},
		...tools,
		assistant("stop", text),
	],
});
const bashEdit = [
	assistant("toolUse", "", [
		{
			type: "toolCall",
			id: "b1",
			name: "bash",
			arguments: { command: "sed -i '' ... src/cart.mjs" },
		},
	]),
	{
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "b1",
			toolName: "bash",
			isError: false,
			content: [],
		},
	},
];
// A native read of the source: the handoff and phase histories include it, so the
// read rule that 35c9ce8 had cannot be what fails them.
const nativeRead = [
	assistant("toolUse", "", [
		{
			type: "toolCall",
			id: "r1",
			name: "read",
			arguments: { path: "src/cart.mjs" },
		},
	]),
	{
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "r1",
			toolName: "read",
			isError: false,
			content: [],
		},
	},
];
const REPORTS = {
	build: "TESTS: pass",
	review: "FINDING: R-2\nDETAIL: lineTotal: quantity is not checked",
	fix: "FIXED: R-2",
};

/** A history: the parent's events, the child reports and the per-child phase facts. */
function history({ parent, reports = REPORTS, phases, read = true }) {
	const names = ["build", "review", "fix"];
	const children = names.map((name, i) =>
		childSession(name, i + 1, reports[name], [
			...(read ? nativeRead : []),
			...(name === "review" ? [] : bashEdit),
		]),
	);
	const probe = (sessionFile, agent) => ({
		sessionFile,
		agent,
		model: CLI.model,
		thinking: CLI.thinking,
		tools: [
			{ name: agent ? "caller_ping" : "subagent", path: "/c/src/index.ts" },
		],
	});
	return classifyAttempt({
		observed: {
			kind: "answered",
			answer: ANSWER,
			answeredAt: parent.length - 1,
		},
		evidence: {
			parent: { file: "/r/p.jsonl", events: parent },
			children,
			unattributed: [],
			others: [],
			parentProbes: 1,
			probes: [
				probe("/r/p.jsonl", null),
				...names.map((n) => probe(file(n), ROLE[n])),
			],
			malformed: 0,
		},
		cli: CLI,
		scenario,
		checkoutChanged: false,
		workDir: WORK,
		workspace: FINAL,
		phases: phases ?? {
			[file("build")]: { visibleTestPassed: true, findingFixed: false },
			[file("review")]: { visibleTestPassed: true, findingFixed: false },
			[file("fix")]: { visibleTestPassed: true, findingFixed: true },
		},
	});
}

const serial = (reports = REPORTS) => [
	...launch("c1", ["build"]),
	result("build", reports.build),
	...launch("c2", ["review"]),
	result("review", reports.review),
	...launch("c3", ["fix"]),
	result("fix", reports.fix),
	finalReply,
];

describe("review-fix: no read-tool rule (owner rule 2026-11-18T17:16Z)", () => {
	test("a correct build and fix that use bash, not read, pass with three clean yields", () => {
		const attempt = history({ parent: serial(), read: false });
		assert.equal(attempt.verdict, "pass");
		assert.equal(attempt.delivery.outcomeClasses.clean_yield, 3);
		assert.equal(attempt.delivery.outcomeClasses.auxiliary, 0);
	});
});

describe("review-fix: handoff order", () => {
	test("build and review launched in one batch fail, though all results arrive", () => {
		const parent = [
			...launch("c1", ["build", "review"]),
			result("build", REPORTS.build),
			result("review", REPORTS.review),
			...launch("c2", ["fix"]),
			result("fix", REPORTS.fix),
			finalReply,
		];
		assert.equal(history({ parent }).verdict, "wrong-delegation");
	});

	test("a fix launched before the review result arrived fails", () => {
		const parent = [
			...launch("c1", ["build"]),
			result("build", REPORTS.build),
			...launch("c2", ["review"]),
			...launch("c3", ["fix"]),
			result("review", REPORTS.review),
			result("fix", REPORTS.fix),
			finalReply,
		];
		assert.equal(history({ parent }).verdict, "wrong-delegation");
	});
});

describe("review-fix: phase ownership (same final workspace in every case)", () => {
	const phases = (build, fix) => ({
		[file("build")]: build,
		[file("fix")]: fix,
	});
	const fixed = { visibleTestPassed: true, findingFixed: true };

	test("a build that left the visible test failing fails, even when the fix repaired it", () => {
		// The reviewer's attack: review reports R-1 and R-2, fix claims both.
		const reports = {
			build: "TESTS: pass",
			review:
				"FINDING: R-1\nDETAIL: applyDiscount\nFINDING: R-2\nDETAIL: lineTotal",
			fix: "FIXED: R-1\nFIXED: R-2",
		};
		const attempt = history({
			parent: serial(reports),
			reports,
			phases: phases({ visibleTestPassed: false, findingFixed: false }, fixed),
		});
		assert.equal(attempt.verdict, "wrong-delegation");
	});

	test("a build that also fixed R-2 fails: the fix round did not fix it", () => {
		const attempt = history({ parent: serial(), phases: phases(fixed, fixed) });
		assert.equal(attempt.verdict, "wrong-delegation");
	});

	test("a child without phase facts fails", () => {
		const attempt = history({ parent: serial(), phases: {} });
		assert.equal(attempt.verdict, "wrong-delegation");
	});

	test("a review that also reports R-1 after a correct build earns no credit for R-1 and still passes on R-2", () => {
		const reports = {
			...REPORTS,
			review:
				"FINDING: R-2\nDETAIL: lineTotal\nFINDING: R-1\nDETAIL: applyDiscount",
		};
		assert.equal(history({ parent: serial(reports), reports }).verdict, "pass");
	});
});
