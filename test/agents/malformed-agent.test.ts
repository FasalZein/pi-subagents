import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getEffectiveAgentDefinitions, loadAgentCatalog } from "../../src/agents/definitions.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	join,
	mkdirSync,
	resetSubagentStateForTest,
	SESSION_HEADER,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";

// D24: one malformed agent file affects only that agent.
const BAD_FRONTMATTER = "name: broken\ndescription: Broken agent\nspawn-depth: 0";
const BAD_ERROR = /spawn-depth must be a positive safe integer/;
// A background child under the fake `pi` binary needs no terminal multiplexer.
// A blocking agent (`async: false`) reports "completed", which proves its child ran.
const GOOD = (name: string, async = false) =>
	`name: ${name}\ndescription: ${name} agent\nmode: background\nauto-exit: true\nasync: ${async}`;

function writeAgent(dir: string, file: string, frontmatter: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, file);
	writeFileSync(path, `---\n${frontmatter}\n---\n\nBody.`);
	return path;
}

function setupRoots(): { projectCwd: string; globalAgents: string; projectAgents: string } {
	const dir = createTestDir();
	const configDir = join(dir, "agent-root");
	const projectCwd = join(dir, "project");
	mkdirSync(projectCwd, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = configDir;
	return {
		projectCwd,
		globalAgents: join(configDir, "agents"),
		projectAgents: join(projectCwd, ".pi", "agents"),
	};
}

interface Notice {
	message: string;
	type?: string;
}

type Handler = (...args: unknown[]) => unknown;
// biome-ignore lint/suspicious/noExplicitAny: the registered tool shape is probed dynamically.
type RegisteredTool = { name: string; execute: (...args: any[]) => Promise<any> };

let moduleGeneration = 0;

/**
 * Load the extension the way Pi does on startup and on /reload: Pi disables
 * the module cache, so each load gets a fresh module instance of
 * src/subagents.ts and a fresh factory call.
 */
async function loadExtension(cwd: string, sessionId = `session-${moduleGeneration + 1}`) {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		sendMessage() {},
		appendEntry() {},
		getThinkingLevel: () => "low",
	} as unknown as ExtensionAPI;
	moduleGeneration += 1;
	const module = await import(`../../src/subagents.ts?generation=${moduleGeneration}`);
	const prevCwd = process.cwd();
	process.chdir(cwd);
	try {
		module.default(api);
	} finally {
		process.chdir(prevCwd);
	}
	const notices: Notice[] = [];
	const parentSession = join(cwd, `${sessionId}.jsonl`);
	writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);
	const ctx = {
		cwd,
		hasUI: true,
		mode: "interactive",
		ui: {
			theme: { fg: (_tone: string, text: string) => text, bold: (text: string) => text },
			setWidget() {},
			notify(message: string, type?: string) {
				notices.push({ message, type });
			},
		},
		sessionManager: {
			getHeader: () => ({ id: sessionId, type: "session", timestamp: "", cwd }),
			getSessionId: () => sessionId,
			getSessionFile: () => parentSession,
			getLeafId: () => null,
		},
	};
	const emit = async (event: string, payload: object) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
	};
	const startSession = async (reason: string) => {
		notices.length = 0;
		await emit("session_start", { reason });
		return [...notices];
	};
	return { tools, ctx, emit, startSession };
}

/** A fake `pi` binary: each child exits at once, so its launch completes. */
function useFakePi(): void {
	process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(createTestDir(), "fake-pi", "#!/bin/sh\nexit 0\n");
}

/**
 * One parent turn through the public surface, as Pi runs it: message_end for
 * the whole assistant message, then the tool_call hook and the tool execute
 * for each subagent call. Returns each launch's result or its refusal.
 */
async function runTurn(
	extension: Awaited<ReturnType<typeof loadExtension>>,
	calls: Array<{ name: string; arguments: Record<string, unknown> }>,
) {
	const content = calls.map((call, index) => ({ type: "toolCall", id: `call-${index}`, ...call }));
	try {
		await extension.emit("message_end", { message: { role: "assistant", content } });
	} catch {
		// Pi's runner reports a message_end handler error and runs the tools anyway.
	}
	const outcomes: Array<{ status?: string; error?: string }> = [];
	for (const call of content) {
		if (call.name !== "subagent") continue;
		try {
			await extension.emit("tool_call", { toolName: call.name, toolCallId: call.id, input: call.arguments });
			const result = await extension.tools
				.get("subagent")
				?.execute(call.id, call.arguments, undefined, undefined, extension.ctx);
			outcomes.push({ status: result.details.status });
		} catch (error) {
			outcomes.push({ error: (error as Error).message });
		}
	}
	return outcomes;
}

/** Hooks without an explicit cwd resolve project agents from process.cwd(), as in Pi. */
async function withCwd<T>(cwd: string, run: () => Promise<T>): Promise<T> {
	const prevCwd = process.cwd();
	process.chdir(cwd);
	try {
		return await run();
	} finally {
		process.chdir(prevCwd);
	}
}

function launch(agent: string) {
	return { name: "subagent", arguments: { agent, name: `${agent}-1`, title: agent, task: "Do the work" } };
}

