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

function writeAgents(dir: string): string {
	const configDir = join(dir, "agent-root");
	const agentsDir = join(configDir, "agents");
	mkdirSync(agentsDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = configDir;
	writeFileSync(
		join(agentsDir, "public.md"),
		`---\nname: public\ndescription: Public worker\nvisible-to: all\n---\n\nPublic body.`,
	);
	writeFileSync(
		join(agentsDir, "root-only.md"),
		`---\nname: root-only\ndescription: Root worker\nvisible-to: root\n---\n\nRoot body.`,
	);
	writeFileSync(
		join(agentsDir, "other-only.md"),
		`---\nname: other-only\ndescription: Caller worker\nvisible-to: caller-agent\nspawning: scout, reviewer\nspawn-depth: 2\nspawn-width: 3\n---\n\nCaller body.`,
	);
	return agentsDir;
}

function resolveSessionMode(agent: ReturnType<typeof getEffectiveAgentDefinitions>[number]) {
	return agent.sessionMode ?? "lineage-only";
}

describe("roster filtering", () => {
	afterEach(() => resetSubagentStateForTest());

	it("filters root and child rosters by visibility and caller whitelist", () => {
		const dir = createTestDir();
		writeAgents(dir);

		const root = getAgentListEntries(dir, resolveSessionMode, {
			callerAgent: null,
			callerSpawnable: true,
		});
		assert.deepEqual(
			root.map((entry) => entry.name),
			["public", "root-only"],
		);

		const child = getAgentListEntries(dir, resolveSessionMode, {
			callerAgent: "caller-agent",
			callerSpawnable: ["public", "other-only", "root-only"],
		});
		assert.deepEqual(
			child.map((entry) => entry.name),
			["other-only", "public"].sort(),
		);
		const details = child.map(renderAgentDetail).join("\n\n");
		assert.match(details, /^other-only \(global\): Caller worker$/m);
		assert.doesNotMatch(details, /root-only/);
	});

	it("renders spawning grants", () => {
		const dir = createTestDir();
		writeAgents(dir);
		const options = { callerAgent: "caller-agent", callerSpawnable: true as const };
		const details = getAgentListEntries(dir, resolveSessionMode, options).map(renderAgentDetail).join("\n\n");
		assert.match(details, /^may launch: scout, reviewer \(depth 2, width 3\)$/m);
	});
});
