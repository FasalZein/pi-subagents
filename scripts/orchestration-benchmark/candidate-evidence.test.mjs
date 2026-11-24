// Run: node --test scripts/orchestration-benchmark/candidate-evidence.test.mjs
// Candidate evidence (T59a): release capabilities, the parent allowlist with report
// locator reads, run folders, the kept attempt copy, the workflow scenario and the
// candidate gate plan. No model, no Pi.
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyAttempt, keepEvidence } from "./attempt.mjs";
import { samplePlan } from "./baseline-plan.mjs";
import {
	forRelease,
	parentToolNames,
	releaseCapabilities,
} from "./candidate-evidence.mjs";
import { answerParser, scoreAttempt, terminalAnswer } from "./record.mjs";
import recon from "./scenarios/recon/scenario.mjs";
import review from "./scenarios/review/scenario.mjs";
import reviewWorkflow from "./scenarios/review-workflow/scenario.mjs";
import { readBlockedSessions, readRunFolders } from "./session-evidence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = "/r/workspace";
const usage = { input: 10, cacheRead: 0, cacheWrite: 0, output: 1, cost: { total: 0.01 } };
const assistant = (stopReason, text, calls = []) => ({
	type: "message",
	message: { role: "assistant", stopReason, usage, content: [{ type: "text", text }, ...calls] },
});
const call = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const toolResult = (id, toolName, text, extra = {}) => ({
	type: "message",
	message: { role: "toolResult", toolCallId: id, toolName, isError: false, content: [{ type: "text", text }], ...extra },
});

test("[T59a P1-2] the wait tool is allowed only on a release that has it; a refused wait on v2.9.2 still fails", () => {
	assert.deepEqual(forRelease(recon, { candidate: false }).parentToolAllowlist, ["subagent"]);
	assert.deepEqual(forRelease(recon, { candidate: true, waitTool: true }).parentToolAllowlist, ["subagent", "subagent_wait"]);
	// Owner 2026-11-24: a candidate without the wait tool keeps the allowlist as written.
	assert.deepEqual(forRelease(recon, { candidate: true, waitTool: false }).parentToolAllowlist, ["subagent"]);
	const listed = { parentToolAllowlist: ["codemode", "subagent", "subagent_wait"], parentLoadTool: "subagent" };
	assert.deepEqual(forRelease(listed, { candidate: true, waitTool: true }).parentToolAllowlist, listed.parentToolAllowlist);
	// A v2.9.2-shaped transcript: after one result the model asks for the unregistered
	// subagent_wait, gets a tool error, then answers right. T04 (40e6162) scores
	// wrong-delegation from the recorded call name; so does this harness on v2.9.2.
	const events = [
		assistant("toolUse", "", [call("w1", "subagent_wait", { ids: ["r1"] })]),
		{ ...toolResult("w1", "subagent_wait", "Tool subagent_wait not found"), message: { ...toolResult("w1", "subagent_wait", "x").message, isError: true } },
		assistant("stop", "FACT-1: cobalt-3318"),
	];
	const score = (release) =>
		scoreAttempt({
			answer: recon.expectedFacts,
			childRoles: recon.expectedChildRoles,
			parentTools: parentToolNames(events),
			childOutcomes: [],
			scenario: forRelease(recon, release),
		});
	assert.equal(score({ candidate: false }), "wrong-delegation");
	assert.equal(score({ candidate: true, waitTool: true }), "pass");
});

test("[T59a P1-2] release capabilities: the candidate declares subagent_agents and, since 2026-11-24, no subagent_wait", () => {
	const repo = join(HERE, "..", "..");
	assert.deepEqual(releaseCapabilities(repo), { candidate: true, waitTool: false });
	const old = mkdtempSync(join(tmpdir(), "bench-release-"));
	try {
		mkdirSync(join(old, "src", "tools"), { recursive: true });
		writeFileSync(join(old, "src", "tools", "tool-names.ts"), 'export const X = "subagent_done";\n');
		assert.deepEqual(releaseCapabilities(old), { candidate: false, waitTool: false });
		assert.deepEqual(releaseCapabilities(join(old, "missing")), { candidate: false, waitTool: false });
		writeFileSync(join(old, "src", "tools", "tool-names.ts"), 'const A = "subagent_agents";\nconst W = "subagent_wait";\n');
		assert.deepEqual(releaseCapabilities(old), { candidate: true, waitTool: true }, "a candidate checkout before 2026-11-24");
	} finally {
		rmSync(old, { recursive: true, force: true });
	}
});

