import { cpSync } from "node:fs";
import {
	buildSystemPrompt,
	normalizeBuildSystemPromptOptions,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { AGENT_INDEX_SECTION_NAME } from "../../src/agents/index-section.ts";
import { tmuxBackend } from "../../src/mux/tmux.ts";
import subagentsExtension from "../../src/subagents.ts";
import { applyChildSystemPromptOverrides } from "../../src/tools/child-system-prompt.ts";
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

type Handler = (event: unknown, ctx: unknown) => unknown;

// A test runner that is itself a subagent child inherits these; each test
// sets the ones it needs.
const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_DENY_TOOLS",
	"PI_SUBAGENT_AGENT",
	"PI_SUBAGENT_PARENT_SESSION",
	"PI_SUBAGENT_NAME",
	"PI_SUBAGENT_SESSION",
	"PI_SUBAGENT_SURFACE",
	"PI_SUBAGENT_SPAWNABLE",
	"PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE",
	"PI_SUBAGENT_APPEND_SYSTEM_PROMPT",
	"PI_SUBAGENT_SKILL_VISIBILITY",
	"PI_SUBAGENT_MUX",
] as const;

function writeAgent(agentsDir: string, name: string, frontmatter: string) {
	writeFileSync(join(agentsDir, `${name}.md`), `---\nname: ${name}\n${frontmatter}\n---\n\n${name} body.`);
}

type ToolInfoStub = { name: string; exposure?: string };
const LOADOUT: ToolInfoStub[] = [{ name: "read" }, { name: "bash" }, { name: "subagent" }];
const FIXTURE_AGENTS = join(
	import.meta.dirname,
	"..",
	"..",
	"scripts",
	"orchestration-benchmark",
	"agent-fixture",
	"agents",
);

function setup(
	tools: { all: ToolInfoStub[]; active: string[] } = { all: LOADOUT, active: ["read", "bash", "subagent"] },
) {
	const dir = createTestDir();
	const configDir = join(dir, "agent-root");
	const agentsDir = join(configDir, "agents");
	mkdirSync(agentsDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = configDir;
	writeAgent(agentsDir, "reviewer", "description: Review changes for regressions\nmode: background");
	writeAgent(agentsDir, "scout", "description: Map the code before a change\nmode: background");
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
		getActiveTools: () => tools.active,
		getAllTools: () => tools.all,
		setActiveTools() {},
		getThinkingLevel: () => "low",
	} as never);
	const ctx = {
		cwd: dir,
		hasUI: false,
		mode: "print",
		ui: { setWidget() {}, notify() {}, setStatus() {} },
		sessionManager: {
			getHeader: () => ({
				id: "session",
				type: "session",
				timestamp: "",
				cwd: dir,
			}),
			getSessionId: () => "session",
			getSessionFile: () => undefined,
			getBranch: () => [],
			getEntries: () => [],
		},
	};
	return { dir, agentsDir, handlers, ctx };
}

/**
 * Run every before_agent_start handler the way Pi 1.5.2 does: one mutable
 * options object, a systemPrompt getter rendered from it, and a returned
 * whole prompt stored as forceSystemPrompt. Returns the prompt Pi sends and
 * the messages the handlers returned.
 */
async function promptStart(handlers: Handler[], ctx: { cwd: string }) {
	const options = normalizeBuildSystemPromptOptions({
		cwd: ctx.cwd,
		selectedTools: ["read", "bash", "subagent"],
	});
	const messages: unknown[] = [];
	for (const handler of handlers) {
		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			get systemPrompt() {
				return buildSystemPrompt(options);
			},
			systemPromptOptions: options,
		};
		const result = (await handler(event, ctx)) as { message?: unknown; systemPrompt?: string } | undefined;
		if (result?.message) messages.push(result.message);
		if (result?.systemPrompt !== undefined) options.forceSystemPrompt = result.systemPrompt;
	}
	return {
		prompt: buildSystemPrompt(options),
		section: options.sections[AGENT_INDEX_SECTION_NAME],
		// The section as the request carries it, whatever its name.
		rendered: /<(\w+)>\nHelpers: launch with subagent[\s\S]*?\n<\/\1>/.exec(buildSystemPrompt(options))?.[0],
		forced: options.forceSystemPrompt,
		messages,
	};
}

async function sessionStart(handlers: Map<string, Handler[]>, ctx: unknown, reason: string) {
	for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason }, ctx);
}

