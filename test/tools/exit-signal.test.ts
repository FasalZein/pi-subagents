import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createExitSignalWriter, inMemoryFinalOutput } from "../../src/tools/exit-signal.ts";
import { assert, createTestDir, readFileSync, rmSync, writeFileSync } from "../support/index.ts";
import { cleanupPaneChild, loadPaneChild } from "../support/pane-child.ts";

function setup() {
	const dir = createTestDir();
	const sessionFile = join(dir, "child.jsonl");
	writeFileSync(sessionFile, "");
	const entries: Array<{ customType: string; data: unknown }> = [];
	const writeExitSignal = createExitSignalWriter({
		pi: {
			appendEntry(customType: string, data: unknown) {
				entries.push({ customType, data });
			},
		} as never,
		getFinalContextUsage: () => undefined,
		hasDeliveredFinalWarning: () => true,
		getFinalOutput: () => undefined,
	});
	const readSidecar = () => JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8"));
	return { dir, sessionFile, entries, writeExitSignal, readSidecar };
}

describe("child exit signal", () => {
	it("reports the tri-state outcome: accepted for done, accepted for ping without a completion marker, owned for refused", () => {
		const { dir, sessionFile, entries, writeExitSignal } = setup();
		const originalSession = process.env.PI_SUBAGENT_SESSION;
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		try {
			const done = writeExitSignal({ type: "done", outputTokens: 3 });
			assert.equal(done, "accepted");
			assert.equal(entries.length, 1);

			// A fresh session for the accepted-ping case: after a done, a ping
			// write is refused by first-wins semantics.
			const pingSession = join(dir, "ping-child.jsonl");
			writeFileSync(pingSession, "");
			process.env.PI_SUBAGENT_SESSION = pingSession;
			const ping = writeExitSignal({ type: "ping", name: "child", message: "help" }, { supersede: true });
			assert.equal(ping, "accepted");
			// A ping is not a normal completion, so no completion marker is appended.
			assert.equal(entries.length, 1);

			process.env.PI_SUBAGENT_SESSION = sessionFile;
			const refused = writeExitSignal({ type: "ping", name: "child", message: "again" }, { supersede: true });
			assert.equal(refused, "owned");
		} finally {
			if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = originalSession;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns no-session outside a subagent context", () => {
		const { dir, writeExitSignal } = setup();
		const originalSession = process.env.PI_SUBAGENT_SESSION;
		delete process.env.PI_SUBAGENT_SESSION;
		try {
			assert.equal(writeExitSignal({ type: "done", outputTokens: 0 }), "no-session");
		} finally {
			if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = originalSession;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("marks context pressure on a normal completion", () => {
		const { dir, sessionFile, entries, writeExitSignal, readSidecar } = setup();
		const originalSession = process.env.PI_SUBAGENT_SESSION;
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		try {
			writeExitSignal({ type: "done", outputTokens: 3 });

			assert.equal(readSidecar().completionReason, "context-pressure");
			assert.deepEqual(entries.at(-1), {
				customType: "pi-subagent-completion",
				data: { reason: "context-pressure" },
			});
		} finally {
			if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = originalSession;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("records nothing when a ping already owns the outcome", () => {
		const { dir, sessionFile, entries, writeExitSignal, readSidecar } = setup();
		const originalSession = process.env.PI_SUBAGENT_SESSION;
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		try {
			// caller_ping writes its outcome and then requests shutdown, which
			// emits a `done` the sidecar refuses. That refused write must not
			// block the resume caller_ping promises the parent.
			writeExitSignal({ type: "ping", name: "child", message: "need help" });
			writeExitSignal({ type: "done", outputTokens: 0 });

			assert.equal(readSidecar().type, "ping");
			assert.equal(readSidecar().completionReason, undefined);
			assert.deepEqual(entries, [], "a refused exit write must not record an outcome");
		} finally {
			if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = originalSession;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("flags a failure that happened while the context was spent", () => {
		const { dir, sessionFile, entries, writeExitSignal, readSidecar } = setup();
		const originalSession = process.env.PI_SUBAGENT_SESSION;
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		try {
			// A failure is not an instructed wrap-up, but the parent still needs
			// to know the context was spent. This must not record an outcome that
			// blocks resume.
			writeExitSignal({ type: "error", errorMessage: "provider down" });

			assert.equal(readSidecar().completionReason, "context-pressure-failure");
			assert.deepEqual(entries, []);
		} finally {
			if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = originalSession;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not mark a shutdown the child did not decide", () => {
		const { dir, sessionFile, entries, writeExitSignal, readSidecar } = setup();
		const originalSession = process.env.PI_SUBAGENT_SESSION;
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		try {
			// A pane closed by the operator is a lifecycle event, not the child
			// deciding to stop, even if a final warning is still held.
			writeExitSignal({ type: "done", outputTokens: 0 }, { autonomous: false });

			assert.equal(readSidecar().completionReason, undefined);
			assert.deepEqual(entries.at(-1), {
				customType: "pi-subagent-completion",
				data: { reason: "normal" },
			});
		} finally {
			if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = originalSession;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("carries the final text of an in-memory child in its exit record (T73)", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		const originalSession = process.env.PI_SUBAGENT_SESSION;
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		try {
			const writeExitSignal = createExitSignalWriter({
				pi: { appendEntry() {} } as never,
				getFinalContextUsage: () => undefined,
				hasDeliveredFinalWarning: () => false,
				getFinalOutput: () => "final answer\n",
			});
			writeExitSignal({ type: "done", outputTokens: 1 });
			assert.equal(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")).output, "final answer\n");
		} finally {
			if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = originalSession;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still lets a genuine completion supersede an earlier error", () => {
		const { dir, sessionFile, entries, writeExitSignal, readSidecar } = setup();
		const originalSession = process.env.PI_SUBAGENT_SESSION;
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		try {
			writeExitSignal({ type: "error", errorMessage: "provider down" });
			writeExitSignal({ type: "done", outputTokens: 1 }, { supersede: true });

			assert.equal(readSidecar().type, "done");
			assert.equal(readSidecar().completionReason, "context-pressure");
			assert.deepEqual(entries.at(-1)?.data, { reason: "context-pressure" });
		} finally {
			if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = originalSession;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

function assistant(content: object[], stopReason = "stop") {
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
	} as never;
}

/**
 * T73: the text Pi print mode writes to stdout (print-mode.js: each text block of the last message
 * plus a newline, nothing for a failed or non-assistant last message), read from the child's session.
 */
describe("in-memory final output", () => {
	it("is each text block of the last assistant message, as print mode writes it", () => {
		const session = SessionManager.inMemory(process.cwd());
		session.appendMessage(assistant([{ type: "text", text: "early note" }]));
		session.appendMessage(
			assistant([
				{ type: "text", text: "first" },
				{ type: "toolCall", id: "t1", name: "read", arguments: {} },
				{ type: "text", text: "second" },
			]),
		);
		assert.equal(inMemoryFinalOutput(session), "first\nsecond\n");
	});

	it("is nothing for a failed or aborted last answer, a last tool result, or no session", () => {
		for (const stopReason of ["error", "aborted"]) {
			const session = SessionManager.inMemory(process.cwd());
			session.appendMessage(assistant([{ type: "text", text: "partial" }], stopReason));
			assert.equal(inMemoryFinalOutput(session), undefined, stopReason);
		}
		const session = SessionManager.inMemory(process.cwd());
		session.appendMessage(assistant([{ type: "text", text: "calling" }]));
		session.appendMessage({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			content: [{ type: "text", text: "tool output" }],
			isError: false,
			timestamp: Date.now(),
		} as never);
		assert.equal(inMemoryFinalOutput(session), undefined);
		assert.equal(inMemoryFinalOutput(undefined), undefined);
	});

	// The child extension end to end: the exit record of an auto-exit end and of a manual pane close.
	for (const autoExit of [true, false]) {
		it(`a pane child's exit record carries its final text (auto-exit ${autoExit})`, () => {
			const session = SessionManager.inMemory(process.cwd());
			const child = loadPaneChild({ autoExit, pane: true, sessionManager: session });
			try {
				const answer = assistant([{ type: "text", text: "FINAL-ANSWER-9c2e" }]);
				session.appendMessage(answer);
				child.emit("agent_end", { messages: [answer] });
				child.emit("session_shutdown", { reason: "quit" });
				assert.equal(child.readExit()?.output, "FINAL-ANSWER-9c2e\n");
			} finally {
				cleanupPaneChild(child.dir);
			}
		});
	}

	it("is nothing for a persisted session, whose transcript the parent reads", () => {
		const dir = createTestDir();
		try {
			const session = SessionManager.create(dir, dir);
			session.appendMessage(assistant([{ type: "text", text: "answer" }]));
			assert.notEqual(session.getSessionFile(), undefined);
			assert.equal(inMemoryFinalOutput(session), undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