test("[T59a P1-4] a successful read of a run's report locator is no parent tool; other reads are", () => {
	const folders = [{ runId: "ab12cd34", name: "review-auth", report: "/r/artifacts/s/results/ab12cd34/report-1.md" }];
	const read = (path, isError = false) => [
		assistant("toolUse", "", [call("r1", "read", { path })]),
		{ ...toolResult("r1", "read", "x"), message: { ...toolResult("r1", "read", "x").message, isError } },
	];
	assert.deepEqual(parentToolNames(read("../artifacts/s/results/ab12cd34/report-1.md"), folders, WORK), []);
	assert.deepEqual(parentToolNames(read("../artifacts/s/results/ab12cd34/report-1.md", true), folders, WORK), ["read"]);
	assert.deepEqual(parentToolNames(read("review/auth.md"), folders, WORK), ["read"]);
	// v2.9.2 has no run folders: every read stays a parent tool.
	assert.deepEqual(parentToolNames(read("../artifacts/s/results/ab12cd34/report-1.md"), [], WORK), ["read"]);
	// Calls nested in a script count; a nested locator read with status ok does not.
	const nested = [
		assistant("toolUse", "", [call("c1", "codemode")]),
		toolResult("c1", "codemode", "done", {
			nestedCalls: {
				calls: [
					{ id: "c1/1", name: "subagent", status: "ok", arguments: {} },
					{ id: "c1/2", name: "read", status: "ok", arguments: { path: "/r/artifacts/s/results/ab12cd34/report-1.md" } },
					{ id: "c1/3", name: "read", status: "error", arguments: { path: "review/auth.md" } },
				],
				complete: true,
			},
		}),
	];
	assert.deepEqual(parentToolNames(nested, folders, WORK), ["codemode", "subagent", "read"]);
});

// Minimal attempt evidence, shaped as launcher.test.mjs builds it.
const probes = [
	{ sessionFile: "/r/p.jsonl", agent: null, model: "p/m", thinking: "high", tools: [{ name: "subagent", path: "/c/src/index.ts" }] },
	{ sessionFile: "/r/c.jsonl", agent: "reader", model: "p/m", thinking: "high", tools: [{ name: "subagent_done", path: "/c/src/d.ts" }] },
];
const SCENARIO = {
	expectedAnswer: "lantern-9",
	expectedChildRoles: ["reader"],
	childResults: { reader: { returns: "lantern-9", reads: ["note.txt"] } },
	parentToolAllowlist: ["subagent"],
	parentLoadTool: "subagent",
	childLoadTool: "subagent_done",
};
const child = {
	file: "/r/c.jsonl",
	events: [
		{ type: "session", cwd: "/r/work" },
		{ type: "custom", customType: "pi-subagents_launch_metadata", data: { agent: "reader", name: "reader-1" } },
		assistant("toolUse", "", [call("t1", "read", { path: "note.txt" })]),
		toolResult("t1", "read", "x"),
		assistant("stop", "lantern-9"),
	],
};
const twiceLaunched = [
	assistant("toolUse", "", [call("l1", "subagent")]),
	toolResult("l1", "subagent", "started", { details: { status: "started", children: [{ id: "run-1", name: "reader-1" }] } }),
	{ type: "custom_message", customType: "subagent_result", content: "lantern-9", details: { id: "run-1" } },
	assistant("toolUse", "", [call("l2", "subagent")]),
	toolResult("l2", "subagent", "started", { details: { status: "started", children: [{ id: "run-2", name: "reader-1" }] } }),
	assistant("stop", "ANSWER: lantern-9"),
];

test("[T59a P1-7] a repeated launch is a counted wrong-delegation on the candidate and stays infra on v2.9.2", () => {
	const classify = (release) =>
		classifyAttempt({
			observed: { kind: "answered", answer: "lantern-9", answeredAt: twiceLaunched.length - 1 },
			evidence: {
				parent: { file: "/r/p.jsonl", events: twiceLaunched },
				children: [child],
				unattributed: [],
				others: [],
				parentProbes: 1,
				probes,
				malformed: 0,
			},
			cli: { checkout: "/c", model: "p/m", thinking: "high" },
			scenario: forRelease(SCENARIO, release),
			checkoutChanged: false,
			workDir: "/r/work",
		});
	assert.deepEqual([classify({ candidate: false }).kind, classify({ candidate: false }).infraReason], ["infra", "two launched children share a launch name"]);
	assert.deepEqual([classify({ candidate: true }).kind, classify({ candidate: true }).verdict], ["verdict", "wrong-delegation"]);
});

