import { getEffectiveAgentDefinitions } from "../../src/agents/definitions.ts";
import { renderAgentIndexSection } from "../../src/agents/index-section.ts";
import { buildChildLaunchPlan, type ModelRegistryLike } from "../../src/launch/child-launch-plan.ts";
import { getPreparedSessionLaunchArgs } from "../../src/launch/prep.ts";
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

/**
 * T86: the index and the agent detail say what a launch does. Each check
 * compares the displayed text with the launch code for the same definition.
 */

function writeAgent(frontmatter: string): string {
	const dir = createTestDir();
	const agentsDir = join(dir, "agent-root", "agents");
	mkdirSync(agentsDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent-root");
	writeFileSync(join(agentsDir, "picker.md"), `---\nname: picker\ndescription: Picks\n${frontmatter}\n---\n\nBody.`);
	return dir;
}

describe("the session the index and detail show is the session the child gets (T86, D13)", () => {
	afterEach(() => resetSubagentStateForTest());

	const cases: Array<[string, string]> = [
		["in-memory fork", "session-mode: fork\nno-session: true"],
		["in-memory lineage-only", "session-mode: lineage-only\nno-session: true"],
		["strict wrap-up fork", "session-mode: fork\nno-session: true\ntimeout: 600\ntimeout-warn-threshold: 80%"],
		[
			"strict wrap-up lineage-only",
			"session-mode: lineage-only\nno-session: true\ntimeout: 600\ntimeout-warn-threshold: 80%",
		],
	];
	for (const [label, frontmatter] of cases) {
		it(label, () => {
			const dir = writeAgent(frontmatter);
			const [definition] = getEffectiveAgentDefinitions(dir);
			const args = getPreparedSessionLaunchArgs({ agentDefs: definition, subagentSessionFile: join(dir, "c.jsonl") });
			// Pi opens an empty in-memory session for --no-session and never reads the seeded file;
			// otherwise it continues the file, which a no-session launch seeds as a fork.
			const getsCopy = !args.includes("--no-session");
			assert.equal(getsCopy, label.startsWith("strict"), `D13: only a strict wrap-up keeps a transcript: ${args}`);
			const entries = getAgentListEntriesForTest(dir);
			const line = renderAgentIndexSection(entries, { paneAvailable: false, forcesWait: false })
				?.split("\n")
				.find((text) => text.startsWith("- picker:"));
			assert.equal(line?.includes("[fork]"), getsCopy, `index: ${line}`);
			const detail = renderAgentDetailsForTest(entries);
			assert.equal(detail.includes("session: copy of this chat"), getsCopy, detail);
		});
	}
});

const registryOf = (models: Array<{ provider: string; id: string; reasoning: boolean }>): ModelRegistryLike => ({
	getAvailable: () => models,
});
const NON_REASONING_BASE = registryOf([
	{ provider: "a", id: "base", reasoning: false },
	{ provider: "other", id: "x", reasoning: true },
]);
const TWO_BASES = registryOf([
	{ provider: "a", id: "base", reasoning: true },
	{ provider: "b", id: "base", reasoning: true },
	{ provider: "other", id: "x", reasoning: true },
]);
const PARENT = { ref: "a/parent", thinking: "high" };

function shownDefault(frontmatter: string, registry: ModelRegistryLike): { dir: string; shown?: string } {
	const dir = writeAgent(frontmatter);
	const detail = renderAgentDetailsForTest(getAgentListEntriesForTest(dir), { parentModel: { registry, ...PARENT } });
	return { dir, shown: /^default model: (.*)$/m.exec(detail)?.[1] };
}

async function launchModelRef(dir: string, registry: ModelRegistryLike, model?: string): Promise<string | undefined> {
	const [definition] = getEffectiveAgentDefinitions(dir);
	const plan = await buildChildLaunchPlan({
		params: { name: "n", title: "N", task: "t", agent: "picker", ...(model ? { model } : {}) },
		agentDefs: definition,
		parentCwd: dir,
		parentSessionDir: join(dir, "parent-sessions"),
		modelRegistry: registry,
		parentModelRef: PARENT.ref,
		parentThinking: PARENT.thinking,
	});
	return plan.effectiveModelRef;
}

describe("the default model in the detail is the one a launch runs on (T86, D22)", () => {
	afterEach(() => resetSubagentStateForTest());

	// Expected refs are the cf6dbf4 launch outputs of test/launch/model-upstream-parity.test.ts:
	// the unsupported inherited level drops, and a bare id at two providers takes the parent's.
	const cases: Array<[string, ModelRegistryLike, string]> = [
		["non-reasoning bare default", NON_REASONING_BASE, "a/base"],
		["bare default at two providers", TWO_BASES, "a/base:high"],
	];
	for (const [label, registry, expected] of cases) {
		it(`${label}, with an accepted list`, async () => {
			const { dir, shown } = shownDefault("model: base\nallowed-models: other/x", registry);
			assert.equal(shown, expected);
			assert.equal(await launchModelRef(dir, registry), shown, "a launch without a model");
			assert.equal(await launchModelRef(dir, registry, shown), shown, "a launch of the shown ref");
		});
	}

	it("non-reasoning bare default, without an accepted list: the level Pi lowers is not shown", async () => {
		const { dir, shown } = shownDefault("model: base", NON_REASONING_BASE);
		assert.equal(shown, "a/base");
		assert.equal(await launchModelRef(dir, NON_REASONING_BASE, shown), "a/base", "a launch of the shown ref");
	});
});
