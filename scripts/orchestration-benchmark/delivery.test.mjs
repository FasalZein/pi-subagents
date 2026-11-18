// Run: node --test scripts/orchestration-benchmark/delivery.test.mjs
// Delivery accounting by run id, the keyed oracle and the scenario (a) fixture. No model, no Pi.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deliveryAccounting } from "./delivery.mjs";
import {
	answerMatches,
	answerParser,
	scoreAttempt,
	terminalAnswer,
} from "./record.mjs";
import recon from "./scenarios/recon/scenario.mjs";

const WORK = "/w";
const SCENARIO = {
	parentToolAllowlist: ["subagent"],
	parentLoadTool: "subagent",
};
const assistant = (stopReason, text, calls = []) => ({
	type: "message",
	message: {
		role: "assistant",
		stopReason,
		content: [{ type: "text", text }, ...calls],
	},
});
const launch = (runs, status = "started") => ({
	type: "message",
	message: {
		role: "toolResult",
		toolName: "subagent",
		content: [{ type: "text", text: "started" }],
		details: {
			status,
			children: runs.map(([id, name]) => ({ id, name, status })),
		},
	},
});
const result = (id, text) => ({
	type: "custom_message",
	customType: "subagent_result",
	content: text,
	details: { id },
});
const user = (text) => ({
	type: "message",
	message: { role: "user", content: text },
});
const child = (name, returns, extra = {}) => ({
	name,
	role: name,
	contract: { returns, reads: [`${name}.md`] },
	ended: true,
	fulfils: { read: true, returned: true },
	...extra,
});
const account = (parentEvents, children) =>
	deliveryAccounting({
		parentEvents,
		children,
		parentReply: terminalAnswer(parentEvents),
		scenario: SCENARIO,
		workDir: WORK,
	});
const LAUNCH = launch([
	["r1", "a"],
	["r2", "b"],
]);

test("one carrier per run id is a clean delivery and a clean yield", () => {
	const record = account(
		[
			LAUNCH,
			result("r1", "x-1"),
			result("r2", "y-2"),
			assistant("stop", "x-1 y-2"),
		],
		[child("a", "x-1"), child("b", "y-2")],
	);
	assert.deepEqual(
		record.runs.map((r) => [r.runId, r.handover, r.outcome]),
		[
			["r1", "delivered", "clean_yield"],
			["r2", "delivered", "clean_yield"],
		],
	);
	assert.deepEqual(
		[record.transfers, record.duplicated, record.undelivered],
		[2, 0, 0],
	);
	assert.equal(record.cleanYieldShare, 1);
});

test("a blocking batch result is one carrier for each run it lists", () => {
	const record = account(
		[
			launch(
				[
					["r1", "a"],
					["r2", "b"],
				],
				"completed",
			),
			assistant("stop", "x-1 y-2"),
		],
		[child("a", "x-1"), child("b", "y-2")],
	);
	// The launch result hands over both finished runs; their summaries hold no result.
	assert.deepEqual(
		record.runs.map((r) => [r.handover, r.delivered]),
		[
			["delivered", false],
			["delivered", false],
		],
	);
	const withText = launch(
		[
			["r1", "a"],
			["r2", "b"],
		],
		"completed",
	);
	withText.message.details.children[0].summary = "x-1";
	withText.message.details.children[1].summary = "y-2";
	withText.message.content = [{ type: "text", text: "x-1\n\ny-2" }];
	const carried = account(
		[withText, assistant("stop", "x-1 y-2")],
		[child("a", "x-1"), child("b", "y-2")],
	);
	assert.deepEqual(
		carried.runs.map((r) => r.handover),
		["delivered", "delivered"],
	);
	assert.equal(carried.transfers, 2);
});

test("[T02b-2] transport counts every handover by run id, apart from the correctness of its text", () => {
	// Child a returns a wrong fact; the wait reply and the result message both carry it.
	const wait = {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "subagent",
			content: [{ type: "text", text: 'Sub-agent "a" completed.\n\nwrong-9' }],
			details: { id: "r1", name: "a", status: "completed", summary: "wrong-9" },
		},
	};
	const record = account(
		[
			LAUNCH,
			wait,
			result("r1", 'Sub-agent "a" completed.\n\nwrong-9'),
			result("r2", "y-2"),
			assistant("stop", "y-2"),
		],
		[
			child("a", "x-1", { fulfils: { read: true, returned: false } }),
			child("b", "y-2"),
		],
	);
	assert.deepEqual(
		record.runs.map((r) => [r.handover, r.transfers, r.delivered]),
		[
			["duplicate-carrier", 2, false],
			["delivered", 1, true],
		],
	);
	assert.deepEqual([record.transfers, record.duplicated], [3, 1]);
	// A batch result binds each child's own summary, not the joined batch text.
	const batch = launch(
		[
			["r1", "a"],
			["r2", "b"],
		],
		"batch",
	);
	batch.message.details.children[0].summary = "x-1 y-2";
	batch.message.details.children[1].summary = "z-0";
	batch.message.content = [{ type: "text", text: "x-1 y-2\n\nz-0" }];
	const joined = account(
		[batch, assistant("stop", "x-1 y-2")],
		[
			child("a", "x-1"),
			child("b", "y-2", { fulfils: { read: true, returned: false } }),
		],
	);
	assert.deepEqual(
		joined.runs.map((r) => [r.handover, r.delivered]),
		[
			["delivered", true],
			["delivered", false],
		],
	);
	assert.equal(joined.transfers, 2);
});

