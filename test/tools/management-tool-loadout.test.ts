import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	join,
	mkdirSync,
	resetSubagentStateForTest,
	subagentsExtension,
	writeFileSync,
} from "../support/index.ts";
import {
	activatesOnSessionStart,
	type DeclaredTools,
	discoveryExtensions,
	runPiPrompt,
} from "../support/pi-session.ts";

const MANAGEMENT_TOOLS = ["subagent_agents", "subagent_kill", "subagent_resume"];
const SUBAGENT_TOOLS = ["subagent", ...MANAGEMENT_TOOLS];

/** A workspace with one worker agent, so the extension registers its tools. */
function workspace() {
	const dir = createTestDir();
	const agentDir = join(dir, "agent-root");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(join(agentDir, "agents", "worker.md"), "---\nname: worker\ndescription: Worker\n---\n\nWorker body.");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return { dir, agentDir, sessionDir: join(dir, "sessions") };
}

const subagentToolsIn = (request: DeclaredTools | undefined) =>
	(request ?? []).filter((name) => name.startsWith("subagent")).sort();

describe("management tool declarations in a real Pi session (D21)", () => {
	afterEach(() => resetSubagentStateForTest());

	it("declares the management tools on the first request only when no discovery tool is active", async () => {
		const cases = [
			{ name: "neither", defaultTools: undefined, expected: SUBAGENT_TOOLS },
			{ name: "tool search only", defaultTools: ["+tool_search"], expected: ["subagent"] },
			{ name: "codemode", defaultTools: ["+codemode"], expected: ["subagent"] },
		];
		for (const testCase of cases) {
			const { dir, agentDir } = workspace();
			const [first] = await runPiPrompt({
				cwd: dir,
				agentDir,
				extensions: [subagentsExtension, ...discoveryExtensions],
				sessionManager: SessionManager.inMemory(dir),
				defaultTools: testCase.defaultTools,
			});
			assert.deepEqual(subagentToolsIn(first), testCase.expected, testCase.name);
			resetSubagentStateForTest();
		}
	});

	it("defers the management tools when a later startup handler activates codemode or tool search", async () => {
		for (const discovery of ["tool_search", "codemode"]) {
			const { dir, agentDir } = workspace();
			const [first] = await runPiPrompt({
				cwd: dir,
				agentDir,
				extensions: [subagentsExtension, ...discoveryExtensions, activatesOnSessionStart(discovery)],
				sessionManager: SessionManager.inMemory(dir),
			});
			assert.ok(first?.includes(discovery), `${discovery} is declared`);
			assert.deepEqual(subagentToolsIn(first), ["subagent"], `MCP-like startup with ${discovery}`);
			resetSubagentStateForTest();
		}
	});

	/** Record one no-discovery turn, which declares all five tools directly, and return its session file. */
	async function recordDirectTurn(dir: string, agentDir: string, sessionDir: string): Promise<string> {
		const sessionManager = SessionManager.create(dir, sessionDir);
		const [first] = await runPiPrompt({
			cwd: dir,
			agentDir,
			extensions: [subagentsExtension, ...discoveryExtensions],
			sessionManager,
		});
		assert.deepEqual(subagentToolsIn(first), SUBAGENT_TOOLS, "the recorded turn declares all five tools");
		resetSubagentStateForTest();
		const file = sessionManager.getSessionFile();
		assert.ok(file, "the session is saved");
		return file;
	}

	it("keeps a management tool the operator removes off a continued session", async () => {
		for (const removed of MANAGEMENT_TOOLS) {
			const { dir, agentDir, sessionDir } = workspace();
			const file = await recordDirectTurn(dir, agentDir, sessionDir);
			const [first] = await runPiPrompt({
				cwd: dir,
				agentDir,
				extensions: [subagentsExtension, ...discoveryExtensions],
				sessionManager: SessionManager.open(file, sessionDir),
				tools: [`-${removed}`],
			});
			assert.deepEqual(
				subagentToolsIn(first),
				SUBAGENT_TOOLS.filter((name) => name !== removed),
				`pi --continue --tools -${removed}`,
			);
			resetSubagentStateForTest();
		}
	});

	it("drops earlier direct declarations when a continued session gains tool search at startup", async () => {
		const { dir, agentDir, sessionDir } = workspace();
		const file = await recordDirectTurn(dir, agentDir, sessionDir);
		const [first] = await runPiPrompt({
			cwd: dir,
			agentDir,
			extensions: [subagentsExtension, ...discoveryExtensions, activatesOnSessionStart("tool_search")],
			sessionManager: SessionManager.open(file, sessionDir),
		});
		assert.ok(first?.includes("tool_search"), "tool_search is declared");
		assert.deepEqual(subagentToolsIn(first), ["subagent"]);
	});

	it("keeps a management tool that tool search loaded when the session continues", async () => {
		const { dir, agentDir, sessionDir } = workspace();
		const sessionManager = SessionManager.create(dir, sessionDir);
		const requests = await runPiPrompt({
			cwd: dir,
			agentDir,
			extensions: [subagentsExtension, ...discoveryExtensions],
			sessionManager,
			defaultTools: ["+tool_search"],
			replies: [
				fauxAssistantMessage(fauxToolCall("tool_search", { query: "subagent_kill", limit: 1 }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("ok"),
			],
		});
		assert.deepEqual(subagentToolsIn(requests[0]), ["subagent"], "before the search");
		assert.deepEqual(subagentToolsIn(requests[1]), ["subagent", "subagent_kill"], "after the search");
		resetSubagentStateForTest();
		const file = sessionManager.getSessionFile();
		assert.ok(file);
		const [first] = await runPiPrompt({
			cwd: dir,
			agentDir,
			extensions: [subagentsExtension, ...discoveryExtensions],
			sessionManager: SessionManager.open(file, sessionDir),
			defaultTools: ["+tool_search"],
		});
		assert.deepEqual(subagentToolsIn(first), ["subagent", "subagent_kill"]);
	});
});
