import { getAgentListEntries } from "../../src/agents/agent-list.ts";
import { getEffectiveAgentDefinitions } from "../../src/agents/definitions.ts";
import { renderAgentDetail } from "../../src/agents/launchable-agents.ts";
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

function writeLimitedAgent(dir: string, frontmatter: string): void {
	const configDir = join(dir, "agent-root");
	const agentsDir = join(configDir, "agents");
	mkdirSync(agentsDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = configDir;
	writeFileSync(
		join(agentsDir, "limited.md"),
		`---\nname: limited\ndescription: Limited worker\n${frontmatter}\n---\n\nLimited body.`,
	);
}

function resolveSessionMode(agent: ReturnType<typeof getEffectiveAgentDefinitions>[number]) {
	return agent.sessionMode ?? "lineage-only";
}

function listEntries(dir: string) {
	return getAgentListEntries(dir, resolveSessionMode, { callerAgent: null, callerSpawnable: true });
}


function render(dir: string): string {
	return listEntries(dir).map(renderAgentDetail).join("\n\n");
}

// The roster that carried these fields is gone (D19); the full definition view
// of subagent_agents (D20) states the same limits.
describe("agent detail limit fields", () => {
	afterEach(() => resetSubagentStateForTest());

	it("renders the limits when the fields are set", () => {
		const dir = createTestDir();
		writeLimitedAgent(
			dir,
			"timeout: 900\nidle-timeout: 180\ncontext-warn-threshold: 80%\ncontext-warn-step: 5%\nreport-context-usage: false",
		);
		const entry = listEntries(dir)[0];
		assert.equal(entry?.timeout, 900);
		assert.equal(entry?.idleTimeout, 180);
		assert.equal(entry?.contextWarnThreshold, "80%");
		assert.equal(entry?.reportContextUsage, false);
		assert.match(render(dir), /^limits: timeout 15m, idle-timeout 3m, context-warn 80%, token counts hidden$/m);
	});

	it("says none when no limit field is set", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "model: provider/model");
		assert.match(render(dir), /^limits: none$/m);
	});

	it("does not mention token counts when report-context-usage is true", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "report-context-usage: true");
		assert.doesNotMatch(render(dir), /token counts/);
	});

	it("skips a context-warn threshold that launch policy would disable", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "timeout: 60\ncontext-warn-threshold: banana");
		assert.match(render(dir), /^limits: timeout 1m$/m);
	});

	it("skips an explicit context-warn off value", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "context-warn-threshold: off");
		assert.doesNotMatch(render(dir), /context-warn/);
	});

	it("normalizes a context-warn threshold written without a percent sign", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "context-warn-threshold: 75");
		assert.match(render(dir), /context-warn 75%/);
	});

	it("omits a context-warn schedule that collapsed below three stages", () => {
		const dir = createTestDir();
		// 95% with the default 5% step yields thresholds [95, 99]: the runtime
		// never delivers the final stop instruction, so no stop behavior exists.
		writeLimitedAgent(dir, "context-warn-threshold: 95%");
		assert.doesNotMatch(render(dir), /context-warn/);

		// The same 80% start with a 10% step keeps three stages and renders.
		writeLimitedAgent(dir, "context-warn-threshold: 80%\ncontext-warn-step: 10%");
		assert.match(render(dir), /context-warn 80%/);

		// A step that collapses the schedule hides the limit again.
		writeLimitedAgent(dir, "context-warn-threshold: 80%\ncontext-warn-step: 20%");
		assert.doesNotMatch(render(dir), /context-warn/);
	});

	it("renders an idle-timeout alone", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "idle-timeout: 240");
		assert.match(render(dir), /^limits: idle-timeout 4m$/m);
	});
});