describe("agent index at prompt start", () => {
	const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	beforeEach(() => {
		for (const key of ENV_KEYS) delete process.env[key];
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetSubagentStateForTest();
	});

	it("writes the same section on two prompt starts and sends no roster message on startup, reload or resume", async () => {
		const { handlers, ctx } = setup();
		const start = handlers.get("before_agent_start") ?? [];
		const sections: unknown[] = [];
		for (const reason of ["startup", "reload", "resume"]) {
			await sessionStart(handlers, ctx, reason);
			for (let i = 0; i < 2; i++) {
				const run = await promptStart(start, ctx);
				assert.deepEqual(run.messages, [], `${reason} sent a message`);
				assert.equal(run.forced, undefined);
				sections.push(run.section);
			}
		}
		assert.ok(typeof sections[0] === "string");
		assert.match(
			sections[0] as string,
			/\n- reviewer: Review changes for regressions\n- scout: Map the code before a change$/,
		);
		for (const section of sections) assert.equal(section, sections[0]);
	});

	it("writes the new line on the next prompt start after an agent file changes", async () => {
		const { agentsDir, handlers, ctx } = setup();
		const start = handlers.get("before_agent_start") ?? [];
		await sessionStart(handlers, ctx, "startup");
		assert.doesNotMatch((await promptStart(start, ctx)).section ?? "", /researcher/);
		writeAgent(agentsDir, "researcher", "description: Investigate open questions\nmode: interactive");
		assert.match((await promptStart(start, ctx)).section ?? "", /\n- researcher: Investigate open questions\n/);
	});

	it("filters a child's section to what it may launch and gives a child that may launch nothing no section", async () => {
		process.env.PI_SUBAGENT_AGENT = "coordinator";
		process.env.PI_SUBAGENT_SPAWNABLE = "scout";
		const filtered = setup();
		const section = (await promptStart(filtered.handlers.get("before_agent_start") ?? [], filtered.ctx)).section;
		assert.match(section ?? "", /- scout: /);
		assert.doesNotMatch(section ?? "", /reviewer/);
		resetSubagentStateForTest();

		process.env.PI_SUBAGENT_SPAWNABLE = "missing-agent";
		const unknownOnly = setup();
		assert.equal(
			(await promptStart(unknownOnly.handlers.get("before_agent_start") ?? [], unknownOnly.ctx)).section,
			undefined,
		);
		resetSubagentStateForTest();

		process.env.PI_SUBAGENT_SPAWNABLE = "scout";
		process.env.PI_DENY_TOOLS = "subagent";
		const denied = setup();
		const run = await promptStart(denied.handlers.get("before_agent_start") ?? [], denied.ctx);
		assert.equal(run.section, undefined);
		assert.doesNotMatch(run.prompt, new RegExp(`<${AGENT_INDEX_SECTION_NAME}>`));
	});

	for (const order of ["index first", "whole prompt first"] as const) {
		it(`keeps a child's filtered section when its prompt is composed whole (${order})`, async () => {
			process.env.PI_SUBAGENT_AGENT = "coordinator";
			process.env.PI_SUBAGENT_SPAWNABLE = "scout";
			process.env.PI_SUBAGENT_APPEND_SYSTEM_PROMPT = "INHERITED APPENDED TEXT";
			const { handlers, ctx } = setup();
			const index = handlers.get("before_agent_start") ?? [];
			const composeWhole: Handler = (event) => applyChildSystemPromptOverrides(event as never);
			const run = await promptStart(order === "index first" ? [...index, composeWhole] : [composeWhole, ...index], ctx);
			assert.ok(run.forced, "the child prompt is composed whole");
			assert.match(run.prompt, /INHERITED APPENDED TEXT/);
			assert.match(
				run.prompt,
				new RegExp(
					`<${AGENT_INDEX_SECTION_NAME}>\\nHelpers: launch with subagent[\\s\\S]*\\n- scout: Map the code before a change\\n</${AGENT_INDEX_SECTION_NAME}>`,
				),
			);
			assert.doesNotMatch(run.prompt, /reviewer/);
			assert.equal(run.prompt.split(`<${AGENT_INDEX_SECTION_NAME}>`).length, 2, "one copy of the section");
		});
	}

	it("keeps the rendered section within the limit for the fixture and for 100 generated or pinned definitions", async () => {
		const fixture = setup();
		cpSync(FIXTURE_AGENTS, fixture.agentsDir, { recursive: true });
		const start = fixture.handlers.get("before_agent_start") ?? [];
		const run = await promptStart(start, fixture.ctx);
		assert.ok(run.rendered);
		assert.ok(run.rendered.length <= 1_600, `${run.rendered.length} characters`);
		for (const name of [
			"architect",
			"cleaner",
			"design",
			"design-builder",
			"github",
			"hardener",
			"researcher",
			"reviewer",
			"scout",
			"worker",
		])
			assert.match(run.rendered, new RegExp(`\\n- ${name}: `), name);
		for (const pinned of [false, true]) {
			const many = setup();
			for (let i = 0; i < 100; i++)
				writeAgent(
					many.agentsDir,
					`agent-${String(i).padStart(3, "0")}`,
					`description: Agent ${i} does one kind of work and reports back with a short summary of the result.\nmode: background${pinned ? "\npinned: true" : ""}`,
				);
			const r = await promptStart(many.handlers.get("before_agent_start") ?? [], many.ctx);
			assert.ok(r.rendered);
			assert.ok(r.rendered.length <= 1_600, `${r.rendered.length} characters`);
			assert.match(r.rendered, /\n\+\d+ more: subagent_agents with a query\n<\/\w+>$/);
		}
	});

	it("never lists the caller, including under a self-only grant", async () => {
		process.env.PI_SUBAGENT_AGENT = "coordinator";
		process.env.PI_SUBAGENT_SPAWNABLE = "true";
		const any = setup();
		writeAgent(any.agentsDir, "coordinator", "description: Coordinate the work\nmode: background\nspawning: true");
		const section = (await promptStart(any.handlers.get("before_agent_start") ?? [], any.ctx)).section;
		assert.match(section ?? "", /- scout: /);
		assert.doesNotMatch(section ?? "", /- coordinator: /);
		resetSubagentStateForTest();

		process.env.PI_SUBAGENT_SPAWNABLE = "coordinator";
		const selfOnly = setup();
		writeAgent(selfOnly.agentsDir, "coordinator", "description: Coordinate the work\nmode: background\nspawning: true");
		assert.equal(
			(await promptStart(selfOnly.handlers.get("before_agent_start") ?? [], selfOnly.ctx)).section,
			undefined,
		);
	});

	it("shows the section only when the session can call the launch tool", async () => {
		const cases: Array<[string, { all: ToolInfoStub[]; active: string[] }, boolean]> = [
			["excluded by Pi", { all: [{ name: "read" }], active: ["read"] }, false],
			["registered but inactive", { all: LOADOUT, active: ["read"] }, false],
			["hidden", { all: [{ name: "subagent", exposure: "hidden" }], active: [] }, false],
			[
				"callable through codemode only",
				{ all: [{ name: "codemode" }, { name: "subagent", exposure: "codemode" }], active: ["codemode"] },
				true,
			],
			["active", { all: LOADOUT, active: ["subagent"] }, true],
		];
		for (const [label, tools, shown] of cases) {
			const { handlers, ctx } = setup(tools);
			const run = await promptStart(handlers.get("before_agent_start") ?? [], ctx);
			assert.equal(run.section !== undefined, shown, label);
			resetSubagentStateForTest();
		}
	});

	it("runs no multiplexer probe at prompt start in a UI session (D06)", async () => {
		process.env.PI_SUBAGENT_MUX = "tmux";
		const probe = tmuxBackend.isAvailable;
		let probes = 0;
		tmuxBackend.isAvailable = () => {
			probes++;
			return true;
		};
		try {
			const { agentsDir, handlers, ctx } = setup();
			writeAgent(agentsDir, "design", "description: Design the change\nmode: interactive\nauto-exit: true");
			const uiCtx = { ...ctx, hasUI: true, mode: "tui" };
			const run = await promptStart(handlers.get("before_agent_start") ?? [], uiCtx);
			assert.equal(probes, 0, "prompt start probed the multiplexer");
			assert.match(run.section ?? "", /\n- design: Design the change \[pane\]\n/);
		} finally {
			tmuxBackend.isAvailable = probe;
		}
	});

	it("keeps the index in a parent whose prompt an earlier handler composed whole (D06)", async () => {
		const { handlers, ctx } = setup();
		const composeWhole: Handler = () => ({ systemPrompt: "WHOLE PARENT PROMPT" });
		const run = await promptStart([composeWhole, ...(handlers.get("before_agent_start") ?? [])], ctx);
		assert.match(run.prompt, /^WHOLE PARENT PROMPT\n\n<index>\nHelpers: launch with subagent/);
		assert.match(
			run.prompt,
			/\n- reviewer: Review changes for regressions\n- scout: Map the code before a change\n<\/index>$/,
		);
	});

	it("points to the agent files instead of a denied subagent_agents (D06)", async () => {
		process.env.PI_DENY_TOOLS = "subagent_agents,subagent_wait";
		const { agentsDir, handlers, ctx } = setup();
		for (let i = 0; i < 40; i++)
			writeAgent(
				agentsDir,
				`agent-${String(i).padStart(3, "0")}`,
				`description: Agent ${i} does one kind of work and reports back.\nmode: background`,
			);
		const section = (await promptStart(handlers.get("before_agent_start") ?? [], ctx)).section ?? "";
		assert.ok(!section.includes("subagent_agents") && !section.includes("subagent_wait"), section);
		assert.match(section, /^Helpers: launch with subagent \(a children list\)\. A result arrives as a message\. /);
		assert.match(section, /\nMore tools: subagent_resume, subagent_kill\.\n/);
		const dirs = `.pi/agents/ or ${join(process.env.PI_CODING_AGENT_DIR ?? "", "agents")}`;
		const last = section.split("\n").at(-1) ?? "";
		assert.match(last, /^\+\d+ more: agent files in /);
		assert.ok(last.endsWith(` in ${dirs}`), last);
	});

	it("flags lines by the launch policy of a print session", async () => {
		const { agentsDir, handlers, ctx } = setup();
		writeAgent(agentsDir, "design", "description: Design the change\nmode: interactive\nauto-exit: false\nasync: true");
		writeAgent(agentsDir, "keeper", "description: Keep running\nmode: background\nauto-exit: false");
		const lines = (await promptStart(handlers.get("before_agent_start") ?? [], ctx)).section?.split("\n") ?? [];
		assert.ok(lines.includes("- design: Design the change"), lines.join("\n"));
		assert.ok(lines.includes("- keeper: Keep running"), lines.join("\n"));
	});
});
