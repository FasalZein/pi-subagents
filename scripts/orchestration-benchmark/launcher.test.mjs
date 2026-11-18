// Run: node --test scripts/orchestration-benchmark/launcher.test.mjs
// Checks of ownership, credentials, cleanup and attempt classification. No model, no Pi.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import { classifyAttempt, observe } from "./attempt.mjs";
import { acquireClaim, holdsClaim, releaseClaim } from "./claim.mjs";
import { answerParser } from "./record.mjs";
import { assertPrivateCheckout, checkoutState } from "./run-state.mjs";
import {
	createAttemptRoot,
	recoverAbandonedRoots,
	selectProviderAuth,
	selectProviderModels,
	settingsFingerprint,
} from "./sample-home.mjs";
import recon from "./scenarios/recon/scenario.mjs";
import { classifySessions, parseJsonlStrict } from "./session-evidence.mjs";

// Every folder of this file lives below one private scratch base, removed at the end.
// The shared benchmark base is never touched.
const scratchBase = mkdtempSync(join(tmpdir(), "bench-test-"));
after(() => rmSync(scratchBase, { recursive: true, force: true }));
const scratch = () => mkdtempSync(join(scratchBase, "s-"));
const ALIVE = { pid: 1, start: "alive" };
const DEAD = { pid: 2, start: "dead" };
const alive = (identity) => identity.start === "alive";

test("[F4] two jobs for one key: only one holds the claim; a release never frees the other job's claim", () => {
	const marker = join(scratch(), "s.json.claim");
	const a = acquireClaim(marker, { identity: ALIVE, alive });
	const b = acquireClaim(marker, { identity: ALIVE, alive });
	assert.ok("token" in a);
	assert.match(b.busy, /another job holds/);
	assert.equal(releaseClaim(marker, "not-a-token"), false);
	assert.equal(holdsClaim(marker, a.token), true);
	assert.equal(releaseClaim(marker, a.token), true);
	assert.equal(existsSync(marker), false);
});

test("[F4] a claim of a dead job is taken over once; a second taker is refused", () => {
	const marker = join(scratch(), "s.json.claim");
	acquireClaim(marker, { identity: DEAD, alive });
	const taker = acquireClaim(marker, { identity: ALIVE, alive });
	assert.ok("token" in taker);
	assert.ok("busy" in acquireClaim(marker, { identity: ALIVE, alive }));
	assert.equal(holdsClaim(marker, taker.token), true);
});

test("[F1] only the requested provider enters a sample; an OAuth refresh token is blanked", () => {
	const now = 1_000;
	const auth = {
		wanted: {
			type: "oauth",
			access: "A",
			refresh: "R",
			expires: now + 3_600_000,
		},
		other: { type: "oauth", access: "B", refresh: "S", expires: 0 },
	};
	const picked = selectProviderAuth(auth, "wanted", now, 1_800_000);
	assert.deepEqual(Object.keys(picked), ["wanted"]);
	assert.equal(picked.wanted.refresh, "");
	assert.equal(picked.wanted.access, "A");
	assert.throws(
		() => selectProviderAuth(auth, "wanted", now + 3_000_000, 1_800_000),
		/expires within/,
	);
	assert.throws(() => selectProviderAuth(auth, "missing", now, 0), /no entry/);
	assert.deepEqual(
		selectProviderModels(
			{ providers: { wanted: { baseUrl: "u" }, other: { baseUrl: "v" } } },
			"wanted",
		),
		{
			providers: { wanted: { baseUrl: "u" } },
		},
	);
});

