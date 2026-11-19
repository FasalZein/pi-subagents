// Run: node --test scripts/orchestration-benchmark/resume-evidence.test.mjs
// T68: a parent that resumes a child (subagent_resume) starts a child process whose
// load probe names the existing child session file: a resume appends to it. The
// fixture is the kept diag-c3 recon rep 1 attempt (gpt-sol parent resumed recon-4
// and recon-3, then answered "FACT-7: Not found"), scrubbed of system prompts,
// reasoning, the temp root and model refs. The probes are rebuilt from the session
// facts, because --keep-sessions keeps no probe files.
import assert from "node:assert/strict";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { classifyAttempt, observe } from "./attempt.mjs";
import { answerParser, childEnded, loadEvidence, summarizeChild } from "./record.mjs";
import recon from "./scenarios/recon/scenario.mjs";
import { collectEvidence } from "./session-evidence.mjs";

const FIXTURE = new URL("./fixtures/recon-resume/", import.meta.url).pathname;
const CLI = { checkout: "/c", model: "p/m", thinking: "high" };
const LAUNCH_METADATA = "pi-subagents_launch_metadata";
const roots = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const parseJsonl = (file) =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

/** Copy the fixture to a private root, with $ROOT bound to that root. */
function attemptRoot() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "t68-resume-")));
	roots.push(root);
	cpSync(FIXTURE, root, { recursive: true });
	const bind = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) bind(path);
			else writeFileSync(path, readFileSync(path, "utf8").replaceAll("$ROOT", root));
		}
	};
	bind(root);
	return root;
}

/**
 * Probes as the launcher's load probe writes them: one per Pi process. The parent
 * and the six launched children have their own session files; each resume run the
 * parent started (subagent_resume tool results) names the session file it resumed.
 */
function writeProbes(root, { extra = [] } = {}) {
	const probeDir = join(root, "probes");
	mkdirSync(probeDir);
	const sessions = join(root, "sessions");
	const files = readdirSync(sessions).map((name) => join(sessions, name));
	const agentOf = (file) =>
		parseJsonl(file).find((e) => e.type === "custom" && e.customType === LAUNCH_METADATA)?.data.agent ?? null;
	const parentFile = files.find((file) => agentOf(file) === null);
	const resumed = parseJsonl(parentFile)
		.filter((e) => e.type === "message" && e.message.toolName === "subagent_resume")
		.map((e) => e.message.details.sessionFile);
	assert.equal(resumed.length, 2, "the fixture parent resumed two children");
	const probes = [...files, ...resumed, ...extra.map((name) => childFile(root, name))].map((sessionFile) => {
		const agent = agentOf(sessionFile);
		return {
			sessionFile,
			agent,
			model: CLI.model,
			thinking: CLI.thinking,
			tools: [{ name: agent ? "caller_ping" : "subagent", path: "/c/src/index.ts" }],
		};
	});
	for (const [pid, probe] of probes.entries()) writeFileSync(join(probeDir, `${pid + 1}.json`), JSON.stringify(probe));
	return { probeDir, parentFile, resumed };
}

/** The session file of the child launched under this name. */
function childFile(root, name) {
	const sessions = join(root, "sessions");
	return readdirSync(sessions)
		.map((file) => join(sessions, file))
		.find((file) => parseJsonl(file).some((e) => e.customType === LAUNCH_METADATA && e.data.name === name));
}

const writeJsonl = (file, events) => writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

/** Index of the child's first user message after its first run: the resumed task. */
const resumeTaskIndex = (events) =>
	events.findIndex((e, i) => i > events.findIndex((x) => x.message?.role === "user") && e.message?.role === "user");

/** Observe the attempt with a fake clock that starts after the last file write. */
function observeRoot(root, probeDir, parentFile) {
	const start = Date.now() + 60_000;
	let now = start;
	return observe({
		parent: {},
		parentFile,
		root,
		probeDir,
		submittedAt: start,
		deadlineMs: 30_000,
		parseAnswer: answerParser(recon),
		clock: {
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
			alive: () => true,
		},
	});
}

test("[T68] a resumed child is matched to its session: the sample settles and scores wrong-answer", async () => {
	const root = attemptRoot();
	const { probeDir, parentFile, resumed } = writeProbes(root);
	const observed = await observeRoot(root, probeDir, parentFile);
	assert.equal(observed.kind, "answered", "the observer settles before the deadline");
	// The reply says "FACT-7: Not found"; a value with a space is no keyed value, so
	// the parsed answer holds the six facts the children returned and no FACT-7.
	const { "FACT-7": _missing, ...six } = recon.expectedFacts;
	assert.deepEqual(observed.answer, six);
	const reply = parseJsonl(parentFile)[observed.answeredAt].message.content;
	assert.match(reply.map((part) => part.text ?? "").join(""), /^FACT-7: Not found$/m);
	const evidence = collectEvidence(root, probeDir);
	const result = classifyAttempt({
		observed,
		evidence,
		cli: CLI,
		scenario: recon,
		checkoutChanged: false,
		workDir: join(root, "workspace"),
	});
	assert.equal(result.infraReason, undefined);
	assert.equal(result.kind, "verdict");
	assert.equal(result.verdict, "wrong-answer");
	assert.equal(result.load.unmatchedProbes, 0);
	assert.equal(result.load.missingProbes, 0);
	// Requests of a resumed run count in that child's usage: every assistant entry
	// of the child session file after its launch marker, the resumed turn included.
	for (const file of resumed) {
		const events = parseJsonl(file);
		const name = events.find((e) => e.customType === LAUNCH_METADATA).data.name;
		const turns = events.filter((e) => e.type === "message" && e.message.role === "assistant").length;
		const child = result.children.children.find((c) => c.name === name);
		assert.equal(child.requests, turns, name);
	}
});

