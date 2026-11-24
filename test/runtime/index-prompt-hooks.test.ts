import { cpSync, rmSync } from "node:fs";
import {
	buildSystemPrompt,
	normalizeBuildSystemPromptOptions,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { AGENT_INDEX_MAX_CHARS, AGENT_INDEX_SECTION_NAME } from "../../src/agents/index-section.ts";
import { shouldUseBackgroundLaunch } from "../../src/launch/policy.ts";
import { forgetMuxDetectionForTest } from "../../src/mux/core.ts";
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
const MANAGEMENT = ["subagent_resume", "subagent_kill", "subagent_agents"];
const LOADOUT: ToolInfoStub[] = [
	{ name: "read" },
	{ name: "bash" },
	{ name: "subagent" },
	...MANAGEMENT.map((name) => ({ name })),
];
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
	tools: { all: ToolInfoStub[]; active: string[] } = { all: LOADOUT, active: LOADOUT.map((tool) => tool.name) },
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

/** The messages of one provider request after every context handler, with the prompt Pi sends. */
async function requestMessages(handlers: Map<string, Handler[]>, systemPrompt: string, messages: unknown[]) {
	let current = messages;
	for (const handler of handlers.get("context") ?? []) {
		// Pi's context ctx always has a session manager; the settle fold reads its branch.
		const ctx = { getSystemPrompt: () => systemPrompt, sessionManager: { getBranch: () => [] } };
		const result = (await handler({ type: "context", messages: current }, ctx)) as { messages?: unknown[] } | undefined;
		current = result?.messages ?? current;
	}
	return current;
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
		forgetMuxDetectionForTest();
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
			/\n- reviewer: Review changes for regressions\n {2}models: any model ref\n- scout: Map the code before a change\n {2}models: any model ref$/,
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
					`<${AGENT_INDEX_SECTION_NAME}>\\nHelpers: launch with subagent[\\s\\S]*\\n- scout: Map the code before a change\\n  models: any model ref\\n</${AGENT_INDEX_SECTION_NAME}>`,
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
		assert.ok(run.rendered.length <= AGENT_INDEX_MAX_CHARS, `${run.rendered.length} characters`);
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
			assert.ok(r.rendered.length <= AGENT_INDEX_MAX_CHARS, `${r.rendered.length} characters`);
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

	it("states pane flags by the launch policy of a UI session without a multiplexer (D06)", async () => {
		// The forced backend is unavailable without TMUX (src/mux/tmux.ts), so the launch runs headless
		// (launch/policy.ts) and the child closes itself (tools/policy.ts).
		process.env.PI_SUBAGENT_MUX = "tmux";
		const tmux = process.env.TMUX;
		delete process.env.TMUX;
		try {
			const { agentsDir, handlers, ctx } = setup();
			writeAgent(agentsDir, "design", "description: Design the change\nmode: interactive\nauto-exit: false");
			const uiCtx = { ...ctx, hasUI: true, mode: "tui" };
			const start = handlers.get("before_agent_start") ?? [];
			// Before any launch: the flags hold only with a multiplexer, and the index says so.
			const before = (await promptStart(start, uiCtx)).section ?? "";
			assert.match(before, /\n- design: Design the change \[pane\] \[manual\]\n/);
			assert.match(before, /\n\[pane\] and \[manual\] need a multiplexer; without one a helper runs headless/);
			// A launch detects the multiplexer; the next prompt states what the launch does.
			assert.equal(
				shouldUseBackgroundLaunch({ agent: "design" } as never, { mode: "interactive" } as never, true),
				true,
			);
			const after = (await promptStart(start, uiCtx)).section ?? "";
			assert.ok(after.split("\n").includes("- design: Design the change"), after);
			assert.doesNotMatch(after, /\[pane\]|\[manual\]/);
		} finally {
			if (tmux !== undefined) process.env.TMUX = tmux;
		}
	});

	for (const order of ["earlier", "later"] as const)
		it(`keeps the index in a parent whose prompt ${order === "earlier" ? "an earlier" : "a later"} handler replaces with literal text (D06)`, async () => {
			const { handlers, ctx } = setup();
			const composeWhole: Handler = () => ({ systemPrompt: "WHOLE PARENT PROMPT" });
			const index = handlers.get("before_agent_start") ?? [];
			const run = await promptStart(order === "earlier" ? [composeWhole, ...index] : [...index, composeWhole], ctx);
			assert.equal(run.prompt, "WHOLE PARENT PROMPT", "the parent's chosen prompt stays as it is");
			const history = [{ role: "user", content: "hello", timestamp: 1 }];
			const request = await requestMessages(handlers, run.prompt, history);
			assert.equal(request.length, 2);
			const [first] = request as Array<{ role: string; content: string }>;
			assert.equal(first.role, "custom");
			assert.match(
				first.content,
				/^<index>\nHelpers: launch with subagent[\s\S]*\n- scout: Map the code before a change\n {2}models: any model ref\n<\/index>$/,
			);
			assert.deepEqual(request[1], history[0]);
		});

	it("adds no index message when the system prompt carries the section", async () => {
		const { handlers, ctx } = setup();
		const run = await promptStart(handlers.get("before_agent_start") ?? [], ctx);
		const history = [{ role: "user", content: "hello", timestamp: 1 }];
		assert.deepEqual(await requestMessages(handlers, run.prompt, history), history);
	});

	it("names only management tools that Pi lets the session call (D06)", async () => {
		const cases: Array<[string, ToolInfoStub[], string[], string]> = [
			[
				"direct",
				LOADOUT,
				["subagent", ...MANAGEMENT],
				"More tools: subagent_resume({runId, task?}), subagent_kill({runId}), subagent_agents({query?, name?}) (search; name: full detail).",
			],
			[
				"excluded by Pi",
				LOADOUT.filter((t) => t.name !== "subagent_agents"),
				["subagent", ...MANAGEMENT],
				"More tools: subagent_resume({runId, task?}), subagent_kill({runId}).",
			],
			["inactive", LOADOUT, ["subagent", "subagent_kill"], "More tools: subagent_kill({runId})."],
			[
				"deferred",
				[{ name: "subagent" }, ...MANAGEMENT.map((name) => ({ name, exposure: "deferred" }))],
				["subagent"],
				"More tools: subagent_resume({runId, task?}), subagent_kill({runId}), subagent_agents({query?, name?}) (search; name: full detail).",
			],
		];
		for (const [label, all, active, line] of cases) {
			const { handlers, ctx } = setup({ all, active });
			const section = (await promptStart(handlers.get("before_agent_start") ?? [], ctx)).section ?? "";
			assert.ok(section.split("\n").includes(line), `${label}\n${section}`);
			assert.ok(!section.includes("subagent_wait"), `${label}: owner 2026-11-24, no wait tool`);
			resetSubagentStateForTest();
		}
	});

	it("lets a coordinator without file tools or subagent_agents find an agent the index has no line for (D06)", async () => {
		// tools: none, extensions: none and deny-tools: subagent_agents leave only the launch tool.
		process.env.PI_SUBAGENT_AGENT = "coordinator";
		process.env.PI_SUBAGENT_SPAWNABLE = "true";
		process.env.PI_DENY_TOOLS = "subagent_agents";
		const { agentsDir, handlers, ctx } = setup({ all: [{ name: "subagent" }], active: ["subagent"] });
		for (let i = 0; i < 80; i++)
			writeAgent(
				agentsDir,
				`agent-${String(i).padStart(3, "0")}`,
				`description: Agent ${i} does one kind of work and reports back.\nmode: background`,
			);
		writeAgent(agentsDir, "hidden", "description: Not for this caller\nmode: background\nvisible-to: root");
		const section = (await promptStart(handlers.get("before_agent_start") ?? [], ctx)).section ?? "";
		assert.ok(section.length + 15 <= AGENT_INDEX_MAX_CHARS, `${section.length}`);
		assert.ok(!/subagent_agents|subagent_wait|More tools|agent files|\.pi\/agents/.test(section), section);
		const lines = section.split("\n");
		assert.ok(!lines.some((line) => line.startsWith("- agent-079: ")), "agent-079 has no line");
		assert.match(lines.at(-1) ?? "", /^More agents: .*\bagent-079\b.*\.$/);
		assert.doesNotMatch(section, /\bhidden\b/);
	});

	it("names a lone descriptionless agent without subagent_agents, and no denied one (T86)", async () => {
		process.env.PI_SUBAGENT_AGENT = "coordinator";
		process.env.PI_SUBAGENT_SPAWNABLE = "true";
		process.env.PI_DENY_TOOLS = "subagent_agents";
		const { agentsDir, handlers, ctx } = setup({ all: [{ name: "subagent" }], active: ["subagent"] });
		for (const name of ["reviewer", "scout"]) rmSync(join(agentsDir, `${name}.md`));
		writeAgent(agentsDir, "solo", "mode: background");
		writeAgent(agentsDir, "hidden", "mode: background\nvisible-to: root");
		const section = (await promptStart(handlers.get("before_agent_start") ?? [], ctx)).section ?? "";
		assert.equal(section.split("\n").at(-1), "More agents: solo.", section);
		assert.doesNotMatch(section, /\bhidden\b/);
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
