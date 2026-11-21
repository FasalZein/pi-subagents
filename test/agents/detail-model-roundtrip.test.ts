import { getEffectiveAgentDefinitions } from "../../src/agents/definitions.ts";
import type { ModelRegistryLike } from "../../src/launch/child-launch-plan.ts";
import { getAgentListEntriesForTest, renderAgentDetailsForTest } from "../../src/testing/test-helpers.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	join,
	mkdirSync,
	resetSubagentStateForTest,
	writeFileSync,
} from "../support/index.ts";
import {
	HIGH_AT_MOST,
	type Launch,
	launch as launchAgent,
	NON_REASONING_BASE,
	type Parent,
	TWO_BASES,
} from "../support/pi-model-run.ts";

/**
 * T86 fix round 1: the default model in subagent_agents detail round-trips.
 * Reference: test/support/pi-model-run.ts. A shown ref
 * must run on the same model at the same level as a launch without a model;
 * otherwise the detail must say what happens instead. Synthetic refs only.
 */

async function launch(dir: string, registry: ModelRegistryLike, parent: Parent, model?: string): Promise<Launch> {
	const [definition] = getEffectiveAgentDefinitions(dir);
	return launchAgent(definition, dir, registry, parent, model);
}

function detailOf(frontmatter: string, registry: ModelRegistryLike, parent: Parent): { dir: string; lines: string[] } {
	const dir = createTestDir();
	const agentsDir = join(dir, "agent-root", "agents");
	mkdirSync(agentsDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent-root");
	writeFileSync(join(agentsDir, "picker.md"), `---\nname: picker\ndescription: Picks\n${frontmatter}\n---\n\nBody.`);
	const detail = renderAgentDetailsForTest(getAgentListEntriesForTest(dir), {
		parentModel: { registry, ref: parent.ref, thinking: parent.thinking },
	});
	return { dir, lines: detail.split("\n") };
}

const line = (lines: string[], prefix: string) => lines.find((text) => text.startsWith(prefix)) ?? "";

/**
 * The round-trip property: a plain `default model: <ref>` line runs like a
 * launch without a model; every other default line states why none does, and
 * that statement holds. Every ref on a plain models line is accepted.
 */
async function assertDetailTruth(frontmatter: string, registry: ModelRegistryLike, parent: Parent) {
	const { dir, lines } = detailOf(frontmatter, registry, parent);
	const defaultLine = line(lines, "default model: ");
	const implicit = await launch(dir, registry, parent);
	const plain = /^default model: (\S+)$/.exec(defaultLine)?.[1];
	if (plain) {
		assert.ok("run" in implicit && "ref" in implicit.run, `a launch without a model runs: ${JSON.stringify(implicit)}`);
		assert.deepEqual(await launch(dir, registry, parent, plain), implicit, `launch of the shown ${plain}`);
	} else if (defaultLine.includes("a launch without a model fails")) {
		assert.ok("refused" in implicit || "error" in implicit.run, `${defaultLine}: ${JSON.stringify(implicit)}`);
	} else {
		const runs =
			/^default model: (\S+) at level (\S+) \(a launch without a model runs on it; a call that names it /.exec(
				defaultLine,
			);
		assert.ok(runs, `unexpected default line: ${defaultLine}`);
		assert.deepEqual(implicit, { run: { ref: runs[1], level: runs[2] } });
		for (const ref of [runs[1], `${runs[1]}:${runs[2]}`])
			assert.notDeepEqual(await launch(dir, registry, parent, ref), implicit, `${ref} runs the same way`);
	}
	const models = line(lines, "models: ");
	if (!/^models: [^ ]+: /.test(models) && !models.startsWith("models: configured ")) return { defaultLine, models };
	const usable = /^models: configured (.*), none usable/.exec(models);
	const refs = (usable?.[1] ?? models.slice("models: ".length)).split("; ").flatMap((group) => {
		const [provider, names] = group.split(": ");
		return names.split(", ").map((name) => `${provider}/${name}`);
	});
	for (const ref of refs) {
		const result = await launch(dir, registry, parent, ref);
		if (usable) assert.ok("refused" in result, `${ref} is listed as not usable`);
		else assert.ok("run" in result && "ref" in result.run, `${ref} is listed as usable: ${JSON.stringify(result)}`);
	}
	return { defaultLine, models };
}

describe("the default model in the detail round-trips through Pi (T86, D22)", () => {
	afterEach(() => resetSubagentStateForTest());
	const PARENT_A = { ref: "a/parent", thinking: "high" };

	it("bare non-reasoning default with an accepted list", async () => {
		const shown = await assertDetailTruth("model: base\nallowed-models: other/x", NON_REASONING_BASE, PARENT_A);
		assert.equal(shown.defaultLine, "default model: a/base");
	});

	it("bare non-reasoning default without an accepted list", async () => {
		const shown = await assertDetailTruth("model: base", NON_REASONING_BASE, PARENT_A);
		assert.equal(shown.defaultLine, "default model: a/base");
	});

	it("qualified non-reasoning default, inherited high, accepted list: no ref runs the same way (review P1)", async () => {
		const shown = await assertDetailTruth("model: a/base\nallowed-models: other/x", NON_REASONING_BASE, PARENT_A);
		assert.match(shown.defaultLine, /^default model: a\/base at level off \(/);
		assert.equal(shown.models, "models: other: x");
	});

	it("bare default at two providers, accepted list, parent on one: the parent's provider", async () => {
		const shown = await assertDetailTruth("model: base\nallowed-models: other/x", TWO_BASES, PARENT_A);
		assert.equal(shown.defaultLine, "default model: a/base:high");
	});

	for (const [label, frontmatter, parent] of [
		["without a level", "model: base", { ref: "a/parent" }],
		["with a level", "model: base\nthinking: high", PARENT_A],
		["parent on neither provider", "model: base", { ref: "c/parent", thinking: "high" }],
	] as const) {
		it(`bare default at two providers without an accepted list, ${label}: Pi refuses it (review P1)`, async () => {
			const shown = await assertDetailTruth(frontmatter, TWO_BASES, parent);
			assert.match(shown.defaultLine, /a launch without a model fails/);
		});
	}

	it("bare default at two providers, accepted list, parent on neither: no override is usable (review P2)", async () => {
		const shown = await assertDetailTruth("model: base\nallowed-models: other/x", TWO_BASES, {
			ref: "c/parent",
			thinking: "high",
		});
		assert.match(shown.defaultLine, /a launch without a model fails/);
		assert.match(shown.models, /^models: configured other: x, none usable/);
	});

	it("reasoning default with inherited xhigh shows the level Pi clamps to (review P2)", async () => {
		const shown = await assertDetailTruth("model: a/think", HIGH_AT_MOST, { ref: "a/think", thinking: "xhigh" });
		assert.equal(shown.defaultLine, "default model: a/think:high");
	});
});