// Fix round 1, P1 stale completion: the first run's completion stays in the file
// while the resumed run works. Each resumed run is pending until a completion after
// its own resume boundary; the two resumed children of the fixture end separately.
for (const [label, name, keep] of [
	["recon-3 has its resumed task and no new completion", "recon-3", (events) => resumeTaskIndex(events) + 1],
	["recon-3 resumed process has no task yet", "recon-3", (events) => resumeTaskIndex(events)],
	["recon-4 has its resumed task and no new completion", "recon-4", (events) => resumeTaskIndex(events) + 1],
]) {
	test(`[T68] a resumed run without its own completion keeps the sample open: ${label}`, async () => {
		const root = attemptRoot();
		const file = childFile(root, name);
		const events = parseJsonl(file);
		writeJsonl(file, events.slice(0, keep(events)));
		const { probeDir, parentFile } = writeProbes(root);
		// The parent's final keyed reply is settled; only the open resumed run can hold it.
		assert.deepEqual(await observeRoot(root, probeDir, parentFile), { kind: "verdict", verdict: "timeout" });
	});
}

// Fix round 1, P1 fail-open duplicate: a second probe on a child file that no
// parent resume names is the F8 case (infra), not a resume.
test("[T68] an extra probe on a child file that no resume names stays infra", async () => {
	const root = attemptRoot();
	const { probeDir, parentFile } = writeProbes(root, { extra: ["recon-1"] });
	const observed = await observeRoot(root, probeDir, parentFile);
	const result = classifyAttempt({
		observed,
		evidence: collectEvidence(root, probeDir),
		cli: CLI,
		scenario: recon,
		checkoutChanged: false,
		workDir: join(root, "workspace"),
	});
	assert.equal(result.infraReason, "probe without its session file");
});

test("[T68] probe join: a resume probe needs a parent resume of that file; each resume needs its probe", () => {
	// Independent objects, as readProbes parses each probe file on its own.
	const probe = (sessionFile, agent) => ({
		sessionFile,
		agent,
		model: CLI.model,
		thinking: CLI.thinking,
		tools: [{ name: agent ? "caller_ping" : "subagent", path: "/c/src/index.ts" }],
	});
	const join = (probes, resumedFiles = []) =>
		loadEvidence(probes, {
			parentFile: "/r/p.jsonl",
			childFiles: ["/r/c.jsonl"],
			otherFiles: ["/r/o.jsonl"],
			checkout: "/c",
			parentTool: "subagent",
			childTool: "caller_ping",
			resumedFiles,
		});
	const base = [probe("/r/p.jsonl", null), probe("/r/c.jsonl", "a"), probe("/r/o.jsonl", "b")];
	const again = probe("/r/c.jsonl", "a");
	assert.equal(join(base).unmatchedProbes, 1, "the other file is no child file");
	assert.equal(join([...base, again]).unmatchedProbes, 2, "no resume names the child file");
	assert.equal(join([...base, again], ["/r/c.jsonl"]).unmatchedProbes, 1, "a resume of the child");
	assert.equal(
		join([...base, again, probe("/r/c.jsonl", "a")], ["/r/c.jsonl"]).unmatchedProbes,
		2,
		"one resume, two probes",
	);
	assert.equal(join([...base, probe("/r/p.jsonl", null)], ["/r/p.jsonl"]).unmatchedProbes, 2, "no parent resume");
	assert.equal(join([...base, probe("/r/o.jsonl", "b")], ["/r/o.jsonl"]).unmatchedProbes, 3, "no child file");
	assert.equal(join(base, ["/r/c.jsonl"]).missingProbes, 1, "a resume without its probe");
	assert.deepEqual(join([...base, again], ["/r/c.jsonl"]).resumes, [
		{ agent: "a", model: CLI.model, thinking: CLI.thinking },
	]);
});

// Fix round 1, P1 usage truncation: a resume with a model or thinking override
// appends a launch marker (modelSource "resume-override"). The child's own work
// still starts at its first launch marker of this attempt.
test("[T68] a resume marker does not cut the child's earlier requests, launch order or role", () => {
	const root = attemptRoot();
	const file = childFile(root, "recon-3");
	const events = parseJsonl(file);
	const launch = events.find((e) => e.customType === LAUNCH_METADATA);
	const at = resumeTaskIndex(events);
	const marker = {
		...launch,
		id: "resume-marker",
		timestamp: events[at].timestamp,
		data: { ...launch.data, modelSource: "resume-override", requestedThinkingOverride: "high" },
	};
	const withMarker = [...events.slice(0, at), marker, ...events.slice(at)];
	const before = summarizeChild(events);
	const after = summarizeChild(withMarker);
	assert.equal(before.requests, 4, "recon-3 made 4 requests: 2 at launch, 2 resumed");
	assert.deepEqual(
		[after.requests, after.cost, after.launchedAt, after.launchEntryId, after.role],
		[4, before.cost, launch.timestamp, launch.id, "bench-recon-3"],
	);
	assert.equal(childEnded(withMarker), true);
});
