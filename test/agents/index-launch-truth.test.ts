import { getEffectiveAgentDefinitions } from "../../src/agents/definitions.ts";
import { renderAgentIndexSection } from "../../src/agents/index-section.ts";
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
 * The default model has its own suite: detail-model-roundtrip.test.ts.
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
