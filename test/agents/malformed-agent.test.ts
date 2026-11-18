import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getEffectiveAgentDefinitions } from "../../src/agents/definitions.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	join,
	loadAgentDefaults,
	mkdirSync,
	resetSubagentStateForTest,
	subagentsExtension,
	writeFileSync,
} from "../support/index.ts";

// D24: one malformed agent file affects only that agent.
const BAD_FRONTMATTER = "name: broken\ndescription: Broken agent\nspawn-depth: 0";
const BAD_ERROR = /spawn-depth must be a positive safe integer/;

function writeAgent(dir: string, file: string, frontmatter: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, file);
	writeFileSync(path, `---\n${frontmatter}\n---\n\nBody.`);
	return path;
}

function setupRoots(): { configDir: string; projectCwd: string; globalAgents: string; projectAgents: string } {
	const dir = createTestDir();
	const configDir = join(dir, "agent-root");
	const projectCwd = join(dir, "project");
	mkdirSync(projectCwd, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = configDir;
	return {
		configDir,
		projectCwd,
		globalAgents: join(configDir, "agents"),
		projectAgents: join(projectCwd, ".pi", "agents"),
	};
}

interface Notice {
	message: string;
	type?: string;
}

function loadExtension(cwd: string): {
	tools: string[];
	startSession: (reason: string) => Notice[];
} {
	const tools: string[] = [];
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const api = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, handler);
		},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		sendMessage() {},
		getThinkingLevel: () => "low",
	} as unknown as ExtensionAPI;
	const prevCwd = process.cwd();
	process.chdir(cwd);
	try {
		subagentsExtension(api);
	} finally {
		process.chdir(prevCwd);
	}
	const startSession = (reason: string) => {
		const notices: Notice[] = [];
		handlers.get("session_start")?.(
			{ type: "session_start", reason },
			{
				cwd,
				hasUI: true,
				ui: {
					setWidget() {},
					notify(message: string, type?: string) {
						notices.push({ message, type });
					},
				},
				sessionManager: { getHeader: () => ({ id: "parent", type: "session", timestamp: "", cwd }) },
			},
		);
		return notices;
	};
	return { tools, startSession };
}

describe("malformed agent files (D24)", () => {
	afterEach(() => resetSubagentStateForTest());

	it("skips one bad file among three: the extension loads and the two good agents resolve for launch", () => {
		const { globalAgents, projectCwd } = setupRoots();
		const alphaPath = writeAgent(globalAgents, "alpha.md", "name: alpha\ndescription: Alpha agent");
		writeAgent(globalAgents, "broken.md", BAD_FRONTMATTER);
		const gammaPath = writeAgent(globalAgents, "gamma.md", "name: gamma\ndescription: Gamma agent");

		assert.deepEqual(
			getEffectiveAgentDefinitions(projectCwd).map((agent) => agent.name),
			["alpha", "gamma"],
		);
		assert.equal(loadAgentDefaults("alpha", undefined, projectCwd)?.path, alphaPath);
		assert.equal(loadAgentDefaults("gamma", undefined, projectCwd)?.path, gammaPath);
		assert.ok(loadExtension(projectCwd).tools.includes("subagent"));
	});

	it("refuses a launch of the bad agent with its parse error text and file path", () => {
		const { globalAgents, projectCwd } = setupRoots();
		writeAgent(globalAgents, "alpha.md", "name: alpha\ndescription: Alpha agent");
		const badPath = writeAgent(globalAgents, "broken.md", BAD_FRONTMATTER);

		assert.throws(
			() => loadAgentDefaults("broken", undefined, projectCwd),
			(error: Error) => BAD_ERROR.test(error.message) && error.message.includes(badPath),
		);
	});

	it("refuses a malformed project file that shadows a valid global agent; the global agent does not start", () => {
		const { globalAgents, projectAgents, projectCwd } = setupRoots();
		writeAgent(globalAgents, "broken.md", "name: broken\ndescription: Valid global agent");
		writeAgent(globalAgents, "alpha.md", "name: alpha\ndescription: Alpha agent");
		const projectBad = writeAgent(projectAgents, "broken.md", BAD_FRONTMATTER);

		assert.throws(
			() => loadAgentDefaults("broken", undefined, projectCwd),
			(error: Error) => BAD_ERROR.test(error.message) && error.message.includes(projectBad),
		);
		assert.deepEqual(
			getEffectiveAgentDefinitions(projectCwd).map((agent) => agent.name),
			["alpha"],
		);
	});

	it("shows one notice per session that names the bad file", () => {
		const { globalAgents, projectCwd } = setupRoots();
		writeAgent(globalAgents, "alpha.md", "name: alpha\ndescription: Alpha agent");
		const badPath = writeAgent(globalAgents, "broken.md", BAD_FRONTMATTER);

		const extension = loadExtension(projectCwd);
		const first = extension.startSession("startup");
		assert.equal(first.length, 1);
		assert.ok(first[0].message.includes(badPath));
		assert.match(first[0].message, BAD_ERROR);
		assert.deepEqual(extension.startSession("reload"), []);
		assert.equal(extension.startSession("new").length, 1);
	});

	it("gives no notice for a disabled bad file", () => {
		const { globalAgents, projectCwd } = setupRoots();
		writeAgent(globalAgents, "alpha.md", "name: alpha\ndescription: Alpha agent");
		writeAgent(globalAgents, "broken.md", `${BAD_FRONTMATTER}\nenabled: false`);

		assert.deepEqual(loadExtension(projectCwd).startSession("startup"), []);
		assert.deepEqual(
			getEffectiveAgentDefinitions(projectCwd, { includeDisabled: true }).map((agent) => agent.name),
			["alpha"],
		);
	});
});
