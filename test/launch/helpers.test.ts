import {
	assert,
	buildPiPromptArgsForTest,
	createTestDir,
	describe,
	getShellReadyDelayMs,
	it,
	join,
	mkdirSync,
	subagentsExtension,
	writeFileSync,
} from "../support/index.ts";

describe("launch helpers", () => {
	it("uses a configurable shell-ready delay", () => {
		delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
		assert.equal(getShellReadyDelayMs(), 500);

		process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
		assert.equal(getShellReadyDelayMs(), 2500);

		process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "nope";
		assert.equal(getShellReadyDelayMs(), 500);
	});

	// Pi glues the first plain argument to the @file block: that argument is the task-file note
	// (test/launch/first-message.test.ts), or "" for an empty file, so no skill prompt lands in the
	// first message; the file comes first, so no flag before it can take the note as its value.
	it("puts the file, then one plain message, then skill prompts", () => {
		const task = { kind: "task", path: "/tmp/task.md", text: "do work" } as const;
		const [file, note, ...rest] = buildPiPromptArgsForTest(["debugger", "pua"], task);
		assert.equal(file, "@/tmp/task.md");
		assert.ok(note && !note.startsWith("@") && !note.startsWith("/") && !note.startsWith("-"), note);
		assert.deepEqual(rest, ["/skill:debugger", "/skill:pua"]);
		assert.deepEqual(buildPiPromptArgsForTest(["debugger"], { ...task, text: "" }), [
			"@/tmp/task.md",
			"",
			"/skill:debugger",
		]);
	});

	it("registers set_tab_title only when explicitly enabled", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, "worker.md"), "---\nname: worker\ndescription: Worker\n---\n\nWorker body.");
		process.env.PI_CODING_AGENT_DIR = configDir;
		const original = process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
		const tools = new Map<string, any>();
		delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;

		try {
			subagentsExtension({
				on() {},
				registerCommand() {},
				registerMessageRenderer() {},
				sendMessage() {},
				registerTool(definition: any) {
					tools.set(definition.name, definition);
					return definition;
				},
			} as any);
			assert.equal(tools.has("set_tab_title"), false);

			process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = "1";
			tools.clear();
			subagentsExtension({
				on() {},
				registerCommand() {},
				registerMessageRenderer() {},
				sendMessage() {},
				registerTool(definition: any) {
					tools.set(definition.name, definition);
					return definition;
				},
			} as any);
			assert.equal(tools.has("set_tab_title"), true);
		} finally {
			if (original == null) delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
			else process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = original;
		}
	});
});