test("[disclosure] the settings fingerprint is a digest plus safe identifiers; no configuration value appears", () => {
	const entry = (baseUrl, header) => ({
		providers: {
			p: {
				baseUrl,
				apiKey: "k-secret",
				headers: { "x-route": header },
				models: [{ id: "m", maxTokens: 7 }],
			},
		},
	});
	const cli = { model: "p/m", thinking: "high" };
	const fingerprint = settingsFingerprint(
		entry("https://h/path?token=SECRET", "r1"),
		cli,
	);
	assert.deepEqual(Object.keys(fingerprint).sort(), [
		"digest",
		"modelId",
		"provider",
		"thinking",
	]);
	assert.deepEqual(
		{ ...fingerprint, digest: undefined },
		{ provider: "p", modelId: "m", thinking: "high", digest: undefined },
	);
	assert.match(fingerprint.digest, /^[0-9a-f]{64}$/);
	for (const value of ["SECRET", "https://h", "k-secret", "r1", "maxTokens"])
		assert.equal(JSON.stringify(fingerprint).includes(value), false);
	// Any change of the effective settings, a routing header included, changes the digest.
	assert.notEqual(
		settingsFingerprint(entry("https://h/path?token=SECRET", "r2"), cli).digest,
		fingerprint.digest,
	);
});

test("[F2][F3] recovery removes only tagged roots of dead owners inside the private base", () => {
	const base = scratch();
	const dead = createAttemptRoot(base);
	writeFileSync(
		join(dead, "bench-owner.json"),
		JSON.stringify({
			tag: "pi-orchestration-benchmark",
			owner: { pid: 999_999, start: "gone" },
		}),
	);
	const live = createAttemptRoot(base);
	const foreign = mkdtempSync(join(base, "x-"));
	writeFileSync(join(foreign, "keep.txt"), "not ours");
	const stopped = [];
	const removed = recoverAbandonedRoots((socket) => stopped.push(socket), base);
	assert.equal(existsSync(dead), false);
	assert.equal(existsSync(live), true);
	assert.equal(existsSync(foreign), true);
	assert.deepEqual(stopped, [join(dead, "tmux.sock")]);
	assert.deepEqual(removed, [basename(dead)]);
});

test("[F8] malformed lines are counted; a fork copy without a probe is not taken for the parent", () => {
	assert.equal(parseJsonlStrict('{"a":1}\n{half\n').malformed, 1);
	const prompt = { type: "message", message: { role: "user", content: "go" } };
	const reply = {
		type: "message",
		message: { role: "assistant", stopReason: "stop", content: [] },
	};
	const sessions = [
		{ file: "/r/fork.jsonl", events: [prompt, reply] },
		{ file: "/r/parent.jsonl", events: [prompt, reply] },
	];
	const result = classifySessions(sessions, [
		{ sessionFile: "/r/parent.jsonl", agent: null },
	]);
	assert.equal(result.parent.file, "/r/parent.jsonl");
	assert.deepEqual(result.unattributed, ["/r/fork.jsonl"]);
});

