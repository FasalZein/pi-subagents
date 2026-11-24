import {
	buildSystemPrompt,
	normalizeBuildSystemPromptOptions,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import subagentsExtension from "../../src/subagents.ts";
import { PI_SUBAGENT_TIMEOUT, PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD } from "../../src/tools/timeout-reminders.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	join,
	mkdirSync,
	resetSubagentStateForTest,
	subagentDoneExtension,
	writeFileSync,
} from "../support/index.ts";

// Requirement (owner decision 2026-11-24): AGENTS.md text between
// <!-- pi-subagents:root-only --> and <!-- /pi-subagents:root-only --> reaches
// the root session only; every child session gets the rest of the file.

type Handler = (event: unknown, ctx: unknown) => unknown;

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_DENY_TOOLS",
	"PI_SUBAGENT_AGENT",
	"PI_SUBAGENT_NAME",
	"PI_SUBAGENT_SESSION",
	"PI_SUBAGENT_SPAWNABLE",
	"PI_SUBAGENT_APPEND_SYSTEM_PROMPT",
	"PI_SUBAGENT_SKILL_VISIBILITY",
	PI_SUBAGENT_TIMEOUT,
	PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD,
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	resetSubagentStateForTest();
});

const OPEN = "<!-- pi-subagents:root-only -->";
const CLOSE = "<!-- /pi-subagents:root-only -->";
const GLOBAL_PATH = "/home/me/.pi/agent/AGENTS.md";
const PROJECT_PATH = "/repo/AGENTS.md";

// Shaped like ~/.pi/agent/AGENTS.md: two root-only blocks around shared rules.
const AGENTS_MD = [
	"# Global AGENTS.md",
	"",
	"Defaults for software work.",
	"",
	OPEN,
	"You are the owner of this codebase.",
	"",
	"## Delegation",
	"",
	"- When the user names an agent, launch that agent.",
	CLOSE,
	"",
	"## Design",
	"",
	"- Choose the simplest design.",
	"",
	"## Verification integrity",
	"",
	"1. Make a failing check pass by fixing its cause.",
	"",
	OPEN,
	"## Communication with the user",
	"",
	"I am a junior developer and a bit rusty.",
	CLOSE,
	"",
	"## Formal verification",
	"",
	"- Read the verify skill first.",
	"",
].join("\n");

const AGENTS_MD_FOR_CHILD = [
	"# Global AGENTS.md",
	"",
	"Defaults for software work.",
	"",
	"## Design",
	"",
	"- Choose the simplest design.",
	"",
	"## Verification integrity",
	"",
	"1. Make a failing check pass by fixing its cause.",
	"",
	"## Formal verification",
	"",
	"- Read the verify skill first.",
	"",
].join("\n");

const PROJECT_MD = "# Project\n\nRun npm test.\n";

function collect(load: (pi: never) => void, extra: Record<string, unknown> = {}): Handler[] {
	const handlers: Handler[] = [];
	load({
		on(event: string, handler: Handler) {
			if (event === "before_agent_start") handlers.push(handler);
		},
		registerTool(definition: unknown) {
			return definition;
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		registerFlag() {},
		sendMessage() {},
		sendUserMessage() {},
		appendEntry() {},
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools() {},
		getThinkingLevel: () => "low",
		...extra,
	} as never);
	return handlers;
}

const ctx = {
	cwd: "/repo",
	hasUI: false,
	mode: "print",
	ui: { setWidget() {}, notify() {}, setStatus() {} },
	sessionManager: {
		getHeader: () => ({ id: "session", type: "session", timestamp: "", cwd: "/repo" }),
		getSessionId: () => "session",
		getSessionFile: () => undefined,
		getBranch: () => [],
		getEntries: () => [],
	},
};

/**
 * Run before_agent_start handlers the way Pi 1.5.2 does (ExtensionRunner.emitBeforeAgentStart):
 * one normalized options object, a systemPrompt getter rendered from it, and a returned
 * whole prompt stored as forceSystemPrompt. Returns the prompt Pi sends.
 */
async function promptStart(
	handlers: Handler[],
	contextFiles: Array<{ path: string; content: string }>,
	runCtx: unknown = ctx,
) {
	const base = normalizeBuildSystemPromptOptions({ cwd: "/repo", selectedTools: ["read", "bash"], contextFiles });
	const options = normalizeBuildSystemPromptOptions(base);
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
		const result = (await handler(event, runCtx)) as { systemPrompt?: string } | undefined;
		if (result?.systemPrompt !== undefined) options.forceSystemPrompt = result.systemPrompt;
	}
	return { prompt: buildSystemPrompt(options), base, options };
}

