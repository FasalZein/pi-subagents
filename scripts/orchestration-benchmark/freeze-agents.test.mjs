// Run: node --test scripts/orchestration-benchmark/freeze-agents.test.mjs
// The frozen agent fixture of the fixed-cost probe (G1.1, G1.2). No model, no Pi, no home folder.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	agentShape,
	FIXTURE_DIR,
	filler,
	sanitizeAgent,
} from "./freeze-agents.mjs";

// A synthetic stand-in for an owner file: home paths, a user name, provider refs, an env secret.
const SOURCE = [
	"---",
	"name: helper",
	"description: Look things up in /Users/someone/notes for the owner.",
	"extensions: git:github.com/someone/ext, ~/x/y.ts, /Users/someone/z",
	"env: |",
	"  SECRET_TOKEN=abc123",
	"  OTHER=1",
	"tools: read, bash",
	"model: realprov/big-model",
	"thinking: high",
	"allowed-models: realprov/big-model:high, other/small:low, third/mid",
	"visible-to: root, design",
	"enabled: true",
	"---",
	"Body that mentions someone and https://private.example/x.",
	"",
].join("\n");
const PRIVATE =
	/\/Users\/|someone|realprov\/|other\/|third\/|SECRET|abc123|https?:|~\//;

test("[T03a-5] sanitizing keeps the shape and drops every private value", () => {
	const copy = sanitizeAgent(SOURCE);
	assert.deepEqual(agentShape(copy), agentShape(SOURCE));
	assert.doesNotMatch(copy, PRIVATE);
	// The kept shape, from the source text above.
	const shape = agentShape(SOURCE);
	// "Look things up in /Users/someone/notes for the owner." has 53 characters.
	assert.equal(shape.descriptionLength, 53);
	assert.deepEqual(shape.sizes, {
		extensions: 3,
		env: 2,
		model: 1,
		"allowed-models": 3,
	});
	assert.equal(shape.flags["visible-to"], "root, design");
	assert.match(
		copy,
		/^allowed-models: synthetic\/model-1:high, synthetic\/model-2:low, synthetic\/model-3$/m,
	);
});

test("[T03a-6] the shape check fails on a changed description length or model-list size", () => {
	const longer = SOURCE.replace("for the owner", "for the owner today");
	assert.notDeepEqual(agentShape(sanitizeAgent(SOURCE)), agentShape(longer));
	const fewer = SOURCE.replace(", third/mid", "");
	assert.notDeepEqual(agentShape(sanitizeAgent(SOURCE)), agentShape(fewer));
	const flag = SOURCE.replace("enabled: true", "enabled: false");
	assert.notDeepEqual(agentShape(sanitizeAgent(SOURCE)), agentShape(flag));
});

test("[T03a-7] filler text has the exact length and no colon", () => {
	for (const n of [0, 1, 21, 22, 23, 500]) {
		assert.equal(filler(n).length, n);
		assert.doesNotMatch(filler(n), /:|\s$/);
	}
});

test("[T03a-8] the committed fixture holds 10 agents, its freeze date and only synthetic refs", () => {
	const frozen = JSON.parse(
		readFileSync(join(FIXTURE_DIR, "frozen.json"), "utf8"),
	);
	assert.deepEqual(frozen, { frozenOn: "2026-11-18", count: 10 });
	const dir = join(FIXTURE_DIR, "agents");
	const names = readdirSync(dir);
	assert.equal(names.length, frozen.count);
	for (const name of names) {
		const text = readFileSync(join(dir, name), "utf8");
		const shape = agentShape(text);
		assert.ok(shape.sizes["allowed-models"] > 0, name);
		for (const line of text
			.split("\n")
			.filter((l) => /^(model|allowed-models):/.test(l)))
			for (const ref of line.replace(/^[\w-]+:/, "").split(","))
				assert.match(ref.trim(), /^synthetic\/model-\d+(:[a-z]+)?$/, name);
		assert.doesNotMatch(
			text,
			/\/Users\/|~\/|https?:|github\.com|npm:|git:/,
			name,
		);
	}
});