const u = (input, cost) => ({
	input,
	cacheRead: 0,
	cacheWrite: 0,
	output: 1,
	cost: { total: cost },
});
const reply = (stopReason, text, toolCalls = []) => ({
	type: "message",
	message: {
		role: "assistant",
		stopReason,
		usage: u(10, 0.01),
		content: [
			{ type: "text", text },
			...toolCalls.map((name) => ({ type: "toolCall", name })),
		],
	},
});
const CODE = "lantern-9";
const readCall = (path) => ({
	type: "message",
	message: {
		role: "assistant",
		stopReason: "toolUse",
		usage: u(10, 0.01),
		content: [
			{ type: "toolCall", id: "t1", name: "read", arguments: { path } },
		],
	},
});
const toolResult = (toolName, isError = false, details = undefined) => ({
	type: "message",
	message: {
		role: "toolResult",
		toolCallId: "t1",
		toolName,
		isError,
		content: [],
		details,
	},
});
// The child's working folder: the fixture copy. A read path resolves against it.
const WORK = "/r/work";
const RUN = "run-1";
const childSession = (
	stopReasons,
	{ text = `CODE WORD: ${CODE}`, read = "note.txt" } = {},
) => ({
	file: "/r/c.jsonl",
	events: [
		{ type: "session", cwd: WORK },
		{
			type: "custom",
			customType: "pi-subagents_launch_metadata",
			data: { agent: "reader", name: "reader-1" },
		},
		...(read ? [readCall(read), toolResult("read")] : []),
		...stopReasons.map((s) => reply(s, text)),
	],
});
const delivery = (text, runId = RUN) => ({
	type: "custom_message",
	customType: "subagent_result",
	content: text,
	details: { id: runId },
});
const CLI = { checkout: "/c", model: "p/m", thinking: "high" };
const SCENARIO = {
	expectedAnswer: CODE,
	expectedChildRoles: ["reader"],
	childResults: { reader: { returns: CODE, reads: ["note.txt"] } },
	parentToolAllowlist: ["subagent"],
	parentLoadTool: "subagent",
	childLoadTool: "subagent_done",
};
const probes = [
	{
		sessionFile: "/r/p.jsonl",
		agent: null,
		model: "p/m",
		thinking: "high",
		tools: [{ name: "subagent", path: "/c/src/index.ts" }],
	},
	{
		sessionFile: "/r/c.jsonl",
		agent: "reader",
		model: "p/m",
		thinking: "high",
		tools: [{ name: "subagent_done", path: "/c/src/d.ts" }],
	},
];
const parentEvents = (delivered = `CODE WORD: ${CODE}`, runId = RUN) => [
	reply("toolUse", "", ["subagent"]),
	toolResult("subagent", false, {
		status: "started",
		children: [
			{ id: RUN, name: "reader-1" },
			{ id: "run-2", name: "reader-2" },
		],
	}),
	...(delivered ? [delivery(delivered, runId)] : []),
	reply("stop", `ANSWER: ${CODE}`),
];
const evidence = (child, extra = {}) => ({
	parent: { file: "/r/p.jsonl", events: parentEvents() },
	children: child ? [child] : [],
	unattributed: [],
	others: [],
	parentProbes: 1,
	probes,
	malformed: 0,
	...extra,
});
const classify = (ev, observed = { kind: "answered", answer: CODE }) =>
	classifyAttempt({
		observed,
		evidence: ev,
		cli: CLI,
		scenario: SCENARIO,
		checkoutChanged: false,
		workDir: WORK,
	});

test("[F6][F7] classification: pass needs the child; missing load proof is infra", () => {
	assert.equal(classify(evidence(childSession(["stop"]))).verdict, "pass");
	assert.equal(
		classify(evidence(childSession(["stop"]), { probes: [probes[0]] }))
			.infraReason,
		"load probe missing",
	);
	assert.equal(
		classify(evidence(childSession(["stop"]), { malformed: 1 })).infraReason,
		"malformed session lines",
	);
});

test("[F6] a pass needs the child's own result, from its read of the fixture, delivered to the parent", () => {
	const verdict = (child, events = parentEvents()) =>
		classify(evidence(child, { parent: { file: "/r/p.jsonl", events } }))
			.verdict;
	// The child returns a wrong answer; the parent still answers right.
	assert.equal(
		verdict(
			childSession(["stop"], { text: "CODE WORD: x" }),
			parentEvents("CODE WORD: x"),
		),
		"wrong-delegation",
	);
	// The child never read the fixture, or read another file.
	assert.equal(
		verdict(childSession(["stop"], { read: null })),
		"wrong-delegation",
	);
	assert.equal(
		verdict(childSession(["stop"], { read: "other.txt" })),
		"wrong-delegation",
	);
	// The child's right result never reached the parent.
	assert.equal(
		verdict(childSession(["stop"]), parentEvents(null)),
		"wrong-delegation",
	);
	// It reached the parent only after the parent's answer.
	assert.equal(
		verdict(childSession(["stop"]), [
			...parentEvents(null),
			delivery(`CODE WORD: ${CODE}`),
		]),
		"wrong-delegation",
	);
	assert.equal(verdict(childSession(["stop"])), "pass");
});

