#!/usr/bin/env node
/**
 * Agent fixture for the fixed-cost probe (G1.1, G1.2): a sanitized copy of the
 * owner's agent definitions, frozen with the harness (harnessHash covers agent-fixture/).
 *
 *   node scripts/orchestration-benchmark/freeze-agents.mjs freeze [<agents dir>]
 *   node scripts/orchestration-benchmark/freeze-agents.mjs check [<agents dir>]
 *
 * The default source is ~/.pi/agent/agents. freeze rewrites agent-fixture/;
 * check compares the fixture's shape to the source and exits 1 on a difference.
 * Kept: the file count, key order, each description length, every other flag value,
 * each list size of model, allowed-models and extensions, the number of distinct model
 * choices the agent list renders, the env line count and the body length.
 * Replaced: descriptions and bodies by synthetic text of the same length, model refs by
 * synthetic/model-<n>, one n per distinct base model in a file (thinking suffix kept),
 * extension sources and env lines by
 * synthetic entries. Other flag values are copied verbatim; the privacy check in
 * freeze-agents.test.mjs guards them against home paths and provider refs.
 *
 * Known limits:
 * - A refreeze copies inline env values, unknown fields and leading comments verbatim; the
 *   shape check does not detect a private value there. Revisit before a refreeze of a changed agent set.
 * - freeze deletes the old fixture before it reads every source file; a missing or malformed
 *   source leaves a partial fixture. Revisit if a refreeze fails.
 */
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const FIXTURE_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"agent-fixture",
);
const LISTS = ["model", "allowed-models", "extensions"];
const THINKING = /:[a-z]+$/;

/** Frontmatter entries in order: key, the text after "key:", continuation lines; and the body. */
export function parseAgent(text) {
	const lines = text.split("\n");
	if (lines[0] !== "---") throw new Error("agent file must start with ---");
	const end = lines.indexOf("---", 1);
	if (end < 0) throw new Error("agent file has no closing ---");
	const entries = [];
	const lead = [];
	for (const line of lines.slice(1, end)) {
		const match = line.match(/^([a-z][\w-]*):(.*)$/);
		if (match) entries.push({ key: match[1], value: match[2], more: [] });
		else if (entries.length) entries.at(-1).more.push(line);
		else lead.push(line);
	}
	return { lead, entries, body: lines.slice(end + 1).join("\n") };
}

const items = (value) =>
	value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

/** Synthetic text of exactly n characters, with no colon and no trailing space. */
export function filler(n, seed = "synthetic text") {
	const text = `${seed} `.repeat(Math.ceil(n / (seed.length + 1))).slice(0, n);
	return text.endsWith(" ") ? `${text.slice(0, -1)}x` : text;
}

/** The shape the probe depends on; equal for a source file and its sanitized copy. */
export function agentShape(text) {
	const { entries, body } = parseAgent(text);
	const shape = { keys: entries.map((e) => e.key), sizes: {}, flags: {} };
	for (const { key, value, more } of entries) {
		if (key === "description") shape.descriptionLength = value.trim().length;
		else if (LISTS.includes(key)) shape.sizes[key] = items(value).length;
		else if (key === "env")
			shape.sizes.env = more.filter((line) => line.trim()).length;
		else shape.flags[key] = [value.trim(), ...more].join("\n");
	}
	shape.choices = modelChoices(entries);
	shape.bodyLength = body.length;
	return shape;
}

/**
 * The model choices the agent list renders: the default ref (model plus the thinking
 * flag unless the model has a suffix) and allowed-models, after duplicate removal.
 * Mirrors renderModelsLine in src/agents/agent-list.ts.
 */
function modelChoices(entries) {
	const field = (key) => entries.find((e) => e.key === key)?.value.trim() ?? "";
	const model = field("model");
	const thinking = field("thinking");
	const fallback =
		model && !THINKING.test(model) && thinking ? `${model}:${thinking}` : model;
	return new Set([fallback, ...items(field("allowed-models"))].filter(Boolean))
		.size;
}

/** Synthetic refs for one file: one id per distinct base model across all model fields. */
function modelNamer() {
	const ids = new Map();
	return (ref) => {
		const suffix = ref.match(THINKING)?.[0] ?? "";
		const base = ref.slice(0, ref.length - suffix.length);
		if (!ids.has(base)) ids.set(base, ids.size + 1);
		return `synthetic/model-${ids.get(base)}${suffix}`;
	};
}

/** The sanitized copy of one agent file. */
export function sanitizeAgent(text) {
	const { lead, entries, body } = parseAgent(text);
	const synthModel = modelNamer();
	const out = entries.map(({ key, value, more }) => {
		if (key === "description")
			return [
				`description: ${filler(value.trim().length, "synthetic description")}`,
			];
		if (key === "model" || key === "allowed-models")
			return [`${key}: ${items(value).map(synthModel).join(", ")}`];
		if (key === "extensions")
			return [
				`extensions: ${items(value)
					.map((_, i) => `synthetic-extension-${i + 1}`)
					.join(", ")}`,
			];
		if (key === "env") {
			let n = 0;
			return [
				`env:${value}`,
				...more.map((line) =>
					line.trim() ? `  SYNTHETIC_VAR_${++n}=1` : line,
				),
			];
		}
		return [`${key}:${value}`, ...more];
	});
	return [
		"---",
		...lead,
		...out.flat(),
		"---",
		filler(body.length, "Synthetic agent body."),
	].join("\n");
}

const agentFiles = (dir) =>
	readdirSync(dir)
		.filter((name) => name.endsWith(".md"))
		.sort();

/** Differences between the fixture and a source folder, by file; empty when the shapes match. */
export function compareShapes(sourceDir, fixtureDir = FIXTURE_DIR) {
	const source = agentFiles(sourceDir);
	const fixture = agentFiles(join(fixtureDir, "agents"));
	const problems = [];
	if (JSON.stringify(source) !== JSON.stringify(fixture))
		problems.push(
			`files differ: source ${source.length}, fixture ${fixture.length}`,
		);
	for (const name of source.filter((n) => fixture.includes(n))) {
		const a = agentShape(readFileSync(join(sourceDir, name), "utf8"));
		const b = agentShape(
			readFileSync(join(fixtureDir, "agents", name), "utf8"),
		);
		if (JSON.stringify(a) !== JSON.stringify(b))
			problems.push(`${name}: shape differs`);
	}
	return problems;
}

function freeze(sourceDir) {
	const dir = join(FIXTURE_DIR, "agents");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const names = agentFiles(sourceDir);
	for (const name of names)
		writeFileSync(
			join(dir, name),
			sanitizeAgent(readFileSync(join(sourceDir, name), "utf8")),
		);
	const frozenOn = new Date().toISOString().slice(0, 10);
	writeFileSync(
		join(FIXTURE_DIR, "frozen.json"),
		`${JSON.stringify({ frozenOn, count: names.length }, null, "\t")}\n`,
	);
	return names.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [command, source = join(homedir(), ".pi", "agent", "agents")] =
		process.argv.slice(2);
	if (command === "freeze") console.log(`froze ${freeze(source)} agent files`);
	if (!["freeze", "check"].includes(command)) {
		console.error("usage: freeze-agents.mjs freeze|check [<agents dir>]");
		process.exit(2);
	}
	const problems = compareShapes(source);
	for (const problem of problems) console.log(problem);
	console.log(problems.length ? "shape check: FAIL" : "shape check: ok");
	process.exit(problems.length ? 1 : 0);
}
