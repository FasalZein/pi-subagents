// Run: node --test scripts/orchestration-benchmark/candidate-scoring.test.mjs
// Scoring of candidate-shaped sessions (T59a): only delivery.mjs, record.mjs and the
// scenarios, so each test also runs against an older harness as a failing-first check.
// Shapes come from real candidate sessions (T54 run-m1, T57 run-a-m1, the T59a smokes).
import assert from "node:assert/strict";
import { test } from "node:test";
import { scriptCoverage } from "./candidate-evidence.mjs";
import { deliveryAccounting, launchedRuns } from "./delivery.mjs";
import {
	childEnded,
	childFulfils,
	parentToolCalls,
	scoreAttempt,
} from "./record.mjs";
import review from "./scenarios/review/scenario.mjs";
import workflow from "./scenarios/review-workflow/scenario.mjs";

const WORK = "/r/workspace";
const TARGETS = Object.keys(review.expectedFacts);
const NAMES = TARGETS.map((t) => `review-${t}`);
const IDS = TARGETS.map((_, i) => `a${i}000000`);
const REPORT = (id) => `/r/artifacts/workspace/artifacts/s1/results/${id}/report-1.md`;
const FOLDERS = NAMES.map((name, i) => ({ runId: IDS[i], name, report: REPORT(IDS[i]) }));
const LINE = (t) => `${t}: ${review.expectedFacts[t]}`;
const ALL_LINES = TARGETS.map(LINE).join("\n");

const assistant = (stopReason, text, calls = []) => ({
	type: "message",
	message: { role: "assistant", stopReason, content: [{ type: "text", text }, ...calls] },
});
const call = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const toolResult = (id, toolName, text, extra = {}) => ({
	type: "message",
	message: { role: "toolResult", toolCallId: id, toolName, isError: false, content: [{ type: "text", text }], ...extra },
});
const launchArgs = (names) => ({
	children: names.map((name) => ({ name, agent: `bench-${name}`, title: name, task: "t" })),
});
// A codemode script and its nested calls, as Pi records them (name, status, raw arguments).
const script = (id, nested, text) => [
	assistant("toolUse", "", [call(id, "codemode", { code: "..." })]),
	toolResult(id, "codemode", text, {
		details: { calls: [] },
		nestedCalls: { calls: nested.map((c, i) => ({ id: `${id}/${i + 1}`, status: "ok", ...c })), complete: true },
	}),
];
const launchNested = (names, raw = false) => ({
	name: "subagent",
	arguments: raw ? { children: JSON.stringify(launchArgs(names).children) } : launchArgs(names),
});
// The current wait key (T88); waitRecordedIds is the shape of calls recorded before T88.
const waitNested = (runIds, extra = {}) => ({ name: "subagent_wait", arguments: { runIds, ...extra } });
const waitRecordedIds = (ids) => ({ name: "subagent_wait", arguments: { ids } });
const answer = (text = ALL_LINES) => assistant("stop", text);
const children = (scenario) =>
	scenario.expectedChildRoles.map((role, i) => ({
		name: NAMES[i],
		role,
		contract: scenario.childResults[role],
		ended: true,
		fulfils: { read: true, returned: true },
	}));

/** The verdict path of attempt.mjs for a correct answer: delivery accounting, then scoreAttempt. */
function verdict(events, scenario = workflow, extra = {}) {
	const kids = children(scenario);
	const delivery = deliveryAccounting({
		parentEvents: events,
		children: kids,
		answeredAt: events.length - 1,
		scenario,
		workDir: WORK,
		runFolders: FOLDERS,
	});
	const result = scoreAttempt({
		answer: scenario.expectedFacts,
		childRoles: scenario.expectedChildRoles,
		parentTools: parentToolCalls(events),
		childOutcomes: kids.map((k, i) => ({ ...k.fulfils, delivered: delivery.runs[i].delivered })),
		workflowScript: delivery.workflowScript,
		scenario,
		...extra,
	});
	return { result, delivery };
}

const SCRIPTED = [...script("c1", [launchNested(NAMES), waitNested(IDS)], ALL_LINES), answer()];

