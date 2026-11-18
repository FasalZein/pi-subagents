import {
	afterEach,
	assert,
	createTestDir,
	describe,
	getAgentListEntriesForTest,
	it,
	join,
	mkdirSync,
	renderAgentDetailsForTest,
	resetSubagentStateForTest,
	writeFileSync,
} from "../support/index.ts";

function createAgentRoot(): { baseCwd: string; agentsDir: string } {
	const baseCwd = createTestDir();
	const configDir = join(baseCwd, "agent-root");
	const agentsDir = join(configDir, "agents");
	mkdirSync(agentsDir, { recursive: true });
	return { baseCwd, agentsDir };
}

function withAgentRoot<T>(agentsDir: string, run: () => T): T {
	const saved = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(agentsDir, "..");
	try {
		return run();
	} finally {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
	}
}

function writeAgent(agentsDir: string, name: string, frontmatter: string): void {
	writeFileSync(
		join(agentsDir, `${name}.md`),
		`---\nname: ${name}\ndescription: ${name} behavior\n${frontmatter}\n---\n\nAgent body.`,
	);
}

function blockFor(details: string, name: string): string {
	return details.split("\n\n").find((block) => block.startsWith(`${name} (`)) ?? "";
}

// The roster is gone (D19); the full definition view of subagent_agents (D20)
// states the same launch contract per agent.
describe("agent detail runtime contract", () => {
	afterEach(() => resetSubagentStateForTest());

	it("describes the explicit async contract of each agent", () => {
		const { baseCwd, agentsDir } = createAgentRoot();
		writeAgent(agentsDir, "sync-worker", "async: false");
		writeAgent(agentsDir, "async-worker", "async: true");
		writeAgent(agentsDir, "default-worker", "");

		withAgentRoot(agentsDir, () => {
			const details = renderAgentDetailsForTest(getAgentListEntriesForTest(baseCwd));
			assert.match(blockFor(details, "sync-worker"), /launch waits for the result/);
			assert.match(blockFor(details, "async-worker"), /launch returns at once/);
			assert.match(blockFor(details, "default-worker"), /launch returns at once/);
		});
	});

	it("accepts any model ref when an agent allows overrides without a list", () => {
		const { baseCwd, agentsDir } = createAgentRoot();
		writeAgent(agentsDir, "open-model", "allow-model-override: true");

		withAgentRoot(agentsDir, () => {
			const details = renderAgentDetailsForTest(getAgentListEntriesForTest(baseCwd));
			assert.match(details, /^default model: the parent's model\nmodels: any model ref$/m);
		});
	});

	it("names the default model and no choices when overrides are disabled", () => {
		const { baseCwd, agentsDir } = createAgentRoot();
		writeAgent(agentsDir, "pinned-model", "model: provider/model\nallow-model-override: false");

		withAgentRoot(agentsDir, () => {
			const block = blockFor(renderAgentDetailsForTest(getAgentListEntriesForTest(baseCwd)), "pinned-model");
			assert.match(block, /^default model: provider\/model\nmodels: the default only \(overrides are ignored\)$/m);
		});
	});

	it("names a verified fan-out only when an agent is marked for it", () => {
		const marked = createAgentRoot();
		writeAgent(marked.agentsDir, "verified-worker", "llm-as-a-verifier: true");
		withAgentRoot(marked.agentsDir, () => {
			const details = renderAgentDetailsForTest(getAgentListEntriesForTest(marked.baseCwd));
			assert.match(details, /verified fan-out \(\d+ attempts\)/);
		});

		const plain = createAgentRoot();
		writeAgent(plain.agentsDir, "plain-worker", "");
		withAgentRoot(plain.agentsDir, () => {
			const details = renderAgentDetailsForTest(getAgentListEntriesForTest(plain.baseCwd));
			assert.doesNotMatch(details, /verified fan-out/);
		});
	});
});
