import { getAgentListEntries } from "../../src/agents/agent-list.ts";
import { getEffectiveAgentDefinitions } from "../../src/agents/definitions.ts";
import { renderAgentDetailsForTest } from "../../src/testing/test-helpers.ts";
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
	return renderAgentDetailsForTest(listEntries(dir));
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
		assert.match(render(dir), /^limits: timeout 15m, idle-timeout 3m, context warnings at 80%, 85%, 90%, token counts hidden$/m);
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
		assert.doesNotMatch(render(dir), /context warnings/);
	});

	it("normalizes a context-warn threshold written without a percent sign", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "context-warn-threshold: 75");
		assert.match(render(dir), /context warnings at 75%, 80%, 85%/);
	});

	it("lists every stage of a context-warn schedule, also a collapsed one", () => {
		// The child receives the threshold and step as set (prep.ts), and it warns
		// at each distinct stage that getContextReminderThresholds schedules.
		const dir = createTestDir();
		writeLimitedAgent(dir, "context-warn-threshold: 95%");
		assert.match(render(dir), /^limits: context warnings at 95%, 99%$/m);
		writeLimitedAgent(dir, "context-warn-threshold: 80%\ncontext-warn-step: 10%");
		assert.match(render(dir), /^limits: context warnings at 80%, 90%, 99%$/m);
	});

	it("renders the report threshold and the no-resume policy of a timeout", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "timeout: 900\ntimeout-warn-threshold: 50%\non-timeout: block-resume");
		assert.match(render(dir), /^limits: timeout 15m \(report at 450s\), no resume after it$/m);
	});

	it("renders an idle-timeout alone", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "idle-timeout: 240");
		assert.match(render(dir), /^limits: idle-timeout 4m$/m);
	});
});