test("[T59a P1-1] review-workflow passes only through the workflow script; a correct direct fallback fails", () => {
	assert.equal(verdict(SCRIPTED).result, "pass");
	// The same work launched directly: eight result messages by their own run ids, a correct answer.
	const direct = [
		assistant("toolUse", "", [call("d1", "subagent", launchArgs(NAMES))]),
		toolResult("d1", "subagent", "started", {
			details: { status: "started", children: NAMES.map((name, i) => ({ id: IDS[i], name, status: "started" })) },
		}),
		...TARGETS.map((t, i) => ({ type: "custom_message", customType: "subagent_result", content: LINE(t), details: { id: IDS[i] } })),
		answer(),
	];
	const fallback = verdict(direct);
	assert.equal(fallback.delivery.undelivered, 0);
	assert.equal(fallback.result, "wrong-delegation");
	// The baseline arm accepts the same direct transcript.
	assert.equal(verdict(direct, { ...review, release: { candidate: true } }).result, "pass");
	// A script that launches but never joins the batch is no workflow either.
	const unjoined = [...script("c1", [launchNested(NAMES)], ALL_LINES), answer()];
	assert.equal(verdict(unjoined).result, "wrong-delegation");
});

test("[T59a P1-3] a digest counts only for runs its own script joined", () => {
	const lastId = IDS.at(-1);
	const firstSeven = TARGETS.slice(0, -1).map(LINE).join("\n");
	// Script 1 joins seven runs; script 2 prints the eighth line without a wait.
	const quoted = [
		...script("c1", [launchNested(NAMES), waitNested(IDS.slice(0, -1))], firstSeven),
		...script("c2", [], LINE(TARGETS.at(-1))),
		answer(),
	];
	const q = verdict(quoted);
	assert.equal(q.delivery.runs.at(-1).runId, lastId);
	assert.deepEqual([q.delivery.runs.at(-1).handover, q.delivery.runs.at(-1).delivered], ["undelivered", false]);
	assert.equal(q.result, "wrong-delegation");
	// Script 2 waits, but for another run: still no digest for the eighth run.
	const wrongWait = [
		...script("c1", [launchNested(NAMES), waitNested(IDS.slice(0, -1))], firstSeven),
		...script("c2", [waitNested([IDS[0]])], LINE(TARGETS.at(-1))),
		answer(),
	];
	assert.equal(verdict(wrongWait).delivery.runs.at(-1).delivered, false);
	// A wait with mode any joins no run for the digest.
	const anyWait = [...script("c1", [launchNested(NAMES), waitNested(IDS, { mode: "any" })], ALL_LINES), answer()];
	assert.equal(verdict(anyWait).result, "wrong-delegation");
	// A wait by launch names (the wait tool takes ids or names) joins those runs.
	const byName = [...script("c1", [launchNested(NAMES), waitNested(NAMES)], ALL_LINES), answer()];
	assert.equal(verdict(byName).result, "pass");
});

test("[T59a P1-4] a successful read of the run's report locator carries its keyed line; a fixture read is duplicate work", () => {
	const kids = children(review).slice(0, 1);
	const launch = [
		assistant("toolUse", "", [call("d1", "subagent", launchArgs([NAMES[0]]))]),
		toolResult("d1", "subagent", "started", {
			details: { status: "started", children: [{ id: IDS[0], name: NAMES[0], status: "started" }] },
		}),
		// Capped summary without the keyed line, with the report locator.
		{ type: "custom_message", customType: "subagent_result", content: "verdict in the report\nreport: ../artifacts/...", details: { id: IDS[0] } },
	];
	const account = (path, text, isError = false) =>
		deliveryAccounting({
			parentEvents: [
				...launch,
				assistant("toolUse", "", [call("r1", "read", { path })]),
				{ ...toolResult("r1", "read", text), message: { ...toolResult("r1", "read", text).message, isError } },
				answer(LINE(TARGETS[0])),
			],
			children: kids,
			answeredAt: 5,
			scenario: review,
			workDir: WORK,
			runFolders: FOLDERS,
		}).runs[0];
	const locator = "../artifacts/workspace/artifacts/s1/results/" + IDS[0] + "/report-1.md";
	const pulled = account(locator, `report
${LINE(TARGETS[0])}`);
	assert.deepEqual([pulled.handover, pulled.transfers, pulled.delivered, pulled.outcome], ["delivered", 1, true, "clean_yield"]);
	// A failed read of the locator carries nothing.
	assert.equal(account(locator, "ENOENT", true).delivered, false);
	// A read of the child's fixture file is duplicate work and carries nothing.
	const fixture = account("review/billing.md", LINE(TARGETS[0]));
	assert.deepEqual([fixture.delivered, fixture.outcome], [false, "duplicate"]);
});

