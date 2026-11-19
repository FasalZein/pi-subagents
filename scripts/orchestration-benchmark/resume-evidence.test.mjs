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
import { answerParser, loadEvidence } from "./record.mjs";
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
function writeProbes(root) {
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
	const probes = [...files, ...resumed].map((sessionFile) => {
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

test("[T68] a resumed child is matched to its session: the sample settles and scores wrong-answer", async () => {
	const root = attemptRoot();
	const { probeDir, parentFile, resumed } = writeProbes(root);
	// The clock starts after the last file write, so only pending children can hold it.
	const start = Date.now() + 60_000;
	let now = start;
	const observed = await observe({
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

test("[T68] a second probe of the parent file or of a file that is no child's stays unmatched", () => {
	const probe = (sessionFile, agent) => ({
		sessionFile,
		agent,
		model: CLI.model,
		thinking: CLI.thinking,
		tools: [{ name: agent ? "caller_ping" : "subagent", path: "/c/src/index.ts" }],
	});
	const join = (probes) =>
		loadEvidence(probes, {
			parentFile: "/r/p.jsonl",
			childFiles: ["/r/c.jsonl"],
			otherFiles: ["/r/o.jsonl"],
			checkout: "/c",
			parentTool: "subagent",
			childTool: "caller_ping",
		});
	const base = [probe("/r/p.jsonl", null), probe("/r/c.jsonl", "a"), probe("/r/o.jsonl", "b")];
	assert.equal(join(base).unmatchedProbes, 1, "the other file is no child file");
	assert.equal(join([...base, probe("/r/c.jsonl", "a")]).unmatchedProbes, 1, "a resume of the child");
	assert.equal(join([...base, probe("/r/p.jsonl", null)]).unmatchedProbes, 2);
	assert.equal(join([...base, probe("/r/o.jsonl", "b")]).unmatchedProbes, 3);
	assert.deepEqual(join([...base, probe("/r/c.jsonl", "a")]).resumes, [
		{ agent: "a", model: CLI.model, thinking: CLI.thinking },
	]);
});
