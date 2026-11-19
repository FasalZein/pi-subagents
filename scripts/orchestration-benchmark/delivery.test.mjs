// Run: node --test scripts/orchestration-benchmark/delivery.test.mjs
// Delivery accounting by run id, the keyed oracle and the scenario (a) fixture. No model, no Pi.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { carriers, deliveryAccounting } from "./delivery.mjs";
import {
	answerMatches,
	answerParser,
	childFulfils,
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
// The reply an observer would score: the last assistant reply, when it is terminal.
const scoredAt = (events) => {
	const index = events.findLastIndex(
		(e) => e.type === "message" && e.message.role === "assistant",
	);
	return events[index]?.message.stopReason === "stop" ? index : null;
};
const account = (parentEvents, children) =>
	deliveryAccounting({
		parentEvents,
		children,
		answeredAt: scoredAt(parentEvents),
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
		[record.transfers, record.extraCopies, record.undelivered],
		[2, 0, 0],
	);
	assert.equal(record.cleanYieldShare, 1);
});

test("[T22] a grouped result message is one carrier for each member, with its own id and text", () => {
	// The shape groupRunEnds writes (src/runtime/run-end-message.ts): members carry their own details.id.
	const grouped = {
		type: "custom_message",
		customType: "subagent_result",
		content: "x-1\n\ny-2",
		details: {
			results: [
				{ customType: "subagent_result", content: "x-1", details: { id: "r1" } },
				{ customType: "subagent_ping", content: "y-2", details: { id: "r2" } },
			],
		},
	};
	assert.deepEqual(
		carriers([grouped], SCENARIO.parentToolAllowlist).map((c) => [c.kind, c.runId, c.text]),
		[
			["result-message", "r1", "x-1"],
			["result-message", "r2", "y-2"],
		],
	);
	const record = account(
		[LAUNCH, grouped, assistant("stop", "x-1 y-2")],
		[child("a", "x-1"), child("b", "y-2")],
	);
	assert.deepEqual(
		record.runs.map((r) => [r.runId, r.handover]),
		[
			["r1", "delivered"],
			["r2", "delivered"],
		],
	);
	assert.deepEqual([record.transfers, record.extraCopies, record.undelivered], [2, 0, 0]);
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
	assert.deepEqual([record.transfers, record.extraCopies], [3, 1]);
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

test("[T02b-record] the record keeps the carrier events by run id, without message text", () => {
	const record = account(
		[
			LAUNCH,
			result("r1", "x-1"),
			result("r1", "x-1"),
			result("r2", "y-2"),
			assistant("stop", "x-1 y-2"),
		],
		[child("a", "x-1"), child("b", "y-2")],
	);
	assert.deepEqual(record.carrierEvents, [
		{ kind: "result-message", index: 1, runId: "r1" },
		{ kind: "result-message", index: 2, runId: "r1" },
		{ kind: "result-message", index: 3, runId: "r2" },
	]);
	assert.equal(record.answeredAt, 4);
	// Extra copies: one run carried twice gives one extra copy.
	assert.equal(record.extraCopies, 1);
	assert.equal(JSON.stringify(record).includes("x-1"), false);
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
	assert.equal(record.extraCopies, 0);
});

test("[T02b-7] a duplicate carrier, a declared digest and a missing handover are told apart; a sibling's quote is no digest", () => {
	const events = [
		launch([
			["r1", "a"],
			["r2", "b"],
			["r3", "c"],
			["r4", "d"],
		]),
		result("r1", "x-1"),
		result("r1", "x-1 again"),
		// A sibling quotes the result of b; b's own carrier never arrives.
		result("r3", "z-3, quote of b: y-2"),
		assistant("stop", "x-1 y-2 z-3"),
	];
	const children = [
		child("a", "x-1"),
		child("b", "y-2"),
		child("c", "z-3"),
		child("d", "w-4"),
	];
	const record = account(events, children);
	assert.deepEqual(
		record.runs.map((r) => r.handover),
		["duplicate-carrier", "undelivered", "delivered", "undelivered"],
	);
	assert.deepEqual(
		[record.transfers, record.extraCopies, record.digests, record.undelivered],
		[3, 1, 0, 2],
	);
	// Only a scenario that declares a digest-producing operation and the runs it
	// covers gets the digest class, and only from that operation's result.
	const digest = {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "workflow",
			content: [{ type: "text", text: "digest: y-2" }],
		},
	};
	const declared = deliveryAccounting({
		parentEvents: [...events.slice(0, -1), digest, events.at(-1)],
		children,
		answeredAt: scoredAt(events),
		scenario: {
			...SCENARIO,
			parentToolAllowlist: ["subagent", "workflow"],
			digestOperations: [{ toolName: "workflow", covers: ["b"] }],
		},
		workDir: WORK,
	});
	assert.deepEqual(
		declared.runs.map((r) => r.handover),
		["duplicate-carrier", "digest", "delivered", "undelivered"],
	);
	assert.deepEqual([declared.digests, declared.undelivered], [1, 1]);
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
		[record.runs[0].handover, record.transfers, record.extraCopies],
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

test("[T02b-6] a clean yield needs the child's fact under its own key", () => {
	const roles = Object.keys(recon.childResults);
	const facts = recon.expectedFacts;
	const keyed = (keys) => keys.map((k) => `${k}: ${facts[k]}`).join("\n");
	const keysOf = (i) => (i === 4 ? ["FACT-4", "FACT-7"] : [`FACT-${i}`]);
	const children = roles.map((role) => ({
		name: role,
		role,
		contract: recon.childResults[role],
		ended: true,
		fulfils: { read: true, returned: true },
	}));
	// The parent swaps the values of FACT-1 and FACT-2; both tokens stay in its text.
	const swapped = Object.keys(facts)
		.map((k) => {
			const value =
				k === "FACT-1"
					? facts["FACT-2"]
					: k === "FACT-2"
						? facts["FACT-1"]
						: facts[k];
			return `${k}: ${value}`;
		})
		.join("\n");
	const record = account(
		[
			launch(roles.map((role, i) => [`r${i + 1}`, role])),
			...roles.map((_, i) => result(`r${i + 1}`, keyed(keysOf(i + 1)))),
			assistant("stop", swapped),
		],
		children,
	);
	assert.equal(record.outcomeClasses.clean_yield, 4);
	// The child contract matches key and value too.
	const childEvents = (text) => [
		{ type: "session", cwd: WORK },
		{
			type: "custom",
			customType: "pi-subagents_launch_metadata",
			data: { agent: roles[0] },
		},
		{
			type: "message",
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{
						type: "toolCall",
						id: "t1",
						name: "read",
						arguments: { path: "recon/area-1.md" },
					},
				],
			},
		},
		{
			type: "message",
			message: { role: "toolResult", toolCallId: "t1", content: [] },
		},
		assistant("stop", text),
	];
	const contract = recon.childResults[roles[0]];
	assert.deepEqual(
		childFulfils(childEvents(`FACT-2: ${facts["FACT-1"]}`), contract, WORK),
		{ read: true, returned: false },
	);
	assert.deepEqual(
		childFulfils(childEvents(`FACT-1: ${facts["FACT-1"]}`), contract, WORK),
		{ read: true, returned: true },
	);
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