test("[T59a P1-5] the child's result is the report the candidate publishes, with the strict keyed check", () => {
	const contract = review.childResults["bench-review-auth"];
	const head = [
		{ type: "session", cwd: "/r/workspace" },
		{ type: "custom", customType: "pi-subagents_launch_metadata", data: { name: "review-auth" } },
		assistant("toolUse", "", [call("r1", "read", { path: "review/auth.md" })]),
		toolResult("r1", "read", "x"),
	];
	const done = (summary, autonomous = true) => ({
		type: "custom",
		customType: "pi-subagent-accepted-call",
		data: { toolCallId: "d1", tool: "subagent_done", args: { outcome: "done", summary }, autonomous },
	});
	const nudge = { type: "custom", customType: "pi-subagent-completion-nudge", data: {} };
	// Keyed reply, nudge, then a tool-only completion call with a summary that holds no key.
	const toolOnly = [...head, assistant("stop", "auth: approve-4417"), nudge,
		{ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [call("d1", "subagent_done")] } },
		done("verdict sent")];
	assert.equal(childEnded(toolOnly), true);
	assert.deepEqual(childFulfils(toolOnly, contract, "/r/workspace"), { read: true, returned: true });
	// Keyed reply, nudge, then "ok" without a call: text before the nudge wins.
	const okReply = [...head, assistant("stop", "auth: approve-4417"), nudge, assistant("stop", "ok")];
	assert.deepEqual(childFulfils(okReply, contract, "/r/workspace"), { read: true, returned: true });
	// An acknowledgement after an autonomous (final) call does not replace the report.
	const ack = [...head, assistant("toolUse", "auth: approve-4417", [call("d1", "subagent_done")]), done("sent"), assistant("stop", "ok")];
	assert.deepEqual(childFulfils(ack, contract, "/r/workspace"), { read: true, returned: true });
	// Strict: a key inside prose is no keyed line, in the report or the summary.
	const prose = [...head, assistant("toolUse", "Found: auth: approve-4417", [call("d1", "subagent_done")]), done("The verdict is auth: approve-4417")];
	assert.deepEqual(childFulfils(prose, contract, "/r/workspace"), { read: true, returned: false });
	// After a final call, text in a later message is not the report.
	const late = [...head, assistant("toolUse", "", [call("d1", "subagent_done")]), done("sent"), assistant("stop", "auth: approve-4417")];
	assert.deepEqual(childFulfils(late, contract, "/r/workspace"), { read: true, returned: false });
	// An autonomous caller_ping is a blocked end (no result).
	const ping = [...head, assistant("toolUse", "", [call("p1", "caller_ping")]),
		{ type: "custom", customType: "pi-subagent-accepted-call", data: { toolCallId: "p1", tool: "caller_ping", args: { message: "?" }, autonomous: true } }];
	assert.equal(childEnded(ping), true);
	assert.equal(childFulfils(ping, contract, "/r/workspace").returned, false);
});

test("[T72 review P1] a current autonomous caller_ping ends the child only with the parent's blocked record", () => {
	const head = [{ type: "session", cwd: "/r/workspace" }, { type: "custom", customType: "pi-subagents_launch_metadata", data: { name: "x" } }];
	// T72: no accepted-call entry, a tool-use stop, maybe no persisted result before the exit.
	const ping = [...head, assistant("toolUse", "", [call("p1", "caller_ping", { message: "?" })])];
	assert.equal(childEnded(ping), false, "a ping request alone is no end");
	assert.equal(childEnded(ping, true), true, "with the blocked record the ping ended the run");
	assert.equal(childEnded([...ping, toolResult("p1", "caller_ping", "Ping sent.")], true), true);
	// A refused ping (a second ping, or one after done owned the end) is no end.
	const refused = [...ping, toolResult("p1", "caller_ping", "already", { isError: true })];
	assert.equal(childEnded(refused, true), false);
	// A call after a takeover keeps the pane open: its entry ends nothing.
	const takenOver = [...head, assistant("toolUse", "", [call("d1", "subagent_done")]),
		{ type: "custom", customType: "pi-subagent-accepted-call", data: { toolCallId: "d1", tool: "subagent_done", args: {}, autonomous: false } }];
	assert.equal(childEnded(takenOver), false);
});

