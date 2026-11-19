import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderAgentIndexSection } from "../../src/agents/index-section.ts";
import { resolveCallModelRef } from "../../src/launch/child-launch-plan.ts";
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
	writeSubagentLaunchMetadataEntryForTest,
} from "../support/index.ts";

type AgentsTool = {
	execute(
		toolCallId: string,
		params: { name?: string; query?: string; limit?: number },
		signal: undefined,
		onUpdate: undefined,
		ctx: SessionContext & { cwd: string },
	): Promise<{ content: Array<{ type: "text"; text: string }> }>;
};

/** The parts of the session that the tool reads besides the files. */
interface SessionContext {
	hasUI?: boolean;
	model?: { provider: string; id: string };
}

interface SessionOptions extends SessionContext {
	thinking?: string;
	/** Tools the session model cannot call (absent from the active tools). */
	inactiveTools?: string[];
}

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_DENY_TOOLS",
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
function loadAgentsTool(
	cwd: string,
	session: SessionOptions = { hasUI: true },
): (params: { name?: string; query?: string; limit?: number }) => Promise<string> {
	const tool = loadExtensionTools(cwd, session).get("subagent_agents");
	assert.ok(tool, "subagent_agents is registered");
	const ctx = { cwd, hasUI: session.hasUI, model: session.model };
	return async (params) => (await tool.execute("call-1", params, undefined, undefined, ctx)).content[0].text;
}

/** Load the extension in `cwd` and return every tool it registers at session start. */
function loadExtensionTools(cwd: string, session: SessionOptions): Map<string, AgentsTool> {
	const tools = new Map<string, AgentsTool>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const api = {
		getAllTools: () => [...tools.keys()].map((name) => ({ name })),
		getActiveTools: () => [...tools.keys()].filter((name) => !session.inactiveTools?.includes(name)),
		getThinkingLevel: () => session.thinking ?? "off",
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, handler);
		},
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
	// D21: the tool is registered at session start.
	handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		{
			cwd,
			hasUI: false,
			mode: "print",
			ui: { notify() {}, setWidget() {} },
			sessionManager: { getHeader: () => undefined, getSessionId: () => "agents-tool", getSessionFile: () => "" },
		},
	);
	return tools;
}

/**
 * The error text of a launch and of a resume of `agent` from this session. Both fail before any
 * child starts: the agent file is malformed, or the caller may not launch the agent.
 */
