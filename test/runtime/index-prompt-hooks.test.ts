import {
	buildSystemPrompt,
	normalizeBuildSystemPromptOptions,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
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
] as const;

function writeAgent(agentsDir: string, name: string, frontmatter: string) {
	writeFileSync(
		join(agentsDir, `${name}.md`),
		`---\nname: ${name}\n${frontmatter}\n---\n\n${name} body.`,
	);
}

function setup() {
	const dir = createTestDir();
	const configDir = join(dir, "agent-root");
	const agentsDir = join(configDir, "agents");
	mkdirSync(agentsDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = configDir;
	writeAgent(
		agentsDir,
		"reviewer",
		"description: Review changes for regressions\nmode: background",
	);
	writeAgent(
		agentsDir,
		"scout",
		"description: Map the code before a change\nmode: background",
	);
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
		getAllTools: () => [
			{ name: "read" },
			{ name: "bash" },
			{ name: "subagent" },
		],
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
		const result = (await handler(event, ctx)) as
			| { message?: unknown; systemPrompt?: string }
			| undefined;
		if (result?.message) messages.push(result.message);
		if (result?.systemPrompt !== undefined)
			options.forceSystemPrompt = result.systemPrompt;
	}
	return {
		prompt: buildSystemPrompt(options),
		section: options.sections.subagent_index,
		forced: options.forceSystemPrompt,
		messages,
	};
}

async function sessionStart(
	handlers: Map<string, Handler[]>,
	ctx: unknown,
	reason: string,
) {
	for (const handler of handlers.get("session_start") ?? [])
		await handler({ type: "session_start", reason }, ctx);
}

describe("agent index at prompt start", () => {
	const saved = Object.fromEntries(
		ENV_KEYS.map((key) => [key, process.env[key]]),
	);
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
		assert.doesNotMatch(
			(await promptStart(start, ctx)).section ?? "",
			/researcher/,
		);
		writeAgent(
			agentsDir,
			"researcher",
			"description: Investigate open questions\nmode: interactive",
		);
		assert.match(
			(await promptStart(start, ctx)).section ?? "",
			/\n- researcher: Investigate open questions \[pane\] \[manual\]\n/,
		);
	});

	it("filters a child's section to what it may launch and gives a child that may launch nothing no section", async () => {
		process.env.PI_SUBAGENT_AGENT = "coordinator";
		process.env.PI_SUBAGENT_SPAWNABLE = "scout";
		const filtered = setup();
		const section = (
			await promptStart(
				filtered.handlers.get("before_agent_start") ?? [],
				filtered.ctx,
			)
		).section;
		assert.match(section ?? "", /- scout: /);
		assert.doesNotMatch(section ?? "", /reviewer/);
		resetSubagentStateForTest();

		process.env.PI_SUBAGENT_SPAWNABLE = "missing-agent";
		const unknownOnly = setup();
		assert.equal(
			(
				await promptStart(
					unknownOnly.handlers.get("before_agent_start") ?? [],
					unknownOnly.ctx,
				)
			).section,
			undefined,
		);
		resetSubagentStateForTest();

		process.env.PI_SUBAGENT_SPAWNABLE = "scout";
		process.env.PI_DENY_TOOLS = "subagent";
		const denied = setup();
		const run = await promptStart(
			denied.handlers.get("before_agent_start") ?? [],
			denied.ctx,
		);
		assert.equal(run.section, undefined);
		assert.doesNotMatch(run.prompt, /subagent_index/);
	});

	for (const order of ["index first", "whole prompt first"] as const) {
		it(`keeps a child's filtered section when its prompt is composed whole (${order})`, async () => {
			process.env.PI_SUBAGENT_AGENT = "coordinator";
			process.env.PI_SUBAGENT_SPAWNABLE = "scout";
			process.env.PI_SUBAGENT_APPEND_SYSTEM_PROMPT = "INHERITED APPENDED TEXT";
			const { handlers, ctx } = setup();
			const index = handlers.get("before_agent_start") ?? [];
			const composeWhole: Handler = (event) =>
				applyChildSystemPromptOverrides(event as never);
			const run = await promptStart(
				order === "index first"
					? [...index, composeWhole]
					: [composeWhole, ...index],
				ctx,
			);
			assert.ok(run.forced, "the child prompt is composed whole");
			assert.match(run.prompt, /INHERITED APPENDED TEXT/);
			assert.match(
				run.prompt,
				/<subagent_index>\nHelpers: launch with subagent[\s\S]*\n- scout: Map the code before a change\n<\/subagent_index>/,
			);
			assert.doesNotMatch(run.prompt, /reviewer/);
			assert.equal(
				run.prompt.split("<subagent_index>").length,
				2,
				"one copy of the section",
			);
		});
	}
});