test("[T59a P1-6] a launch whose children list came as a JSON string binds the same runs", () => {
	const raw = [...script("c1", [launchNested(NAMES, true), waitNested(IDS)], ALL_LINES), answer()];
	assert.deepEqual(launchedRuns(raw, "subagent", FOLDERS).map((r) => r.runId), launchedRuns(SCRIPTED, "subagent", FOLDERS).map((r) => r.runId));
	assert.equal(launchedRuns(raw, "subagent", FOLDERS).length, 8);
	assert.equal(verdict(raw).result, "pass");
});

// T78 fix round 1 (review P1). D05: the candidate parses only a children string. Pi's validation wraps an
// ids string as one id (validateToolArguments on Type.Array(Type.String()) gives ["[\"a\",\"b\"]"]), so a
// wait with stringified ids joins no run, and the scorer must not credit one.
test("[T78] a wait whose ids came as a JSON string joins no run; an absent ids list joins the script's launches", () => {
	const stringIds = [...script("c1", [launchNested(NAMES), waitNested(JSON.stringify(IDS))], ALL_LINES), answer()];
	const { result, delivery } = verdict(stringIds);
	assert.equal(delivery.workflowScript, false, "no join happened");
	assert.equal(result, "wrong-delegation");
	const noIds = [...script("c1", [launchNested(NAMES), { name: "subagent_wait", arguments: {} }], ALL_LINES), answer()];
	assert.equal(verdict(noIds).result, "pass");
});

// T78 (D05): cf6dbf4's top-level single form starts one child, also with an empty children list.
const singleNested = (name, extra = {}) => ({ name: "subagent", arguments: { ...launchArgs([name]).children[0], ...extra } });
test("[T78] single-form launches, and an empty children list with top-level fields, bind their runs", () => {
	for (const extra of [{}, { children: [] }, { children: "[]" }]) {
		const events = [...script("c1", [...NAMES.map((name) => singleNested(name, extra)), waitNested(IDS)], ALL_LINES), answer()];
		assert.equal(launchedRuns(events, "subagent", FOLDERS).length, 8, JSON.stringify(extra));
		assert.equal(verdict(events).result, "pass", JSON.stringify(extra));
	}
});

test("[T59a P1-7] a repeated batch on the candidate is a counted failure", () => {
	assert.equal(verdict(SCRIPTED, workflow, { repeatedLaunch: true }).result, "wrong-delegation");
	// Two scripts that launch the same names: no name binds to one run.
	const folders = [...FOLDERS, ...NAMES.map((name, i) => ({ runId: `b${i}000000`, name, report: null }))];
	const twice = [...SCRIPTED.slice(0, 2), ...script("c2", [launchNested(NAMES), waitNested(NAMES)], ALL_LINES), answer()];
	const runs = launchedRuns(twice, "subagent", folders);
	assert.equal(runs.length, 16);
	assert.equal(new Set(runs.map((r) => r.name)).size, 8);
});

test("[T59a P1-8] a nested fixture read is duplicate work whatever its status, like a direct read", () => {
	const nestedRead = (status) => [
		...script("c1", [launchNested(NAMES), waitNested(IDS), { name: "read", status, arguments: { path: "review/auth.md", offset: 999 } }], ALL_LINES),
		answer(),
	];
	for (const status of ["ok", "error"]) {
		const { delivery } = verdict(nestedRead(status));
		assert.equal(delivery.runs[1].outcome, "duplicate", status);
		assert.equal(delivery.outcomeClasses.duplicate, 1, status);
	}
});