test("[review] a read counts only for the fixture path, not for a file of the same name elsewhere", () => {
	const verdict = (read) =>
		classify(evidence(childSession(["stop"], { read }))).verdict;
	assert.equal(verdict("/etc/note.txt"), "wrong-delegation");
	assert.equal(verdict("archive/note.txt"), "wrong-delegation");
	assert.equal(verdict("../note.txt"), "wrong-delegation");
	assert.equal(verdict(`${WORK}/note.txt`), "pass");
	assert.equal(verdict("./note.txt"), "pass");
	// Pi strips a leading @ from a read path; the decoy stays rejected.
	assert.equal(verdict("@note.txt"), "pass");
	assert.equal(verdict("@archive/note.txt"), "wrong-delegation");
});

test("[review] a delivered result counts only when it carries the child's own run id", () => {
	const verdict = (events) =>
		classify(
			evidence(childSession(["stop"]), {
				parent: { file: "/r/p.jsonl", events },
			}),
		).verdict;
	// The right text arrives, but bound to another run: not this child's handover.
	assert.equal(
		verdict(parentEvents(`CODE WORD: ${CODE}`, "run-2")),
		"wrong-delegation",
	);
	assert.equal(verdict(parentEvents(`CODE WORD: ${CODE}`, undefined)), "pass");
});

test("[F6] the expected result matches as a whole token, not as a substring", () => {
	const verdict = (text, answer = CODE) =>
		classify(
			evidence(childSession(["stop"], { text }), {
				parent: { file: "/r/p.jsonl", events: parentEvents(text) },
			}),
			{ kind: "answered", answer },
		).verdict;
	// A longer word or number that starts with the expected result fails.
	assert.equal(verdict(`CODE WORD: ${CODE}0`), "wrong-delegation");
	assert.equal(verdict(`CODE WORD: x${CODE}`), "wrong-delegation");
	assert.equal(verdict(`CODE WORD: ${CODE}-b`), "wrong-delegation");
	// The parent's final answer must equal the expected answer.
	assert.equal(verdict(`CODE WORD: ${CODE}`, `${CODE}0`), "wrong-answer");
	// The exact word passes, also inside a sentence with punctuation.
	assert.equal(verdict(CODE), "pass");
	assert.equal(verdict(`The code word is "${CODE}", as read.`), "pass");
	assert.equal(verdict(`Found it (${CODE}).`), "pass");
});

test("[F8] probes and session files match one to one: either side alone is infra, not a verdict", () => {
	// A launched child has a probe, but its session file is absent.
	assert.deepEqual(
		[classify(evidence(null)).kind, classify(evidence(null)).infraReason],
		["infra", "probe without its session file"],
	);
	// A probe names a session file outside the attempt root.
	const outside = [
		probes[0],
		probes[1],
		{ ...probes[1], sessionFile: "/x/c.jsonl" },
	];
	assert.equal(
		classify(evidence(childSession(["stop"]), { probes: outside })).infraReason,
		"probe without its session file",
	);
	// Two probes claim one session file.
	assert.equal(
		classify(
			evidence(childSession(["stop"]), { probes: [...probes, probes[1]] }),
		).infraReason,
		"probe without its session file",
	);
	// A child session file without its probe.
	assert.equal(
		classify(evidence(childSession(["stop"]), { probes: [probes[0]] }))
			.infraReason,
		"load probe missing",
	);
});

test("[F8] every session file enters the join: an empty or header-only file without a probe is infra", () => {
	const parentSession = { file: "/r/p.jsonl", events: parentEvents() };
	for (const events of [[{ type: "session", id: "s" }], []]) {
		const sessions = [
			parentSession,
			childSession(["stop"]),
			{ file: "/r/extra.jsonl", events },
		];
		const classified = classifySessions(sessions, probes);
		const result = classify({ ...evidence(null), ...classified, probes });
		assert.deepEqual(
			[result.kind, result.infraReason, result.load.missingProbes],
			["infra", "load probe missing", 1],
		);
	}
});

test("[guard] two launched children with one launch name end the attempt as infra", () => {
	const events = parentEvents();
	events[1] = toolResult("subagent", false, {
		status: "started",
		children: [
			{ id: RUN, name: "reader-1" },
			{ id: "run-2", name: "reader-1" },
		],
	});
	const result = classify(
		evidence(childSession(["stop"]), {
			parent: { file: "/r/p.jsonl", events },
		}),
	);
	assert.deepEqual(
		[result.kind, result.infraReason],
		["infra", "two launched children share a launch name"],
	);
});