describe("malformed agent files (D24)", () => {
	afterEach(() => resetSubagentStateForTest());

	it("launches the two good agents among three through the public tool and refuses the bad one with its error and path", async () => {
		const { globalAgents, projectCwd } = setupRoots();
		writeAgent(globalAgents, "alpha.md", GOOD("alpha"));
		const badPath = writeAgent(globalAgents, "broken.md", BAD_FRONTMATTER);
		writeAgent(globalAgents, "gamma.md", GOOD("gamma"));
		useFakePi();

		const extension = await loadExtension(projectCwd);
		await extension.startSession("startup");
		const [alpha] = await runTurn(extension, [launch("alpha")]);
		const [gamma] = await runTurn(extension, [launch("gamma")]);
		const [broken] = await runTurn(extension, [launch("broken")]);

		assert.deepEqual([alpha, gamma], [{ status: "completed" }, { status: "completed" }]);
		assert.match(broken.error ?? "", BAD_ERROR);
		assert.ok(broken.error?.includes(badPath));
	});

	for (const [label, content] of [
		["an invalid field", `---\n${BAD_FRONTMATTER}\n---\n\nBody.`],
		["no closing frontmatter delimiter", "---\nname: broken\ndescription: Unterminated\n\nBody."],
	] as const) {
		it(`refuses a project file with ${label} that shadows a valid global agent; the global agent does not start`, async () => {
			const { globalAgents, projectAgents, projectCwd } = setupRoots();
			writeAgent(globalAgents, "broken.md", GOOD("broken"));
			writeAgent(globalAgents, "alpha.md", GOOD("alpha"));
			mkdirSync(projectAgents, { recursive: true });
			const projectBad = join(projectAgents, "broken.md");
			writeFileSync(projectBad, content);
			useFakePi();

			const extension = await loadExtension(projectCwd);
			const notices = await extension.startSession("startup");
			const [broken] = await withCwd(projectCwd, () => runTurn(extension, [launch("broken")]));

			assert.equal(broken.status, undefined, "the global agent must not launch in place of the project file");
			assert.ok(broken.error?.includes(projectBad), broken.error);
			assert.equal(notices.length, 1);
			assert.ok(notices[0].message.includes(projectBad));
			assert.deepEqual(
				getEffectiveAgentDefinitions(projectCwd).map((agent) => agent.name),
				["alpha"],
			);
		});
	}

	it("does not treat plain Markdown without an opening frontmatter delimiter as an agent", () => {
		const { globalAgents, projectAgents, projectCwd } = setupRoots();
		writeAgent(globalAgents, "alpha.md", GOOD("alpha"));
		mkdirSync(projectAgents, { recursive: true });
		writeFileSync(join(projectAgents, "notes.md"), "# Notes\n\n---\n\nNot an agent.");

		const catalog = loadAgentCatalog(projectCwd);
		assert.deepEqual(catalog.malformedFiles, []);
		assert.equal(catalog.lookup("notes"), undefined);
	});

	it("shows one notice per session: a real /reload in the same session shows none, a new session shows it again", async () => {
		const { globalAgents, projectCwd } = setupRoots();
		writeAgent(globalAgents, "alpha.md", GOOD("alpha"));
		const badPath = writeAgent(globalAgents, "broken.md", BAD_FRONTMATTER);

		const first = await (await loadExtension(projectCwd, "reload-a")).startSession("startup");
		assert.equal(first.length, 1);
		assert.ok(first[0].message.includes(badPath));
		assert.match(first[0].message, BAD_ERROR);
		assert.deepEqual(await (await loadExtension(projectCwd, "reload-a")).startSession("reload"), []);
		assert.equal((await (await loadExtension(projectCwd, "reload-b")).startSession("new")).length, 1);
	});

	it("gives the good async sibling of a malformed launch its wait barrier in a mixed turn", async () => {
		const { globalAgents, projectCwd } = setupRoots();
		writeAgent(globalAgents, "good.md", GOOD("good", true));
		const badPath = writeAgent(globalAgents, "broken.md", BAD_FRONTMATTER);
		useFakePi();

		const extension = await loadExtension(projectCwd);
		await extension.startSession("startup");
		await extension.emit("agent_end", {});
		const [broken, good] = await runTurn(extension, [
			launch("broken"),
			launch("good"),
			{ name: "read", arguments: { path: "README.md" } },
		]);

		assert.ok(broken.error?.includes(badPath), broken.error);
		assert.match(broken.error ?? "", BAD_ERROR);
		assert.deepEqual(good, { status: "completed" });
	});

	it("gives no notice for a disabled bad file", async () => {
		const { globalAgents, projectCwd } = setupRoots();
		writeAgent(globalAgents, "alpha.md", GOOD("alpha"));
		writeAgent(globalAgents, "broken.md", `${BAD_FRONTMATTER}\nenabled: false`);

		assert.deepEqual(await (await loadExtension(projectCwd)).startSession("startup"), []);
		assert.deepEqual(
			getEffectiveAgentDefinitions(projectCwd, { includeDisabled: true }).map((agent) => agent.name),
			["alpha"],
		);
	});
});
