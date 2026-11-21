import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { consumeSubagentExitSignal } from "../../src/mux/poll.ts";
import { assertResumeAllowed } from "../../src/runtime/resume-guards.ts";
import { getSubagentExitSidecarPath } from "../../src/session/exit-sidecar.ts";
import { createExitSignalWriter } from "../../src/tools/exit-signal.ts";
import { afterEach, assert, beforeEach, createTestDir, describe, it, writeFileSync } from "../support/index.ts";

// Review round 1 (P1): the parent wakes on the exit record and can consume it before the child's
// session_shutdown runs. The verdict the child wrote first stays authoritative: shutdown writes no
// second record and appends no completion marker that replaces the first one.

/** A child session file whose completion markers chain like Pi's entries, so the resume guard reads them. */
function child() {
	const sessionFile = join(createTestDir(), "child.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: "", cwd: "/" })}\n`,
	);
	let parentId: string | null = null;
	let next = 0;
	const markers: unknown[] = [];
	const write = createExitSignalWriter({
		pi: {
			appendEntry(customType: string, data: unknown) {
				const id = `e${++next}`;
				appendFileSync(
					sessionFile,
					`${JSON.stringify({ type: "custom", customType, data, id, parentId, timestamp: "" })}\n`,
				);
				parentId = id;
				markers.push(data);
			},
		} as never,
		getFinalContextUsage: () => undefined,
		hasDeliveredFinalWarning: () => true,
		getFinalOutput: () => undefined,
	});
	process.env.PI_SUBAGENT_SESSION = sessionFile;
	return { sessionFile, write, markers, exitRecordLeft: () => existsSync(getSubagentExitSidecarPath(sessionFile)) };
}

describe("the child's first verdict outlives the parent's read", () => {
	let saved: string | undefined;
	beforeEach(() => {
		saved = process.env.PI_SUBAGENT_SESSION;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.PI_SUBAGENT_SESSION;
		else process.env.PI_SUBAGENT_SESSION = saved;
	});

	it("context pressure: the spent session still refuses a resume after the watcher consumed the answer", () => {
		const c = child();
		assert.equal(c.write({ type: "done", outputTokens: 1 }, { supersede: true }), "accepted");
		assert.equal(consumeSubagentExitSignal(c.sessionFile, "child-may-run")?.completionReason, "context-pressure");
		// session_shutdown after the parent's read.
		assert.equal(c.write({ type: "done", outputTokens: 1 }, { autonomous: false }), "owned");
		assert.deepEqual(c.markers, [{ reason: "context-pressure" }]);
		assert.equal(c.exitRecordLeft(), false, "no stale exit record after shutdown");
		assert.throws(() => assertResumeAllowed(c.sessionFile), /context window is spent/);
	});

	it("ping: shutdown after the parent's read writes no second record", () => {
		const c = child();
		assert.equal(c.write({ type: "ping", name: "w", message: "help" }, { supersede: true }), "accepted");
		assert.equal(consumeSubagentExitSignal(c.sessionFile, "child-may-run")?.reason, "ping");
		assert.equal(c.write({ type: "done", outputTokens: 1, endedBy: "operator" }, { autonomous: false }), "owned");
		assert.deepEqual(c.markers, []);
		assert.equal(c.exitRecordLeft(), false);
	});

	it("error: shutdown after the parent's read writes no second record", () => {
		const c = child();
		assert.equal(c.write({ type: "error", errorMessage: "provider down" }), "accepted");
		assert.equal(consumeSubagentExitSignal(c.sessionFile, "child-may-run")?.reason, "error");
		assert.equal(c.write({ type: "error", errorMessage: "provider down" }), "owned");
		assert.equal(c.exitRecordLeft(), false);
	});

	it("a manual close with no earlier verdict still writes its operator record", () => {
		const c = child();
		assert.equal(c.write({ type: "done", outputTokens: 1, endedBy: "operator" }, { autonomous: false }), "accepted");
		assert.equal(consumeSubagentExitSignal(c.sessionFile, "child-exited")?.closedByOperator, true);
	});
});