function childHandlers(): Handler[] {
	return collect((pi) => subagentDoneExtension(pi));
}

/** The prompt Pi would build from these context files with no extension at all. */
function plainPrompt(contextFiles: Array<{ path: string; content: string }>): string {
	return buildSystemPrompt(
		normalizeBuildSystemPromptOptions({ cwd: "/repo", selectedTools: ["read", "bash"], contextFiles }),
	);
}

describe("root-only AGENTS.md blocks", () => {
	it("a child gets AGENTS.md without the root-only blocks and with the rest intact", async () => {
		const files = [
			{ path: GLOBAL_PATH, content: AGENTS_MD },
			{ path: PROJECT_PATH, content: PROJECT_MD },
		];
		const run = await promptStart(childHandlers(), files);
		assert.equal(
			run.prompt,
			plainPrompt([
				{ path: GLOBAL_PATH, content: AGENTS_MD_FOR_CHILD },
				{ path: PROJECT_PATH, content: PROJECT_MD },
			]),
		);
		assert.doesNotMatch(run.prompt, /junior developer|pi-subagents:root-only|## Delegation/);
		assert.match(run.prompt, /## Verification integrity/);
		assert.equal(
			run.options.forceSystemPrompt,
			undefined,
			"the change stays in the structured context, no forced prompt",
		);
		assert.equal(run.base.contextFiles[0]?.content, AGENTS_MD, "the loaded base options keep the file text");
	});

	it("a child whose prompt another hook forces whole still loses the blocks", async () => {
		process.env[PI_SUBAGENT_TIMEOUT] = "600";
		process.env[PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD] = "80";
		const earlierForce: Handler = (event) => ({
			systemPrompt: `${(event as { systemPrompt: string }).systemPrompt}\n\nEARLIER EXTENSION`,
		});
		const run = await promptStart([earlierForce, ...childHandlers()], [{ path: GLOBAL_PATH, content: AGENTS_MD }]);
		assert.ok(run.options.forceSystemPrompt, "the prompt is forced whole");
		assert.doesNotMatch(run.prompt, /junior developer|pi-subagents:root-only/);
		assert.match(run.prompt, /## Verification integrity/);
		assert.match(run.prompt, /EARLIER EXTENSION/);
		assert.match(run.prompt, /Time-budget contract|600s|time limit/i);
	});

	it("the root session keeps the root-only blocks", async () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		mkdirSync(join(configDir, "agents"), { recursive: true });
		writeFileSync(
			join(configDir, "agents", "scout.md"),
			"---\nname: scout\ndescription: Map the code\nmode: background\n---\n\nscout body.",
		);
		process.env.PI_CODING_AGENT_DIR = configDir;
		const handlers = collect((pi) => subagentsExtension(pi));
		assert.ok(handlers.length > 0, "the root extension hooks the prompt start");
		const run = await promptStart(handlers, [{ path: GLOBAL_PATH, content: AGENTS_MD }]);
		assert.match(run.prompt, /I am a junior developer/);
		assert.ok(run.prompt.includes(OPEN) && run.prompt.includes(CLOSE));
	});

	for (const [label, content] of [
		["an opening marker without a close", `keep A\n${OPEN}\nkeep B\n`],
		["a closing marker without an open", `keep A\n${CLOSE}\nkeep B\n`],
		["a nested opening marker", `keep A\n${OPEN}\nkeep B\n${OPEN}\nkeep C\n${CLOSE}\n`],
		["a close before the open", `keep A\n${CLOSE}\nkeep B\n${OPEN}\nkeep C\n`],
	] as const) {
		it(`a child keeps a file with ${label} whole and is warned`, async () => {
			const notes: string[] = [];
			const warnCtx = { ...ctx, hasUI: true, ui: { ...ctx.ui, notify: (message: string) => notes.push(message) } };
			const files = [
				{ path: GLOBAL_PATH, content },
				{ path: PROJECT_PATH, content: `${OPEN}\nroot only\n${CLOSE}\nshared\n` },
			];
			const run = await promptStart(childHandlers(), files, warnCtx);
			assert.equal(run.options.contextFiles[0]?.content, content, "the malformed file is left unchanged");
			assert.equal(run.options.contextFiles[1]?.content, "shared\n", "a well-formed file is still stripped");
			assert.equal(notes.length, 1);
			assert.ok(notes[0]?.includes(GLOBAL_PATH), notes[0]);
		});
	}
});
