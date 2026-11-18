import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderAgentIndexSection } from "../../src/agents/index-section.ts";
import {
	afterEach,
	assert,
	beforeEach,
	createTestDir,
	describe,
	getAgentListEntriesForTest,
	it,
	join,
	mkdirSync,
	resetSubagentStateForTest,
	subagentsExtension,
	writeFileSync,
} from "../support/index.ts";

type AgentsTool = {
	execute(
		toolCallId: string,
		params: { name?: string; query?: string; limit?: number },
		signal: undefined,
		onUpdate: undefined,
		ctx: { cwd: string },
	): Promise<{ content: Array<{ type: "text"; text: string }> }>;
};

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_SUBAGENT_AGENT",
	"PI_SUBAGENT_SPAWNABLE",
	"PI_SUBAGENT_SPAWN_BUDGET",
] as const;

function writeAgent(agentsDir: string, file: string, frontmatter: string): void {
	writeFileSync(join(agentsDir, `${file}.md`), `---\n${frontmatter}\n---\n\nBody.`);
}

/** A config root with its agents folder; the extension reads it from PI_CODING_AGENT_DIR. */
function createAgentRoot(): { cwd: string; agentsDir: string } {
	const cwd = createTestDir();
	const configDir = join(cwd, "agent-root");
	const agentsDir = join(configDir, "agents");
	mkdirSync(agentsDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = configDir;
	return { cwd, agentsDir };
}

/** Load the extension in `cwd` and return a caller of its subagent_agents tool. */
function loadAgentsTool(cwd: string): (params: { name?: string; query?: string; limit?: number }) => Promise<string> {
	const tools = new Map<string, AgentsTool>();
	const api = {
		on() {},
		registerTool(tool: AgentsTool & { name: string }) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
	} as unknown as ExtensionAPI;
	const previous = process.cwd();
	process.chdir(cwd);
	try {
		subagentsExtension(api);
	} finally {
		process.chdir(previous);
	}
	const tool = tools.get("subagent_agents");
	assert.ok(tool, "subagent_agents is registered");
	return async (params) => (await tool.execute("call-1", params, undefined, undefined, { cwd })).content[0].text;
}

function describedAs(index: number): string {
	return `Handles task family ${index} and reports a short summary of the result back to the caller.`;
}

describe("subagent_agents tool", () => {
	const saved = new Map<string, string | undefined>();
	beforeEach(() => {
		for (const key of ENV_KEYS) saved.set(key, process.env[key]);
		delete process.env.PI_SUBAGENT_AGENT;
		delete process.env.PI_SUBAGENT_SPAWNABLE;
		delete process.env.PI_SUBAGENT_SPAWN_BUDGET;
	});
	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = saved.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetSubagentStateForTest();
	});

	it("returns the full definition of one agent by name", async () => {
		const { cwd, agentsDir } = createAgentRoot();
		writeAgent(
			agentsDir,
			"reviewer",
			[
				"name: reviewer",
				"description: Review a diff for regressions",
				"mode: background",
				"session-mode: fork",
				"model: alpha/big",
				"thinking: high",
				"allowed-models: beta/small:low, alpha/mid",
				"timeout: 900",
				"idle-timeout: 120",
				"spawning: scout",
				"spawn-depth: 2",
			].join("\n"),
		);
		const call = loadAgentsTool(cwd);
		assert.equal(
			await call({ name: "reviewer" }),
			[
				"reviewer (global): Review a diff for regressions",
				"default model: alpha/big:high",
				"models: alpha: big:high, mid; beta: small:low",
				"child: headless, closes itself, launch returns at once",
				"session: copy of this chat",
				"limits: timeout 15m, idle-timeout 2m",
				"may launch: scout (depth 2)",
			].join("\n"),
		);
	});

	it("finds an agent outside the index by query, at most 5 lines by default", async () => {
		const { cwd, agentsDir } = createAgentRoot();
		for (let index = 0; index < 100; index++) {
			writeAgent(
				agentsDir,
				`agent-${String(index).padStart(3, "0")}`,
				`name: agent-${String(index).padStart(3, "0")}\ndescription: ${describedAs(index)}`,
			);
		}
		writeAgent(agentsDir, "zz-translator", "name: zz-translator\ndescription: Translates release notes into German");
		const index = renderAgentIndexSection(getAgentListEntriesForTest(cwd), { paneAvailable: false, forcesWait: false });
		assert.ok(index && !index.includes("zz-translator"), "the agent is outside the index");

		const call = loadAgentsTool(cwd);
		assert.equal(await call({ query: "german translator" }), "- zz-translator: Translates release notes into German");
		const broad = (await call({ query: "summary" })).split("\n");
		assert.equal(broad.length, 5);
		assert.ok(broad.every((line) => /^- agent-\d{3}: Handles task family/.test(line)));
		assert.equal((await call({ query: "summary", limit: 2 })).split("\n").length, 2);
		assert.match(
			await call({ query: "nothing-like-this" }),
			/^No agent matches 'nothing-like-this'\. 101 agents in total\.$/,
		);
	});

	it("returns the count in at most 200 characters, also with 100 pinned agents", async () => {
		const { cwd, agentsDir } = createAgentRoot();
		for (let index = 0; index < 100; index++) {
			writeAgent(
				agentsDir,
				`pinned-${index}`,
				`name: pinned-${index}\ndescription: ${describedAs(index)}\npinned: true`,
			);
		}
		const text = await loadAgentsTool(cwd)({});
		assert.ok(text.length <= 200, `${text.length} characters: ${text}`);
		assert.match(text, /^100 agents that you may launch\. /);
		assert.match(text, /query/);
		assert.doesNotMatch(text, /pinned-/);
	});

	it("refuses name and query together", async () => {
		const { cwd, agentsDir } = createAgentRoot();
		writeAgent(agentsDir, "worker", "name: worker\ndescription: Does work");
		assert.equal(await loadAgentsTool(cwd)({ name: "worker", query: "work" }), "Pass name or query, not both.");
	});

	it("shows a restricted coordinator only the agents it may launch", async () => {
		const { cwd, agentsDir } = createAgentRoot();
		writeAgent(
			agentsDir,
			"coordinator",
			"name: coordinator\ndescription: Coordinates\nspawning: helper, broken-allowed",
		);
		writeAgent(agentsDir, "helper", "name: helper\ndescription: Helps with secrets of style");
		writeAgent(agentsDir, "secret", "name: secret\ndescription: Holds the secret plan");
		writeAgent(agentsDir, "secrets", "name: secrets\ndescription: Holds more secret plans");
		// Each malformed file names itself, so its name survives the parse error.
		writeAgent(agentsDir, "broken-allowed", "name: broken-allowed\ndescription: Broken\nvisible-to: all, root");
		writeAgent(agentsDir, "broken-secret", "name: broken-secret\ndescription: Broken\nvisible-to: all, root");
		process.env.PI_SUBAGENT_AGENT = "coordinator";
		process.env.PI_SUBAGENT_SPAWNABLE = "helper,broken-allowed";
		process.env.PI_SUBAGENT_SPAWN_BUDGET = "1";
		const call = loadAgentsTool(cwd);
		const hidden = /secret\b|secrets\b|broken-secret|coordinator/;

		const count = await call({});
		assert.match(count, /^2 agents that you may launch \(1 malformed\)\. /);

		const byName = await call({ name: "secret" });
		assert.match(byName, /^No agent 'secret' that you may launch\. Closest: /);
		assert.doesNotMatch(byName.replace("No agent 'secret'", ""), hidden);
		const typo = await call({ name: "secrat" });
		assert.equal(typo, "No agent 'secrat' that you may launch. Closest: helper, broken-allowed.");
		assert.doesNotMatch(await call({ name: "broken-secret" }), /malformed|visible-to/);

		const query = await call({ query: "secret broken" });
		const names = query.split("\n").map((line) => line.match(/^- ([\w-]+):/)?.[1]);
		assert.deepEqual(names.sort(), ["broken-allowed", "helper"]);
		assert.match(query, /^- helper: Helps with secrets of style$/m);
		assert.match(query, /^- broken-allowed: malformed, /m);

		const parseError = await call({ name: "broken-allowed" });
		assert.match(parseError, /^Agent 'broken-allowed' is malformed in .*broken-allowed\.md: .*visible-to/);
	});
});