test("transfers count by run id: repeated text in later requests is no transfer", () => {
	const record = account(
		[
			LAUNCH,
			result("r1", "x-1"),
			user("Remember x-1"),
			assistant("toolUse", "So x-1 it is."),
			result("r2", "y-2"),
			assistant("stop", "x-1 y-2"),
		],
		[child("a", "x-1"), child("b", "y-2")],
	);
	assert.equal(record.transfers, 2);
	assert.equal(record.duplicated, 0);
});

test("a duplicate carrier, a deliberate digest and a missing handover are told apart", () => {
	const record = account(
		[
			launch([
				["r1", "a"],
				["r2", "b"],
				["r3", "c"],
				["r4", "d"],
			]),
			result("r1", "x-1"),
			result("r1", "x-1 again"),
			// A digest: one carrier of run r3 holds the result of run r2 as well.
			result("r3", "z-3, digest of b: y-2"),
			assistant("stop", "x-1 y-2 z-3"),
		],
		[
			child("a", "x-1"),
			child("b", "y-2"),
			child("c", "z-3"),
			child("d", "w-4"),
		],
	);
	assert.deepEqual(
		record.runs.map((r) => r.handover),
		["duplicate-carrier", "digest", "delivered", "undelivered"],
	);
	assert.deepEqual(
		[record.transfers, record.duplicated, record.digests, record.undelivered],
		[3, 1, 1, 1],
	);
	// Only a result that came by its own run id is a clean yield.
	assert.deepEqual(
		record.runs.map((r) => r.outcome),
		["clean_yield", "auxiliary", "clean_yield", "auxiliary"],
	);
});

test("[T02b-4] a missing handover is undelivered; stopReason never decides parked or lost", () => {
	const children = [child("a", "x-1")];
	// A detached launch ends its tool batch: the last reason is toolUse while the
	// result waits for the next human turn. An unrelated stop reply proves nothing either.
	const detached = account(
		[LAUNCH, assistant("toolUse", "Launching.")],
		children,
	);
	const idle = account([LAUNCH, assistant("stop", "Waiting.")], children);
	for (const record of [detached, idle]) {
		assert.deepEqual(
			[record.runs[0].handover, record.runs[0].subClass, record.undelivered],
			["undelivered", "unknown", 1],
		);
		assert.deepEqual(record.undeliveredBySubClass, {
			parked: 0,
			lost: 0,
			unknown: 1,
		});
	}
	// A child that did not end its turn had nothing to hand over.
	const none = account(
		[LAUNCH, assistant("stop", "Waiting.")],
		[child("a", "x-1", { ended: false })],
	);
	assert.deepEqual([none.runs[0].handover, none.undelivered], ["no-result", 0]);
});

test("a result that arrives after the terminal reply is a transfer, but not available to the scored answer", () => {
	const record = account(
		[LAUNCH, assistant("stop", "Done."), result("r1", "x-1")],
		[child("a", "x-1")],
	);
	assert.deepEqual(
		[
			record.runs[0].handover,
			record.transfers,
			record.runs[0].availableToAnswer,
			record.runs[0].delivered,
		],
		["delivered", 1, false, false],
	);
});

test("[T02b-3] transport counts to the sample boundary, not to the last assistant stop", () => {
	const wait = {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "subagent",
			content: [{ type: "text", text: "x-1" }],
			details: { id: "r1", name: "a", status: "completed" },
		},
	};
	// A wait copy before the stop and a message copy after it are two transfers.
	const record = account(
		[LAUNCH, wait, assistant("stop", "x-1"), result("r1", "x-1")],
		[child("a", "x-1")],
	);
	assert.deepEqual(
		[record.runs[0].handover, record.transfers, record.duplicated],
		["duplicate-carrier", 2, 1],
	);
	assert.deepEqual(
		[record.runs[0].availableToAnswer, record.runs[0].delivered],
		[true, true],
	);
});

test("a child whose name matches no single launched run is unbound, never delivered", () => {
	const record = account(
		[
			launch([
				["r1", "a"],
				["r9", "a"],
			]),
			result("r1", "x-1"),
			assistant("stop", "x-1"),
		],
		[child("a", "x-1")],
	);
	assert.deepEqual(
		[record.runs[0].handover, record.runs[0].delivered],
		["unbound", false],
	);
});