test("[T59a] run folders bind run ids to launch names and report paths: record.json first, else the session launch.json names", () => {
	const root = mkdtempSync(join(tmpdir(), "bench-runs-"));
	try {
		const results = join(root, "artifacts", "p", "artifacts", "s1", "results");
		const ended = join(results, "9d20d77f");
		const running = join(results, "a0cc61e8");
		mkdirSync(ended, { recursive: true });
		mkdirSync(running, { recursive: true });
		const childFile = join(root, "sessions", "child.jsonl");
		writeFileSync(join(ended, "launch.json"), JSON.stringify({ sessionFile: join(root, "sessions", "other.jsonl") }));
		writeFileSync(
			join(ended, "record.json"),
			JSON.stringify({ runId: "9d20d77f", name: "review-auth", report: { saved: true, path: join(ended, "report-1.md") } }),
		);
		writeFileSync(join(running, "launch.json"), JSON.stringify({ sessionFile: childFile }));
		const sessions = [
			{ file: childFile, events: [{ type: "custom", customType: "pi-subagents_launch_metadata", data: { name: "review-cache" } }] },
		];
		assert.deepEqual(readRunFolders(root, sessions), [
			{ runId: "9d20d77f", name: "review-auth", report: join(ended, "report-1.md") },
			{ runId: "a0cc61e8", name: "review-cache", report: null },
		]);
		assert.deepEqual(readRunFolders(join(root, "sessions"), sessions), []);
		// T72 review P1: a blocked record names its session as a ping end; a done record does not.
		assert.deepEqual([...readBlockedSessions(root, sessions)], []);
		writeFileSync(join(running, "record.json"), JSON.stringify({ runId: "a0cc61e8", name: "review-cache", outcome: "blocked" }));
		assert.deepEqual([...readBlockedSessions(root, sessions)], [childFile]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("[T59a] a kept attempt copy holds known session and run evidence paths only, no symbolic link", () => {
	const root = mkdtempSync(join(tmpdir(), "bench-keep-"));
	try {
		const files = {
			"sessions/p.jsonl": "{}",
			"artifacts/x/s/results/ab12cd34/record.json": "{}",
			"artifacts/x/s/results/ab12cd34/launch.json": "{}",
			"artifacts/x/s/results/ab12cd34/report-1.md": "report",
			"artifacts/x/s/record.json": "{}",
			"home/.pi/agent/auth.json": "secret",
			"home/.pi/agent/sessions/h.jsonl": "{}",
			"home/.pi/agent/settings.json": "{}",
			"workspace/review/auth.md": "x",
			"workspace/s.jsonl": "{}",
		};
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(join(root, "src", path, ".."), { recursive: true });
			writeFileSync(join(root, "src", path), text);
		}
		symlinkSync(join(root, "src", "home"), join(root, "src", "sessions", "linked"));
		symlinkSync(join(root, "src", "home/.pi/agent/auth.json"), join(root, "src", "sessions", "auth.jsonl"));
		keepEvidence(join(root, "src"), join(root, "kept"));
		const kept = Object.keys(files).filter((path) => existsSync(join(root, "kept", path)));
		assert.deepEqual(kept, ["sessions/p.jsonl", "artifacts/x/s/results/ab12cd34/record.json", "artifacts/x/s/results/ab12cd34/launch.json"]);
		assert.deepEqual(readdirSync(join(root, "kept", "sessions")), ["p.jsonl"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("[T59a] the workflow arm keeps the 8 targets, children and verdicts of scenario (b), with codemode, a workflow and no wait tool", () => {
	assert.deepEqual(reviewWorkflow.expectedFacts, review.expectedFacts);
	assert.deepEqual(reviewWorkflow.childResults, review.childResults);
	assert.equal(reviewWorkflow.parentTools, "+codemode");
	assert.equal(review.parentTools, undefined);
	const launchNames = [...reviewWorkflow.prompt.matchAll(/name "([^"]+)"/g)].map((m) => m[1]);
	assert.equal(launchNames.length, 8);
	assert.deepEqual(reviewWorkflow.workflow, { toolName: "codemode", launches: launchNames });
	assert.deepEqual(reviewWorkflow.digestOperations, []);
	assert.deepEqual(reviewWorkflow.parentToolAllowlist, ["codemode", "subagent"]);
	assert.doesNotMatch(reviewWorkflow.prompt, /subagent_wait/);
	for (const sub of ["agents", "workspace/review"])
		for (const name of readdirSync(join(HERE, "scenarios", "review", sub)))
			assert.equal(
				readFileSync(join(HERE, "scenarios", "review-workflow", sub, name), "utf8"),
				readFileSync(join(HERE, "scenarios", "review", sub, name), "utf8"),
			);
	const reply = [{ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: Object.entries(review.expectedFacts).map(([k, v]) => k + ": " + v).join("\n") }] } }];
	assert.deepEqual(terminalAnswer(reply, answerParser(reviewWorkflow)).answer, review.expectedFacts);
});

test("[T59a] the candidate gate plans 18 samples with the workflow arm of scenario (b)", () => {
	const models = [{ label: "model 1", ref: "prov/a" }, { label: "model 2", ref: "prov/b" }];
	const plan = samplePlan(models, ["recon", "review-workflow", "review-fix"]);
	assert.equal(plan.length, 18);
	assert.deepEqual([...new Set(plan.map((s) => s.scenario))], ["recon", "review-workflow", "review-fix"]);
	assert.equal(samplePlan(models).some((s) => s.scenario === "review-workflow"), false);
});
