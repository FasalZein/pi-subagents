import { mock } from "node:test";
import { assert, describe, it } from "../support/index.ts";
import { cleanupPaneChild as cleanup, loadPaneChild as loadChild } from "../support/pane-child.ts";

// D11: after a person typed or pressed Esc in a pane child, nothing in the
// child requests shutdown; the ended run is shown in the pane. The takeover
// cases are bugpath replays 6a and 6b (red on cf6dbf4).
const authErrorEnd = {
	messages: [{ role: "assistant", stopReason: "error", errorMessage: "401 Unauthorized: invalid api key" }],
};
const toolUseEnd = {
	messages: [
		{
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
		},
	],
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

const contextOverflowEnd = {
	messages: [
		{
			role: "assistant",
			provider: "openai",
			model: "gpt-test",
			stopReason: "error",
			errorMessage: "Your input exceeds the context window of this model",
		},
	],
};
const answerEnd = {
	messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Fixed." }] }],
};
const ESCAPE = "\x1b";

function startOverflowCompaction(child: ReturnType<typeof loadChild>) {
	const compaction = new AbortController();
	child.emit("agent_end", contextOverflowEnd);
	child.emit("session_before_compact", { reason: "overflow", willRetry: true, signal: compaction.signal });
	return compaction;
}

function quitPane(child: ReturnType<typeof loadChild>) {
	child.emit("session_shutdown", { reason: "quit" });
	return child.readExit();
}

// Fix round 1 of the T32 review: each case is red on ecf4fb2.
describe("subagent-done.ts takeover without a submitted input (finding 1)", () => {
	it("Esc during overflow compaction keeps the pane open and shows the error", () => {
		mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		const child = loadChild({ autoExit: true, pane: true });
		try {
			child.emit("agent_start", {});
			const compaction = startOverflowCompaction(child);
			// Pi's TUI runs extension key listeners before the editor's Escape
			// handler calls abortCompaction().
			child.press(ESCAPE);
			compaction.abort();
			mock.timers.tick(5);
			assert.equal(child.shutdowns, 0);
			assert.equal(child.readExit(), null);
			assert.ok(child.notices.includes("Your input exceeds the context window of this model"));
			assert.match(quitPane(child)?.errorMessage ?? "", /exceeds the context window/);
		} finally {
			cleanup(child.dir);
		}
	});

	it("a compaction abort without a pane key still ends the child with the error", () => {
		mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		const child = loadChild({ autoExit: true, pane: true });
		try {
			child.emit("agent_start", {});
			startOverflowCompaction(child).abort();
			mock.timers.tick(5);
			assert.equal(child.shutdowns, 1);
			assert.equal(child.readExit()?.type, "error");
		} finally {
			cleanup(child.dir);
		}
	});

	it("Esc during a recovery countdown stops the nudges and keeps the pane open", () => {
		mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		const child = loadChild({ autoExit: true, pane: true });
		try {
			child.emit("agent_start", {});
			child.emit("agent_end", retryableErrorEnd);
			child.press(ESCAPE);
			mock.timers.tick(40_000);
			assert.deepEqual(child.nudges, []);
			assert.equal(child.shutdowns, 0);
			assert.equal(child.readExit(), null);
			assert.equal(quitPane(child)?.errorMessage, "503 service unavailable");
		} finally {
			cleanup(child.dir);
		}
	});

	it("typing before Enter takes over the pane", () => {
		mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		const child = loadChild({ autoExit: true, pane: true });
		try {
			child.emit("agent_start", {});
			child.press("h");
			endWithAuthError(child);
			assert.equal(child.shutdowns, 0);
			assert.equal(child.readExit(), null);
		} finally {
			cleanup(child.dir);
		}
	});

	for (const report of [
		{ name: "a focus report", data: "\x1b[I" },
		{ name: "a mouse report", data: "\x1b[<0;10;5M" },
	]) {
		it(`${report.name} is not a takeover`, () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const child = loadChild({ autoExit: true, pane: true });
			try {
				child.emit("agent_start", {});
				child.press(report.data);
				endWithAuthError(child);
				assert.equal(child.shutdowns, 1);
			} finally {
				cleanup(child.dir);
			}
		});
	}
});

describe("subagent-done.ts kept error after a takeover (finding 2)", () => {
	const cases = [
		{ name: "three tool-call endings", run: endThreeTimesAtToolCall, error: /3 consecutive tool-use boundary endings/ },
		{
			name: "provider-recovery exhaustion",
			run: exhaustProviderRecovery,
			error: /recovery exhausted after 3 .*503 service unavailable/,
		},
		{ name: "a 401 error", run: endWithAuthError, error: /401 Unauthorized/ },
	];
	for (const testCase of cases) {
		it(`closing the pane after ${testCase.name} writes that error`, () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const child = loadChild({ autoExit: true, pane: true });
			try {
				child.takeOver();
				testCase.run(child);
				const exit = quitPane(child);
				assert.equal(exit?.type, "error");
				assert.match(exit?.errorMessage ?? "", testCase.error);
			} finally {
				cleanup(child.dir);
			}
		});
	}

	it("a later successful answer clears the kept error", () => {
		mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		const child = loadChild({ autoExit: true, pane: true });
		try {
			child.takeOver();
			endThreeTimesAtToolCall(child);
			child.emit("agent_end", answerEnd);
			assert.equal(quitPane(child)?.type, "done");
		} finally {
			cleanup(child.dir);
		}
	});
});

describe("subagent-done.ts deferred error shutdown (finding 3)", () => {
	const cases = [
		{ name: "a 401 error", end: (child: ReturnType<typeof loadChild>) => child.emit("agent_end", authErrorEnd) },
		{
			name: "the third tool-call ending",
			end: (child: ReturnType<typeof loadChild>) => {
				for (let i = 0; i < 3; i++) child.emit("agent_end", toolUseEnd);
			},
		},
	];
	for (const testCase of cases) {
		it(`operator input after ${testCase.name} and before the deferred shutdown keeps the pane`, () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const child = loadChild({ autoExit: true, pane: true });
			try {
				child.emit("agent_start", {});
				testCase.end(child);
				child.emit("input", { source: "interactive", text: "wait", streamingBehavior: undefined });
				mock.timers.tick(5);
				assert.equal(child.shutdowns, 0);
				assert.equal(child.readExit(), null);
				assert.equal(quitPane(child)?.type, "error");
			} finally {
				cleanup(child.dir);
			}
		});

		it(`operator input before ${testCase.name} keeps the pane`, () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const child = loadChild({ autoExit: true, pane: true });
			try {
				child.takeOver();
				testCase.end(child);
				mock.timers.tick(5);
				assert.equal(child.shutdowns, 0);
				assert.equal(child.readExit(), null);
				assert.equal(quitPane(child)?.type, "error");
			} finally {
				cleanup(child.dir);
			}
		});
	}
});
