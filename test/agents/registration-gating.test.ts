import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runningSubagents } from "../../src/runtime/state.ts";
import { buildResumeSpawnEnv } from "../../src/spawn/policy.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	existsSync,
	it,
	join,
	mkdirSync,
	resetSubagentStateForTest,
	subagentsExtension,
	writeExecutable,
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
 * activates it. Declarations per loadout are checked against real Pi in
 * test/tools/management-tool-loadout.test.ts.
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
		// A resumed child's steer-back delivers its result here.
		sendMessage() {},
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
	return { captured, api, registered, startSession, active };
}

const MANAGEMENT_TOOLS = ["subagent_agents", "subagent_kill", "subagent_resume", "subagent_wait"];

/** Load the extension with one worker agent in a fresh config root and return the bound session. */
function loadWithWorker() {
	const dir = createTestDir();
	const configDir = join(dir, "agent-root");
	writeGlobalAgent(configDir, "name: worker\ndescription: Worker for gating tests");
	process.env.PI_CODING_AGENT_DIR = configDir;
	const session = createCapturingPi();
	const prevCwd = process.cwd();
	process.chdir(dir);
	try {
		subagentsExtension(session.api);
		session.startSession(dir);
		return { ...session, dir };
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
	// test/support/env.ts restores the PI_* keys these tests set.
	afterEach(() => {
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
			// D21: all four register while the extension loads, so Pi's startup
			// decides which are active; the mock throws on the active tool list until the session starts.
			assert.deepEqual([...captured.tools].sort(), [
				"subagent",
				"subagent_agents",
				"subagent_kill",
				"subagent_resume",
				"subagent_wait",
			]);
			startSession(dir);
			assert.deepEqual([...captured.tools].sort(), [
				"subagent",
				"subagent_agents",
				"subagent_kill",
				"subagent_resume",
				"subagent_wait",
			]);
			assert.deepEqual(captured.commands, ["subagents"]);
			assert.deepEqual(captured.shortcuts, ["alt+s"]);
			assert.deepEqual([...captured.renderers].sort(), ["subagent_ping", "subagent_result"]);
			assert.deepEqual([...captured.handlers.keys()].sort(), [
				"agent_before_settle",
				"agent_end",
				"agent_settled",
				"agent_start",
				"before_agent_start",
				// D06: the index fallback when another extension's whole prompt replaces the sections.
				// D11: the old-Herdr settle rule reads the model context, as cf6dbf4 did.
				"context",
				"input",
				"message_end",
				"session_shutdown",
				"session_start",
				"tool_call",
				"tool_result",
				"turn_end",
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
			assert.equal(captured.tools.length, 4, `the other tools stay registered when ${denied} is denied`);
		}
	});

	it("refuses only wait and agents at call time once launch is revoked; stop and resume keep their own grants", async () => {
		// A deferred tool stays callable from a codemode script while it is not
		// active, so wait and agents read the launch grant when called. Stop and
		// resume have their own grants, as in cf6dbf4 (D07): their execute never
		// read the launch tool (`git show cf6dbf4:src/tools/subagent-tools.ts`).
		const { registered, active, dir } = loadWithWorker();
		const tool = (name: string): RegisteredTool => {
			const found = registered.get(name);
			assert.ok(found, `${name} is registered`);
			return found;
		};
		const ctx = { cwd: dir, hasUI: false, sessionManager: { getSessionId: () => "gating" } };
		const refusal = /This session may not launch agents/;
		const settle = (call: Promise<{ content: { text: string }[] }>) =>
			call.then(
				(result) => result.content[0]?.text ?? "",
				(error: Error) => error.message,
			);
		const callAll = async () => ({
			resume: await settle(
				tool("subagent_resume").execute("call-1", { sessionFile: join(dir, "x.jsonl") }, undefined, undefined, ctx),
			),
			kill: await settle(tool("subagent_kill").execute("call-2", { runId: "worker" })),
			agents: await settle(tool("subagent_agents").execute("call-3", {}, undefined, undefined, ctx)),
			wait: await settle(tool("subagent_wait").execute("call-4", {}, undefined, undefined, ctx)),
		});
		for (const text of Object.values(await callAll())) assert.doesNotMatch(text, refusal, "launch granted");
		// The operator deactivates the launch tool after the management tools registered.
		active.delete("subagent");
		const revoked = await callAll();
		assert.match(revoked.agents, refusal, "agents: launch revoked");
		assert.match(revoked.wait, refusal, "wait: launch revoked");
		assert.match(revoked.resume, /Session file not found/, "resume keeps its own grant");
		assert.match(revoked.kill, /not found|No running subagent/i, "stop keeps its own grant");
		assert.doesNotMatch(revoked.kill, refusal);
		active.add("subagent");
		for (const text of Object.values(await callAll())) assert.doesNotMatch(text, refusal, "launch restored");
	});

	it("lets a caller that may stop but not launch stop an existing child (D07)", async () => {
		// cf6dbf4 registered and ran subagent_kill without the launch tool; its reply was
		// `Stopping subagent "<name>" (<id>).` (`git show cf6dbf4:src/tools/subagent-tools.ts`).
		process.env.PI_DENY_TOOLS = "subagent";
		const { registered, dir } = loadWithWorker();
		assert.equal(registered.has("subagent"), false, "launch is denied");
		const kill = registered.get("subagent_kill");
		assert.ok(kill, "stop is registered");
		const running: RunningSubagent = {
			id: "stop-me-1",
			name: "stop-me",
			task: "Wait",
			agent: "worker",
			mode: "background",
			phase: { kind: "running" },
			parentClosePolicy: "terminate",
			async: true,
			startTime: Date.now(),
			sessionFile: join(dir, "stop-me.jsonl"),
		};
		runningSubagents.set(running.id, running);
		const result = await kill.execute("call-kill", { runId: running.id });
		assert.equal(result.content[0]?.text, `Stopping subagent "stop-me" (stop-me-1).`);
		assert.equal(running.phase.kind, "stopping");
	});

	it("lets a caller that may resume but not launch resume a saved session (D07)", async () => {
		// cf6dbf4's resume tool never read the launch tool; a saved session starts its child again.
		process.env.PI_DENY_TOOLS = "subagent";
		const { registered, dir } = loadWithWorker();
		assert.equal(registered.has("subagent"), false, "launch is denied");
		const resume = registered.get("subagent_resume");
		assert.ok(resume, "resume is registered");
		const marker = join(dir, "child-started");
		process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(dir, "marker-pi", `#!/usr/bin/env bash\ntouch '${marker}'\n`);
		process.env.PI_ARTIFACT_PROJECT_ROOT = dir;
		const sessionFile = join(dir, "saved.jsonl");
		const header = { type: "session", version: 3, id: "saved", timestamp: new Date().toISOString(), cwd: dir };
		writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
		const ctx = { cwd: dir, hasUI: true, sessionManager: { getSessionId: () => "gating" } };
		const reply = await resume.execute(
			"call-resume",
			{ sessionFile, agent: "worker", mode: "background" },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(reply.details?.status, "started", JSON.stringify(reply.content));
		await runningSubagents.get(reply.details.id)?.completionPromise;
		assert.equal(existsSync(marker), true, "the resumed child process ran");
	});
});
