import { AGENT_INDEX_SECTION_NAME } from "../../src/agents/index-section.ts";
import subagentsExtension from "../../src/subagents.ts";
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
	writeFileSync,
} from "../support/index.ts";

type Handler = (...args: unknown[]) => unknown;

// A test runner that is itself a subagent child inherits these; the hooks
// under test must run as a parent.
const CHILD_ENV_KEYS = [
	"PI_SUBAGENT_AGENT",
	"PI_SUBAGENT_PARENT_SESSION",
	"PI_SUBAGENT_NAME",
	"PI_SUBAGENT_SESSION",
	"PI_SUBAGENT_SURFACE",
] as const;

function loadParentExtension(dir: string): Map<string, Handler[]> {
	const configDir = join(dir, "agent-root");
	mkdirSync(join(configDir, "agents"), { recursive: true });
	process.env.PI_CODING_AGENT_DIR = configDir;
	writeFileSync(join(configDir, "agents", "worker.md"), "---\nname: worker\ndescription: Worker\n---\n\nWorker body.");
	const handlers = new Map<string, Handler[]>();
	subagentsExtension({
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		sendMessage() {},
		appendEntry() {},
		getActiveTools: () => ["read", "bash", "subagent"],
		getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "subagent" }],
		setActiveTools() {},
		getThinkingLevel: () => "low",
	} as never);
	return handlers;
}

describe("parent prompt-start hooks", () => {
	const savedChildEnv = Object.fromEntries(CHILD_ENV_KEYS.map((key) => [key, process.env[key]]));
	beforeEach(() => {
		for (const key of CHILD_ENV_KEYS) delete process.env[key];
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(savedChildEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetSubagentStateForTest();
	});

	it("never return a whole system prompt", async () => {
		const dir = createTestDir();
		const handlers = loadParentExtension(dir);
		const ctx = {
			cwd: dir,
			hasUI: false,
			mode: "print",
			ui: { setWidget() {}, notify() {}, setStatus() {} },
			sessionManager: {
				getHeader: () => ({ id: "parent", type: "session", timestamp: "", cwd: dir }),
				getSessionId: () => "parent",
				getSessionFile: () => undefined,
				getBranch: () => [],
				getEntries: () => [],
			},
		};
		for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);

		const event = {
			type: "before_agent_start",
			prompt: "hello",
			systemPrompt: "BASE SYSTEM PROMPT",
			// Pi always passes normalized options, whose sections map exists.
			systemPromptOptions: { sections: {} as Record<string, string> },
		};
		const results = await Promise.all((handlers.get("before_agent_start") ?? []).map((handler) => handler(event, ctx)));
		assert.ok(results.length > 0);
		for (const result of results) {
			assert.equal((result as { systemPrompt?: string } | undefined)?.systemPrompt, undefined);
		}
		assert.match(event.systemPromptOptions.sections[AGENT_INDEX_SECTION_NAME] ?? "", /- worker: Worker/);
	});
});