test("[F11] a child provider error makes the attempt a counted provider error", () => {
	assert.equal(
		classify(evidence(childSession(["error", "stop"]))).kind,
		"provider-error",
	);
});

test("[F13] a model or thinking level other than the request is infra, not a measured result", () => {
	const clamped = [{ ...probes[0], thinking: "medium" }, probes[1]];
	assert.equal(
		classify(evidence(childSession(["stop"]), { probes: clamped })).infraReason,
		"model or thinking differs from the request",
	);
});

test("[F10] attempt metrics keep requests and child cost of the attempt", () => {
	const result = classify(evidence(childSession(["error", "stop"])));
	assert.equal(result.parent.all.requests, 2);
	// Three child requests: the read call, the error and the final reply.
	assert.equal(result.children.cost, 0.03);
	assert.equal(result.children.errorRequests, 1);
});

test("[F5] attempt results carry no message text", () => {
	const result = classify(evidence(childSession(["stop"])));
	assert.equal(JSON.stringify(result).includes("ANSWER"), false);
});

test("[F12] the deadline counts from submission and wins over a late answer", async () => {
	const root = scratch();
	const parentFile = join(root, "p.jsonl");
	writeFileSync(parentFile, `${JSON.stringify(reply("stop", "ANSWER: w"))}\n`);
	const parent = { socket: join(root, "none.sock"), paneId: "%0" };
	const deadlineMs = 600_000;
	const late = await observe({
		parent,
		parentFile,
		root,
		submittedAt: Date.now() - deadlineMs - 1,
		deadlineMs,
	});
	assert.deepEqual(late, { kind: "verdict", verdict: "timeout" });
	// The settle window passes on an injected clock; the pane counts as alive.
	let now = Date.now();
	const inTime = await observe({
		parent,
		parentFile,
		root,
		submittedAt: now,
		deadlineMs,
		clock: {
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
			alive: () => true,
		},
	});
	assert.deepEqual(inTime, { kind: "answered", answer: "w", answeredAt: 0 });
});