async function launchAndResumeErrors(cwd: string, agent: string): Promise<{ launch: string; resume: string }> {
	const tools = loadExtensionTools(cwd, { hasUI: false }) as unknown as Map<
		string,
		{ execute(...args: unknown[]): Promise<unknown> }
	>;
	const sessionFile = join(cwd, `${agent}-child.jsonl`);
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "child", cwd })}\n`);
	await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
		version: 1,
		timestamp: new Date().toISOString(),
		name: "child",
		agent,
		mode: "background",
		sessionMode: "lineage-only",
		parentClosePolicy: "terminate",
		async: true,
		denyTools: [],
		noContextFiles: false,
		noSession: false,
		agentConfigDir: cwd,
		cwd,
		boundarySystemPrompt: false,
	});
	const ctx = { cwd, hasUI: false, sessionManager: { getSessionId: () => "agents-tool", getSessionFile: () => "" } };
	const errorOf = async (run: () => Promise<unknown>) => {
		try {
			return `no error: ${JSON.stringify(await run())}`;
		} catch (error) {
			return String(error);
		}
	};
	const child = { name: "child", title: "Child", task: "Probe.", agent };
	const launchTool = tools.get("subagent");
	const resumeTool = tools.get("subagent_resume");
	assert.ok(launchTool && resumeTool, "the launch and resume tools are registered");
	return {
		launch: await errorOf(() => launchTool.execute("c1", { children: [child] }, undefined, undefined, ctx)),
		resume: await errorOf(() => resumeTool.execute("c2", { sessionFile, task: "Go on." }, undefined, undefined, ctx)),
	};
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
		delete process.env.PI_DENY_TOOLS;
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
		writeAgent(agentsDir, "scout", "name: scout\ndescription: Scouts");
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
				// Width 16 is the enforced ceiling (MAX_SPAWN_WIDTH) when the agent sets none.
				"may launch: scout (depth 2, width 16)",
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
		assert.match(await call({ query: "nothing-like-this" }), /^No agent matches the query\. 101 agents in total\.$/);
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
		writeAgent(agentsDir, "broken-allowed", "name: broken-allowed\ndescription: Broken\ntimeout: 0");
		writeAgent(agentsDir, "broken-secret", "name: broken-secret\ndescription: Broken\ntimeout: 0");
		process.env.PI_SUBAGENT_AGENT = "coordinator";
		process.env.PI_SUBAGENT_SPAWNABLE = "helper,broken-allowed";
		process.env.PI_SUBAGENT_SPAWN_BUDGET = "1";
		const call = loadAgentsTool(cwd);
		const hidden = /secret\b|secrets\b|broken-secret|coordinator/;

		const count = await call({});
		assert.match(count, /^2 agents that you may launch \(1 malformed\)\. /);

		const byName = await call({ name: "secret" });
		assert.match(byName, /^No agent of that name that you may launch\. Closest: /);
		assert.doesNotMatch(byName, hidden);
		const typo = await call({ name: "secrat" });
		assert.equal(typo, "No agent of that name that you may launch. Closest: helper, broken-allowed.");
		assert.doesNotMatch(await call({ name: "broken-secret" }), /malformed|timeout/);

		const query = await call({ query: "secret broken" });
		const names = query.split("\n").map((line) => line.match(/^- ([\w-]+):/)?.[1]);
		assert.deepEqual(names.sort(), ["broken-allowed", "helper"]);
		assert.match(query, /^- helper: Helps with secrets of style$/m);
		assert.match(query, /^- broken-allowed: malformed, /m);

		const parseError = await call({ name: "broken-allowed" });
		assert.match(parseError, /^Agent 'broken-allowed' is malformed in .*broken-allowed\.md: .*timeout/);
	});

	it("withholds a helper's grant past the caller's view and budget (review 1)", async () => {
		const { cwd, agentsDir } = createAgentRoot();
		writeAgent(
			agentsDir,
			"helper",
			"name: helper\ndescription: Helps\nspawning: private-worker, scout\nspawn-depth: 3",
		);
		writeAgent(agentsDir, "private-worker", "name: private-worker\ndescription: Private");
		writeAgent(agentsDir, "scout", "name: scout\ndescription: Scouts");
		process.env.PI_SUBAGENT_AGENT = "coordinator";
		process.env.PI_SUBAGENT_SPAWNABLE = "helper,scout";
		// Budget 1: the helper receives budget 0 (getChildBudget) and launches nothing.
		process.env.PI_SUBAGENT_SPAWN_BUDGET = "1";
		const exhausted = await loadAgentsTool(cwd)({ name: "helper" });
		assert.match(exhausted, /^may launch: none$/m);
		assert.doesNotMatch(exhausted, /private-worker/);
		// Budget 3: the helper receives min(3, 3 - 1) = 2 levels; the caller cannot see private-worker.
		process.env.PI_SUBAGENT_SPAWN_BUDGET = "3";
		const open = await loadAgentsTool(cwd)({ name: "helper" });
		assert.match(open, /^may launch: scout \(depth 2, width 16\)$/m);
		assert.doesNotMatch(open, /private-worker/);
	});

	it("keeps the stated visibility of a malformed file (review 2)", async () => {
		const { cwd, agentsDir } = createAgentRoot();
		// visible-to is readable; the unrelated timeout: 0 makes the file malformed.
		writeAgent(agentsDir, "root-only", "name: root-only\ndescription: Root only\nvisible-to: root\ntimeout: 0");
		// visible-to itself is invalid, so no caller may see the file.
		writeAgent(agentsDir, "unreadable", "name: unreadable\ndescription: Unreadable\nvisible-to: all, root");
		writeAgent(agentsDir, "granted", "name: granted\ndescription: Granted\ntimeout: 0");
		// An unterminated header is read to the end of the file: its visible-to still holds.
		writeFileSync(
			join(agentsDir, "open-root.md"),
			"---\nname: open-root\ndescription: Open\nvisible-to: root\n\nBody.",
		);
		writeAgent(agentsDir, "worker", "name: worker\ndescription: Works");
		process.env.PI_SUBAGENT_AGENT = "coordinator";
		process.env.PI_SUBAGENT_SPAWNABLE = "true";
		process.env.PI_SUBAGENT_SPAWN_BUDGET = "1";
		const call = loadAgentsTool(cwd);
		const hidden = /root-only|unreadable|open-root/;
		assert.match(await call({}), /^2 agents that you may launch \(1 malformed\)\. /);
		assert.doesNotMatch(await call({ name: "root-only" }), hidden);
		assert.doesNotMatch(await call({ name: "unreadable" }), hidden);
		assert.doesNotMatch(await call({ name: "root-onyl" }), hidden);
		assert.doesNotMatch(await call({ query: "root only unreadable granted worker" }), hidden);
		assert.match(await call({ name: "granted" }), /^Agent 'granted' is malformed in .*granted\.md: .*timeout/);
		// Launch and resume check the grant before they name the file or its parse error (review b1 g3).
		for (const agent of ["root-only", "unreadable", "open-root"]) {
			const errors = await launchAndResumeErrors(cwd, agent);
			for (const [path, text] of Object.entries(errors)) {
				assert.doesNotMatch(text, /malformed|\.md|timeout/, `${agent} ${path}: ${text}`);
				assert.match(text, /policy/, `${agent} ${path} is refused by the spawn policy: ${text}`);
				assert.doesNotMatch(text, /^no error/, `${agent} ${path} is refused`);
			}
		}
		const granted = await launchAndResumeErrors(cwd, "granted");
		assert.match(granted.launch, /Agent "granted" is malformed in .*granted\.md: .*timeout/);
		assert.match(granted.resume, /Agent "granted" is malformed in .*granted\.md: .*timeout/);
		// The root session may see the root-only file, with its parse error.
		delete process.env.PI_SUBAGENT_AGENT;
		delete process.env.PI_SUBAGENT_SPAWNABLE;
		delete process.env.PI_SUBAGENT_SPAWN_BUDGET;
		assert.match(await loadAgentsTool(cwd)({ name: "root-only" }), /^Agent 'root-only' is malformed in /);
		const root = await launchAndResumeErrors(cwd, "root-only");
		assert.match(root.launch, /Agent "root-only" is malformed in .*root-only\.md: .*timeout/);
		assert.match(root.resume, /Agent "root-only" is malformed in .*root-only\.md: .*timeout/);
		const open = await launchAndResumeErrors(cwd, "open-root");
		assert.match(open.launch, /Agent "open-root" is malformed in .*open-root\.md: /);
	});

	it("answers only when the session may launch (review 3)", async () => {
		const { cwd, agentsDir } = createAgentRoot();
		writeAgent(agentsDir, "helper", "name: helper\ndescription: Helps");
		const denied = "This session may not launch agents, so it has none to look up.";
		// deny-tools: subagent reaches the child as PI_DENY_TOOLS (resolveDenyTools).
		process.env.PI_DENY_TOOLS = "subagent";
		for (const params of [{}, { name: "helper" }, { query: "helps" }]) {
			assert.equal(await loadAgentsTool(cwd)(params), denied);
		}
		delete process.env.PI_DENY_TOOLS;
		// A session whose model cannot call the launch tool (--exclude-tools subagent).
		assert.equal(await loadAgentsTool(cwd, { hasUI: true, inactiveTools: ["subagent"] })({}), denied);
		assert.match(await loadAgentsTool(cwd)({}), /^1 agents that you may launch\. /);
	});

	it("finds a launchable agent without a description (review 4)", async () => {
		const { cwd, agentsDir } = createAgentRoot();
		writeAgent(agentsDir, "scout", "name: scout");
		const call = loadAgentsTool(cwd);
		assert.match(await call({}), /^1 agents that you may launch\. /);
		assert.match(await call({ name: "scout" }), /^scout \(global\): $/m);
		assert.equal(await call({ query: "scout" }), "- scout: ");
		assert.equal(await call({ name: "scuot" }), "No agent of that name that you may launch. Closest: scout.");
	});

	it("shows the models the launch resolver accepts (review 5)", async () => {
		const { cwd, agentsDir } = createAgentRoot();
		writeAgent(agentsDir, "helper", "name: helper\ndescription: Helps\nallowed-models: beta/small");
		const session = { hasUI: true, model: { provider: "alpha", id: "base" }, thinking: "high" };
		const detail = await loadAgentsTool(cwd, session)({ name: "helper" });
		assert.match(detail, /^default model: alpha\/base:high$/m);
		assert.match(detail, /^models: alpha: base:high; beta: small$/m);
		// Differential: launch accepts each shown ref (buildChildLaunchPlan passes the parent ref as inherited).
		for (const model of ["alpha/base:high", "beta/small"]) {
			assert.doesNotThrow(() =>
				resolveCallModelRef({
					model,
					config: { allowedModels: "beta/small", agentName: "helper" },
					inheritedModelRef: "alpha/base:high",
					fallbackThinking: "high",
				}),
			);
		}
	});

	it("states the child that a launch from this session gets (review 6)", async () => {
		const { cwd, agentsDir } = createAgentRoot();
		writeAgent(agentsDir, "helper", "name: helper\ndescription: Helps");
		writeAgent(agentsDir, "keeper", "name: keeper\ndescription: Keeps open\nmode: background\nauto-exit: false");
		// A print session (no UI) forces every launch to wait and close itself.
		const print = loadAgentsTool(cwd, { hasUI: false });
		assert.match(await print({ name: "helper" }), /^child: headless, closes itself, launch waits for the result$/m);
		// A headless child closes itself also with auto-exit: false (applySynchronousLaunchPolicy).
		const ui = loadAgentsTool(cwd, { hasUI: true });
		assert.match(await ui({ name: "keeper" }), /^child: headless, closes itself, launch returns at once$/m);
	});

	it("lists every enforced limit (review 7)", async () => {
		const { cwd, agentsDir } = createAgentRoot();
		writeAgent(
			agentsDir,
			"bounded",
			[
				"name: bounded",
				"description: Bounded",
				"timeout: 900",
				"timeout-warn-threshold: 50%",
				"on-timeout: block-resume",
				"idle-timeout: 120",
				"context-warn-threshold: 70%",
				"context-warn-step: 10%",
				"spawning: true",
				"spawn-depth: 2",
				"spawn-width: 3",
			].join("\n"),
		);
		const detail = await loadAgentsTool(cwd)({ name: "bounded" });
		// 900 s at 50% is a report stop at 450 s; the schedule is 70, 80, 90 (step 10).
		assert.match(
			detail,
			/^limits: timeout 15m \(report at 450s\), no resume after it, idle-timeout 2m, context warnings at 70%, 80%, 90%$/m,
		);
		assert.match(detail, /^may launch: any agent \(depth 2, width 3\)$/m);
	});

	it("keeps a miss within one line (review 8)", async () => {
		const { cwd, agentsDir } = createAgentRoot();
		writeAgent(agentsDir, "worker", "name: worker\ndescription: Does work");
		const call = loadAgentsTool(cwd);
		const multiline = "zebra\nquokka\nyak\nnarwhal\nokapi\naxolotl";
		assert.equal(await call({ query: multiline }), "No agent matches the query. 1 agents in total.");
		assert.equal(await call({ name: multiline }).then((text) => text.split("\n").length), 1);
	});
});