test("[T59a] a subagent_wait reply is one carrier per run it lists; a lookup after the result message is an extra copy", () => {
	const scenario = { ...review, parentToolAllowlist: ["subagent", "subagent_wait"] };
	const kids = children(review).slice(0, 2);
	const launch = [
		assistant("toolUse", "", [call("d1", "subagent", launchArgs(NAMES.slice(0, 2)))]),
		toolResult("d1", "subagent", "started", {
			details: { status: "started", children: NAMES.slice(0, 2).map((name, i) => ({ id: IDS[i], name, status: "started" })) },
		}),
	];
	const wait = (ids) =>
		toolResult("w1", "subagent_wait", "...", {
			details: { status: "complete", results: ids.map((id) => ({ runId: id, name: NAMES[IDS.indexOf(id)], text: LINE(TARGETS[IDS.indexOf(id)]) })), pending: [], missing: [] },
		});
	const message = (i) => ({ type: "custom_message", customType: "subagent_result", content: LINE(TARGETS[i]), details: { id: IDS[i] } });
	const account = (events) =>
		deliveryAccounting({ parentEvents: events, children: kids, answeredAt: events.length - 1, scenario, workDir: WORK });
	const waited = account([...launch, wait(IDS.slice(0, 2)), answer()]);
	assert.deepEqual(waited.runs.map((r) => [r.handover, r.delivered]), [["delivered", true], ["delivered", true]]);
	assert.deepEqual([waited.transfers, waited.extraCopies, waited.undelivered], [2, 0, 0]);
	const lookedUp = account([...launch, message(0), wait([IDS[0]]), message(1), answer()]);
	assert.deepEqual(lookedUp.runs.map((r) => r.handover), ["duplicate-carrier", "delivered"]);
	assert.deepEqual([lookedUp.transfers, lookedUp.extraCopies, lookedUp.undelivered], [3, 1, 0]);
});

test("[T59a] a digest is no transfer; a result message after it is the run's one transfer, no extra copy", () => {
	const events = [...SCRIPTED.slice(0, 2), { type: "custom_message", customType: "subagent_result", content: LINE(TARGETS[0]), details: { id: IDS[0] } }, answer()];
	const { delivery } = verdict(events);
	assert.deepEqual([delivery.runs[0].handover, delivery.runs[0].transfers], ["delivered", 1]);
	assert.deepEqual([delivery.runs[1].handover, delivery.runs[1].transfers], ["digest", 0]);
	assert.deepEqual([delivery.transfers, delivery.extraCopies, delivery.digests, delivery.undelivered], [1, 0, 7, 0]);
});

// T88 fix round 1 (review P1): the wait tool took runIds (the launch reply key). The tool was removed on
// 2026-11-24 (owner); recorded sessions still hold its calls. Differential: the runs the wait tool
// targeted (its rule, frozen from src/tools/wait-tool.ts at c540fcb: mode any returns none here, no
// runIds means every run, else id or name) against the runs the scorer credits as joined. Older
// recorded calls that used ids keep their coverage.
test("[T88] a recorded wait by runIds joins exactly the runs the wait tool targeted; recorded ids calls still score", () => {
	const launched = new Set(IDS);
	const targeted = (valid) => {
		if (valid.mode === "any") return new Set();
		if (valid.runIds === undefined) return launched;
		return new Set(FOLDERS.filter((f) => valid.runIds.includes(f.runId) || valid.runIds.includes(f.name)).map((f) => f.runId));
	};
	const shapes = [{ runIds: [IDS[0]] }, { runIds: IDS.slice(2, 5) }, { runIds: [NAMES[7], IDS[1]] }, { runIds: IDS }, {}, { runIds: IDS, mode: "any" }];
	for (const args of shapes) {
		const events = [...script("c1", [launchNested(NAMES), { name: "subagent_wait", arguments: args }], ALL_LINES), answer()];
		const [coverage] = scriptCoverage(events, FOLDERS).values();
		assert.deepEqual([...coverage.joined].sort(), [...targeted(args)].sort(), JSON.stringify(args));
	}
	// A call from before T88 (recorded transcripts) used ids; the scorer keeps reading it.
	const recorded = [...script("c1", [launchNested(NAMES), waitRecordedIds([IDS[0]])], ALL_LINES), answer()];
	assert.deepEqual([...[...scriptCoverage(recorded, FOLDERS).values()][0].joined], [IDS[0]]);
});