test("the parent reading a child's fixture file itself is a duplicate outcome", () => {
	const read = {
		type: "toolCall",
		name: "read",
		arguments: { path: "./a.md" },
	};
	const record = account(
		[
			LAUNCH,
			assistant("toolUse", "", [read]),
			result("r1", "x-1"),
			assistant("stop", "x-1"),
		],
		[child("a", "x-1")],
	);
	assert.equal(record.runs[0].outcome, "duplicate");
	assert.deepEqual(record.outcomeClasses, {
		clean_yield: 0,
		duplicate: 1,
		auxiliary: 0,
	});
});

test("the recon oracle compares the final reply by key", () => {
	const parse = answerParser(recon);
	const lines = Object.entries(recon.expectedFacts).map(
		([k, v]) => `${k}: ${v}`,
	);
	const answer = (text) =>
		terminalAnswer([assistant("stop", text)], parse).answer;
	assert.equal(answerMatches(answer(lines.join("\n")), recon), true);
	// Order does not matter; formatting around a value does not matter.
	assert.equal(
		answerMatches(
			answer(
				["Here:", ...lines.toReversed().map((l) => `\`${l}\`.`)].join("\n"),
			),
			recon,
		),
		true,
	);
	// A missing 7th fact or a wrong value fails.
	assert.equal(
		answerMatches(answer(lines.slice(0, 6).join("\n")), recon),
		false,
	);
	assert.equal(
		answerMatches(
			answer(lines.join("\n").replace("quartz-7764", "quartz-0000")),
			recon,
		),
		false,
	);
	assert.equal(answer("No facts."), null);
});

test("a batch with any launch order passes when the scenario allows any order", () => {
	const ok = { read: true, returned: true, delivered: true };
	const roles = recon.expectedChildRoles.toReversed();
	assert.equal(
		scoreAttempt({
			answer: recon.expectedFacts,
			childRoles: roles,
			parentTools: ["subagent"],
			childOutcomes: roles.map(() => ok),
			scenario: recon,
		}),
		"pass",
	);
});

test("[T02b-5] the recon fixture plants 6 shared facts, one per child, and a 7th only in child 4's private instructions", () => {
	const reconDir = join(
		dirname(fileURLToPath(import.meta.url)),
		"scenarios",
		"recon",
	);
	const factsIn = (file) =>
		[...readFileSync(file, "utf8").matchAll(/(FACT-\d): ([\w-]+)/g)].map(
			(m) => [m[1], m[2]],
		);
	const dir = join(reconDir, "workspace", "recon");
	const files = readdirSync(dir).sort();
	assert.equal(files.length, 6);
	const keysByFile = files.map((name) => factsIn(join(dir, name)));
	// Each shared file holds exactly its own fact; FACT-7 is in no workspace file.
	keysByFile.forEach((facts, index) => {
		const key = `FACT-${index + 1}`;
		assert.deepEqual(facts, [[key, recon.expectedFacts[key]]]);
	});
	const agents = join(reconDir, "agents");
	const privateFacts = readdirSync(agents)
		.sort()
		.map((name) => [name, factsIn(join(agents, name))]);
	assert.deepEqual(
		privateFacts.filter(([, facts]) => facts.length > 0),
		[["bench-recon-4.md", [["FACT-7", recon.expectedFacts["FACT-7"]]]]],
	);
	// Every child contract reads its own file and returns its facts; child 4 also its private fact.
	for (const [role, contract] of Object.entries(recon.childResults)) {
		const i = Number(role.at(-1));
		assert.deepEqual(contract.reads, [`recon/area-${i}.md`]);
		const own = keysByFile[i - 1].map(([, value]) => value);
		assert.deepEqual(
			contract.returns,
			i === 4 ? [...own, recon.expectedFacts["FACT-7"]] : own,
		);
	}
});

test("[T02b-5] FACT-7 counts only when it arrives through child 4's own report", () => {
	const launch6 = launch([
		["r1", "a"],
		["r4", "d"],
	]);
	const reply = assistant("stop", "x-1 h-4 e-7");
	const children = [child("a", "x-1"), child("d", ["h-4", "e-7"])];
	// A sibling's report carries FACT-7; child 4's own report lacks it.
	const leaked = account(
		[launch6, result("r1", "x-1 e-7"), result("r4", "h-4"), reply],
		children,
	);
	assert.deepEqual(
		leaked.runs.map((r) => r.delivered),
		[true, false],
	);
	const own = account(
		[launch6, result("r1", "x-1"), result("r4", "h-4 e-7"), reply],
		children,
	);
	assert.deepEqual(
		own.runs.map((r) => r.delivered),
		[true, true],
	);
});
