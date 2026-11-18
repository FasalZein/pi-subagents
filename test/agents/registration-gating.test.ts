import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildResumeSpawnEnv } from "../../src/spawn/policy.ts";
import {
	afterEach,
	assert,
	beforeEach,
	createTestDir,
	describe,
	it,
	join,
	mkdirSync,
	resetSubagentStateForTest,
	subagentsExtension,
	writeFileSync,
} from "../support/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
// biome-ignore lint/suspicious/noExplicitAny: the registered tool shape is probed dynamically.
type RegisteredTool = { name: string; exposure?: string; execute: (...args: any[]) => Promise<any> };

interface CapturedRegistrations {
	handlers: Map<string, Handler>;
	tools: string[];
	commands: string[];
	shortcuts: string[];
	renderers: string[];
}

/**
 * A Pi stand-in that binds the active tool list only at session start, as Pi
 * does: reading it while the extension loads throws. Registering a direct tool
 * activates it; a deferred tool stays inactive (Pi docs, "Tool Exposure").
 */
function createCapturingPi(loadout: readonly string[] = ["read", "bash"]) {
	const captured: CapturedRegistrations = {
		handlers: new Map(),
		tools: [],
		commands: [],
		shortcuts: [],
		renderers: [],
	};
	const registered = new Map<string, RegisteredTool>();
	const active = new Set(loadout);
	let bound = false;
	const assertBound = () => {
		if (!bound) throw new Error("Extension runtime not initialized: the active tool list is not bound yet.");
	};
	const api = {
		on(event: string, handler: Handler) {
			captured.handlers.set(event, handler);
		},
		registerTool(tool: RegisteredTool) {
			captured.tools.push(tool.name);
			registered.set(tool.name, tool);
			if ((tool.exposure ?? "direct") === "direct") active.add(tool.name);
		},
		getActiveTools() {
			assertBound();
			return [...active];
		},
		getAllTools() {
			assertBound();
			return [...registered.values()].map((tool) => ({ name: tool.name, exposure: tool.exposure ?? "direct" }));
		},
		getThinkingLevel: () => "off",
		registerCommand(name: string) {
			captured.commands.push(name);
		},
		registerShortcut(shortcut: string) {
			captured.shortcuts.push(shortcut);
		},
		registerMessageRenderer(customType: string) {
			captured.renderers.push(customType);
		},
	} as unknown as ExtensionAPI;
	const startSession = (cwd: string) => {
		bound = true;
		captured.handlers.get("session_start")?.(
			{ type: "session_start", reason: "startup" },
			{
				cwd,
				hasUI: false,
				mode: "print",
				ui: { notify() {}, setWidget() {} },
				sessionManager: { getHeader: () => undefined, getSessionId: () => "gating", getSessionFile: () => "" },
			},
		);
	};
	/** The tools a request declares: the active ones (Pi's active set is the declared set). */
	const declared = () => [...active].filter((name) => registered.has(name)).sort();
	return { captured, api, registered, startSession, declared };
}

const MANAGEMENT_TOOLS = ["subagent_agents", "subagent_kill", "subagent_resume"];
const ENV_KEYS = ["PI_DENY_TOOLS", "PI_SUBAGENT_AGENT", "PI_SUBAGENT_SPAWN_BUDGET", "PI_SUBAGENT_SPAWNABLE"] as const;

/** Load the extension with one worker agent in a fresh config root and return the bound session. */
function loadWithWorker(loadout?: readonly string[]) {
	const dir = createTestDir();
	const configDir = join(dir, "agent-root");
	writeGlobalAgent(configDir, "name: worker\ndescription: Worker for gating tests");
	process.env.PI_CODING_AGENT_DIR = configDir;
	const session = createCapturingPi(loadout);
	const prevCwd = process.cwd();
	process.chdir(dir);
	try {
		subagentsExtension(session.api);
		const atLoad = [...session.captured.tools].sort();
		session.startSession(dir);
		return { ...session, dir, atLoad };
	} finally {
		process.chdir(prevCwd);
	}
}

