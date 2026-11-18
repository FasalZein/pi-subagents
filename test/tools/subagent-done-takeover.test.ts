import { mock } from "node:test";
import {
	assert,
	clearPublishedRunningSubagentCountForTest,
	createTestDir,
	describe,
	existsSync,
	it,
	join,
	readFileSync,
	resetSubagentStateForTest,
	rmSync,
	subagentDoneExtension,
	writeFileSync,
} from "../support/index.ts";

// D11: after a person typed or pressed Esc in a pane child, nothing in the
// child requests shutdown; the ended run is shown in the pane. The takeover
// cases are bugpath replays 6a and 6b (red on cf6dbf4).
const ENV_KEYS = ["PI_SUBAGENT_SESSION", "PI_SUBAGENT_AUTO_EXIT", "PI_SUBAGENT_SURFACE", "PI_SUBAGENT_PROVIDER_RECOVERY_DELAYS_MS"];

function loadChild(options: { autoExit: boolean; pane: boolean }) {
	const handlers = new Map<string, any>();
	const tools = new Map<string, any>();
	const notices: string[] = [];
	let shutdowns = 0;
	const dir = createTestDir();
	const sessionFile = join(dir, "child.jsonl");
	writeFileSync(sessionFile, "");
	process.env.PI_SUBAGENT_SESSION = sessionFile;
	if (options.autoExit) process.env.PI_SUBAGENT_AUTO_EXIT = "1";
	if (options.pane) process.env.PI_SUBAGENT_SURFACE = "fake-pane";
	// Below the 10 s floor, so each recovery window is 10 s of mocked time.
	process.env.PI_SUBAGENT_PROVIDER_RECOVERY_DELAYS_MS = "10,10,10";
	subagentDoneExtension({
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools() {},
		registerTool(definition: { name: string }) {
			tools.set(definition.name, definition);
			return definition;
		},
		registerCommand() {},
		on(event: string, handler: any) {
			handlers.set(event, handler);
		},
		sendUserMessage() {},
		appendEntry() {},
		registerShortcut() {},
	} as any);
	const ctx = {
		isIdle: () => true,
		ui: { setStatus() {}, notify(message: string) { notices.push(message); } },
		shutdown() {
			shutdowns += 1;
		},
	};
	const exitFile = `${sessionFile}.exit`;
	return {
		ctx,
		dir,
		notices,
		tools,
		emit(event: string, payload: unknown) {
			handlers.get(event)?.(payload, ctx);
		},
		takeOver() {
			handlers.get("agent_start")?.({}, ctx);
			handlers.get("input")?.({ source: "interactive", text: "hold on" }, ctx);
		},
		get shutdowns() {
			return shutdowns;
		},
		readExit: () => (existsSync(exitFile) ? JSON.parse(readFileSync(exitFile, "utf8")) : null),
	};
}

function cleanup(dir: string) {
	clearPublishedRunningSubagentCountForTest();
	resetSubagentStateForTest();
	for (const key of ENV_KEYS) delete process.env[key];
	mock.timers.reset();
	rmSync(dir, { recursive: true, force: true });
}

const authErrorEnd = {
	messages: [{ role: "assistant", stopReason: "error", errorMessage: "401 Unauthorized: invalid api key" }],
};
const toolUseEnd = {
	messages: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] }],
};
const retryableErrorEnd = {
	messages: [{ role: "assistant", stopReason: "error", errorMessage: "503 service unavailable" }],
};

function endWithAuthError(child: ReturnType<typeof loadChild>) {
	child.emit("agent_end", authErrorEnd);
	mock.timers.tick(5);
}

function endThreeTimesAtToolCall(child: ReturnType<typeof loadChild>) {
	for (let i = 0; i < 3; i++) {
		child.emit("agent_end", toolUseEnd);
		mock.timers.tick(5);
		child.emit("agent_start", {}); // the "continue" nudge starts the next run
	}
}

function exhaustProviderRecovery(child: ReturnType<typeof loadChild>) {
	for (let i = 0; i < 3; i++) {
		child.emit("agent_end", retryableErrorEnd);
		mock.timers.tick(10_000);
		mock.timers.tick(5);
		child.emit("agent_start", {}); // the recovery nudge starts the next run
	}
}

describe("subagent-done.ts operator takeover (D11)", () => {
	const errorCases = [
		{ name: "a run that ends with a 401 error (replay 6a)", run: endWithAuthError, exitType: "error" },
		{ name: "three runs that end at a tool call (replay 6b)", run: endThreeTimesAtToolCall, exitType: "error" },
		{ name: "provider-recovery exhaustion", run: exhaustProviderRecovery, exitType: "error" },
	];

	for (const testCase of errorCases) {
		it(`after operator input, ${testCase.name} requests no shutdown and writes no exit record`, () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const child = loadChild({ autoExit: true, pane: true });
			try {
				child.takeOver();
				testCase.run(child);
				assert.equal(child.shutdowns, 0);
				assert.equal(child.readExit(), null);
				assert.ok(child.notices.length > 0, "the ended run is shown in the pane");
			} finally {
				cleanup(child.dir);
			}
		});

		it(`without a takeover, ${testCase.name} ends the child with an error outcome`, () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const child = loadChild({ autoExit: true, pane: true });
			try {
				child.emit("agent_start", {});
				testCase.run(child);
				assert.equal(child.shutdowns, 1);
				// A permanent error is stamped when Pi runs session_shutdown.
				child.emit("session_shutdown", { reason: "quit" });
				assert.equal(child.readExit()?.type, testCase.exitType);
			} finally {
				cleanup(child.dir);
			}
		});
	}

	it("after operator input, subagent_done writes no exit record and requests no shutdown", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const child = loadChild({ autoExit: false, pane: false });
		try {
			child.takeOver();
			await child.tools.get("subagent_done").execute("call-1", {}, undefined, undefined, child.ctx);
			mock.timers.tick(5);
			assert.equal(child.shutdowns, 0);
			// No exit record: the parent keeps the run as running and delivers nothing.
			assert.equal(child.readExit(), null);
		} finally {
			cleanup(child.dir);
		}
	});

	it("without a takeover, subagent_done writes a done record and requests shutdown", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const child = loadChild({ autoExit: false, pane: false });
		try {
			child.emit("agent_start", {});
			await child.tools.get("subagent_done").execute("call-1", {}, undefined, undefined, child.ctx);
			mock.timers.tick(5);
			assert.equal(child.shutdowns, 1);
			assert.equal(child.readExit()?.type, "done");
		} finally {
			cleanup(child.dir);
		}
	});
});