test("[premature] a waiting parent stays under observation while a launched child has not ended", async () => {
	const root = scratch();
	const probeDir = join(root, "probes");
	mkdirSync(probeDir);
	const parentFile = join(root, "p.jsonl");
	const childFile = join(root, "c.jsonl");
	const jsonl = (events) =>
		`${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
	// The async parent launched one child and yielded with a terminal reply.
	writeFileSync(
		parentFile,
		jsonl([
			reply("toolUse", "", ["subagent"]),
			toolResult("subagent"),
			reply("stop", "Waiting for the child."),
		]),
	);
	// The child started (probe and launch marker) but is in a slow request.
	writeFileSync(
		join(probeDir, "c.json"),
		JSON.stringify({ sessionFile: childFile, agent: "reader" }),
	);
	writeFileSync(childFile, jsonl(childSession([]).events));
	const fakeClock = () => {
		let now = Date.now();
		return {
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
			alive: () => true,
		};
	};
	const run = (clock) =>
		observe({
			parent: {},
			parentFile,
			root,
			probeDir,
			submittedAt: clock.now(),
			deadlineMs: 600_000,
			clock,
		});
	// 60 s of silence while the child is pending: no verdict before the deadline.
	assert.deepEqual(await run(fakeClock()), {
		kind: "verdict",
		verdict: "timeout",
	});
	// Once the child has ended, the quiet rule applies again.
	writeFileSync(childFile, jsonl(childSession(["stop"]).events));
	assert.deepEqual(await run(fakeClock()), {
		kind: "answered",
		answer: null,
		answeredAt: 2,
	});
});

const observeRecon = async ({ full, deadlineMs = 600_000 }) => {
	const root = scratch();
	const probeDir = join(root, "probes");
	mkdirSync(probeDir);
	const parentFile = join(root, "p.jsonl");
	const jsonl = (events) =>
		`${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
	const facts = recon.expectedFacts;
	const line = (key) => `${key}: ${facts[key]}`;
	const launched = [
		reply("toolUse", "", ["subagent"]),
		toolResult("subagent", false, { status: "started", children: [] }),
	];
	const writeChildren = (ended) => {
		for (let i = 1; i <= 6; i++) {
			const file = join(root, `c${i}.jsonl`);
			writeFileSync(
				join(probeDir, `c${i}.json`),
				JSON.stringify({ sessionFile: file, agent: `bench-recon-${i}` }),
			);
			writeFileSync(
				file,
				jsonl(childSession(i <= ended ? ["stop"] : []).events),
			);
		}
	};
	// The first child delivered; the waiting parent printed one keyed fact and stopped its turn.
	writeChildren(1);
	const partial = [...launched, reply("stop", line("FACT-1"))];
	const carriers = [2, 3, 4, 5, 6].map((i) => ({
		type: "custom_message",
		customType: "subagent_result",
		content: line(`FACT-${i}`),
		details: { id: `run-${i}` },
	}));
	writeFileSync(parentFile, jsonl(partial));
	let now = Date.now();
	let sleeps = 0;
	const clock = {
		now: () => now,
		sleep: async (ms) => {
			now += ms;
			sleeps += 1;
			// The remaining five children end and their carriers arrive; the parent's
			// model request for them stays silent longer than the quiet window.
			if (sleeps === 20) {
				writeChildren(6);
				writeFileSync(parentFile, jsonl([...partial, ...carriers]));
			}
			// Then the parent replies with all seven keys.
			if (sleeps === 40 && full)
				writeFileSync(
					parentFile,
					jsonl([
						...partial,
						...carriers,
						reply("stop", Object.keys(facts).map(line).join("\n")),
					]),
				);
		},
		alive: () => true,
	};
	return observe({
		parent: {},
		parentFile,
		root,
		probeDir,
		submittedAt: now,
		deadlineMs,
		parseAnswer: answerParser(recon),
		clock,
	});
};

test("[T02b-1] a partial progress reply does not end observation; the final settled reply is scored", async () => {
	// Entries: launch call, launch result, partial reply, 5 carriers, full reply at index 8.
	assert.deepEqual(await observeRecon({ full: true }), {
		kind: "answered",
		answer: recon.expectedFacts,
		answeredAt: 8,
	});
});

test("[T02b-1] a parent that never replies after its last carrier runs to the deadline", async () => {
	assert.deepEqual(await observeRecon({ full: false, deadlineMs: 120_000 }), {
		kind: "verdict",
		verdict: "timeout",
	});
});

test("[F14] a checkout with an untracked file is refused", () => {
	const repo = scratch();
	const git = (...args) =>
		execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
	git("init", "-q");
	writeFileSync(join(repo, "a.ts"), "x");
	git("add", ".");
	git("-c", "user.email=b@b", "-c", "user.name=b", "commit", "-qm", "a");
	assert.ok(checkoutState(repo).commit);
	writeFileSync(join(repo, "new-module.ts"), "y");
	assert.throws(() => checkoutState(repo), /untracked/);
});

test("[guard] only a clean linked worktree with a detached HEAD is measured", () => {
	const repo = scratch();
	const git = (...args) =>
		execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
	git("init", "-q");
	writeFileSync(join(repo, "a.ts"), "x");
	git("add", ".");
	git("-c", "user.email=b@b", "-c", "user.name=b", "commit", "-qm", "a");
	assert.throws(() => assertPrivateCheckout(repo), /linked worktree/);
	const branchTree = join(scratch(), "b");
	git("worktree", "add", "-q", "-b", "side", branchTree);
	assert.throws(() => assertPrivateCheckout(branchTree), /detached HEAD/);
	const detached = join(scratch(), "d");
	git("worktree", "add", "-q", "--detach", detached);
	assert.ok(assertPrivateCheckout(detached).commit);
	writeFileSync(join(detached, "new.ts"), "y");
	assert.throws(() => assertPrivateCheckout(detached), /untracked/);
});