function writeGlobalAgent(configDir: string, frontmatter: string): void {
	const agentsDir = join(configDir, "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, "worker.md"), `---\n${frontmatter}\n---\n\nWorker body.`);
}

describe("extension registration gating", () => {
	const saved = new Map<string, string | undefined>();
	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
	});
	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = saved.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetSubagentStateForTest();
	});

	it("registers no tools, commands, shortcuts, renderers, or handlers when no agent definitions exist", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		mkdirSync(join(configDir, "agents"), { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;
		const prevCwd = process.cwd();
		process.chdir(dir);
		try {
			const { captured, api } = createCapturingPi();
			subagentsExtension(api);
			assert.deepEqual(captured.tools, []);
			assert.deepEqual(captured.commands, []);
			assert.deepEqual(captured.shortcuts, []);
			assert.deepEqual(captured.renderers, []);
			assert.deepEqual([...captured.handlers.keys()], []);
		} finally {
			process.chdir(prevCwd);
		}
	});

	it("registers the full subagent surface when an agent definition exists", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		writeGlobalAgent(configDir, "name: worker\ndescription: Worker for gating tests");
		process.env.PI_CODING_AGENT_DIR = configDir;
		const setTabTitleOptIn = process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
		delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
		const prevCwd = process.cwd();
		process.chdir(dir);
		try {
			const { captured, api, startSession } = createCapturingPi();
			subagentsExtension(api);
			// D21: only the launch tool is registered while the extension loads; the
			// mock throws on the active tool list until the session starts.
			assert.deepEqual([...captured.tools], ["subagent"]);
			startSession(dir);
			assert.deepEqual([...captured.tools].sort(), ["subagent", "subagent_agents", "subagent_kill", "subagent_resume"]);
			assert.deepEqual(captured.commands, ["subagents"]);
			assert.deepEqual(captured.shortcuts, ["alt+s"]);
			assert.deepEqual([...captured.renderers].sort(), ["subagent_ping", "subagent_result"]);
			assert.deepEqual([...captured.handlers.keys()].sort(), [
				"agent_end",
				"agent_settled",
				"before_agent_start",
				"context",
				"input",
				"message_end",
				"session_shutdown",
				"session_start",
				"tool_call",
				"tool_result",
				"turn_start",
			]);
		} finally {
			process.chdir(prevCwd);
			if (setTabTitleOptIn == null) delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
			else process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = setTabTitleOptIn;
		}
	});

	it("registers nothing when the only agent definition is disabled", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		writeGlobalAgent(configDir, "name: worker\ndescription: Disabled worker\nenabled: false");
		process.env.PI_CODING_AGENT_DIR = configDir;
		const prevCwd = process.cwd();
		process.chdir(dir);
		try {
			const { captured, api } = createCapturingPi();
			subagentsExtension(api);
			assert.deepEqual(captured.tools, []);
			assert.deepEqual(captured.commands, []);
			assert.deepEqual(captured.shortcuts, []);
			assert.deepEqual(captured.renderers, []);
			assert.deepEqual([...captured.handlers.keys()], []);
		} finally {
			process.chdir(prevCwd);
		}
	});

	it("registers no launch or agents tool at a spawn depth of zero", () => {
		// The env the parent builds for a child whose spawn budget is used up.
		const spawnEnv = buildResumeSpawnEnv(undefined, 0, null);
		process.env.PI_SUBAGENT_AGENT = "worker";
		process.env.PI_SUBAGENT_SPAWN_BUDGET = spawnEnv.PI_SUBAGENT_SPAWN_BUDGET;
		process.env.PI_DENY_TOOLS = spawnEnv.denyToolsToAdd.join(",");
		const { captured } = loadWithWorker();
		assert.deepEqual(captured.tools, []);
	});

	it("does not register a tool named on deny-tools, also not the stop tool", () => {
		for (const denied of ["subagent", ...MANAGEMENT_TOOLS]) {
			process.env.PI_DENY_TOOLS = denied;
			const { captured } = loadWithWorker();
			assert.equal(captured.tools.includes(denied), false, `${denied} is not registered`);
			assert.equal(captured.tools.length, 3, `the other tools stay registered when ${denied} is denied`);
		}
	});

	it("declares the management tools as D21 says for each loadout", () => {
		const loadouts = [
			// Codemode on and codemode only have the same active list; codemode.mode
			// changes only how the codemode tool presents the declared tools.
			{ name: "codemode on", tools: ["read", "bash", "codemode"], exposure: "deferred" },
			{ name: "codemode only", tools: ["read", "bash", "codemode"], exposure: "deferred" },
			{ name: "tool search only", tools: ["read", "bash", "tool_search"], exposure: "deferred" },
			{ name: "neither", tools: ["read", "bash"], exposure: "direct" },
		];
		for (const loadout of loadouts) {
			const { registered, declared, atLoad } = loadWithWorker(loadout.tools);
			assert.deepEqual(atLoad, ["subagent"], `${loadout.name}: only the launch tool at load`);
			assert.equal(registered.get("subagent")?.exposure ?? "direct", "direct", `${loadout.name}: launch tool`);
			for (const name of MANAGEMENT_TOOLS) {
				assert.equal(registered.get(name)?.exposure ?? "direct", loadout.exposure, `${loadout.name}: ${name}`);
			}
			const expected = loadout.exposure === "direct" ? ["subagent", ...MANAGEMENT_TOOLS] : ["subagent"];
			assert.deepEqual(
				declared().filter((name) => name.startsWith("subagent")),
				expected,
				`${loadout.name}: declared tools`,
			);
		}
	});

	it("refuses a deferred tool that is not active when the child may not launch", async () => {
		// deny-tools: subagent reaches the child as PI_DENY_TOOLS; the deferred
		// tools stay callable from a codemode script, so each checks at call time.
		process.env.PI_SUBAGENT_AGENT = "worker";
		process.env.PI_DENY_TOOLS = "subagent";
		const { registered, declared, dir } = loadWithWorker(["read", "codemode"]);
		assert.deepEqual(
			declared().filter((name) => name.startsWith("subagent")),
			[],
		);
		const tool = (name: string): RegisteredTool => {
			const found = registered.get(name);
			assert.ok(found, `${name} is registered`);
			return found;
		};
		const ctx = { cwd: dir, hasUI: false, sessionManager: { getSessionId: () => "gating" } };
		const refusal = /This session may not launch agents/;
		await assert.rejects(
			() => tool("subagent_resume").execute("call-1", { sessionFile: join(dir, "x.jsonl") }, undefined, undefined, ctx),
			refusal,
		);
		await assert.rejects(() => tool("subagent_kill").execute("call-2", { id: "worker" }), refusal);
		const agents = await tool("subagent_agents").execute("call-3", {}, undefined, undefined, ctx);
		assert.match(agents.content[0].text, refusal);
	});
});
