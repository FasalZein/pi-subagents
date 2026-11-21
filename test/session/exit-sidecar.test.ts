import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { consumeSubagentExitSignal } from "../../src/mux/poll.ts";
import {
	clearSubagentExitSidecar,
	getSubagentExitSidecarPath,
	holdSubagentExitSidecar,
	releaseSubagentExitSidecar,
	writeSubagentExitSidecar,
} from "../../src/session/exit-sidecar.ts";
import { assert, createTestDir } from "../support/index.ts";

describe("subagent exit sidecars", () => {
	it("stores exit sidecars next to the child session and consumes them once", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		const exitFile = getSubagentExitSidecarPath(sessionFile);
		writeFileSync(sessionFile, "");
		writeFileSync(exitFile, JSON.stringify({ type: "done", outputTokens: 7 }));

		assert.equal(exitFile, `${sessionFile}.exit`);
		assert.deepEqual(consumeSubagentExitSignal(sessionFile, "child-may-run"), {
			reason: "done",
			exitCode: 0,
			outputTokens: 7,
		});
		assert.equal(existsSync(exitFile), false);
		assert.equal(consumeSubagentExitSignal(sessionFile, "child-may-run"), null);
	});

	it("supersedes only existing error signals when requested", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		const exitFile = getSubagentExitSidecarPath(sessionFile);

		for (const replacement of [
			{ type: "done", outputTokens: 8 },
			{ type: "ping", message: "help" },
		]) {
			writeFileSync(exitFile, JSON.stringify({ type: "error", errorMessage: "transient" }));
			writeSubagentExitSidecar(sessionFile, replacement, { supersede: true });
			assert.deepEqual(JSON.parse(readFileSync(exitFile, "utf8")), replacement);
		}
	});

	it("never supersedes existing done or ping signals", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		const exitFile = getSubagentExitSidecarPath(sessionFile);

		for (const existing of [{ type: "done" }, { type: "ping", message: "help" }]) {
			writeFileSync(exitFile, JSON.stringify(existing));
			writeSubagentExitSidecar(sessionFile, { type: "done", outputTokens: 8 }, { supersede: true });
			assert.deepEqual(JSON.parse(readFileSync(exitFile, "utf8")), existing);
		}
	});

	it("replaces an unreadable sidecar with a genuine completion", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		const exitFile = getSubagentExitSidecarPath(sessionFile);
		const completion = { type: "done", outputTokens: 8 };
		writeFileSync(exitFile, "{truncated");

		writeSubagentExitSidecar(sessionFile, completion, { supersede: true });

		assert.deepEqual(JSON.parse(readFileSync(exitFile, "utf8")), completion);
	});

	it("keeps first-write-wins behavior by default", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		const exitFile = getSubagentExitSidecarPath(sessionFile);
		const error = { type: "error", errorMessage: "failure" };
		writeFileSync(exitFile, JSON.stringify(error));

		writeSubagentExitSidecar(sessionFile, { type: "done" });

		assert.deepEqual(JSON.parse(readFileSync(exitFile, "utf8")), error);
	});

	// T85: both pane pollers read through consumeSubagentExitSignal; a record held by a takeover is
	// the child's answer, not proof that the child exited.
	it("a held record waits for the real close while the child may run", () => {
		const sessionFile = join(createTestDir(), "child.jsonl");
		writeSubagentExitSidecar(sessionFile, { type: "done", outputTokens: 5 });
		holdSubagentExitSidecar(sessionFile);
		assert.equal(consumeSubagentExitSignal(sessionFile, "child-may-run"), null);
		assert.equal(releaseSubagentExitSidecar(sessionFile, { endedBy: "operator" }), true);
		assert.deepEqual(consumeSubagentExitSignal(sessionFile, "child-may-run"), {
			reason: "done",
			exitCode: 0,
			outputTokens: 5,
			closedByOperator: true,
		});
	});

	it("a held record that the child never released is the operator's close once the child is gone", () => {
		const sessionFile = join(createTestDir(), "child.jsonl");
		writeSubagentExitSidecar(sessionFile, { type: "ping", name: "w", message: "Which key?" });
		holdSubagentExitSidecar(sessionFile);
		assert.deepEqual(consumeSubagentExitSignal(sessionFile, "child-exited"), {
			reason: "ping",
			exitCode: 0,
			ping: { name: "w", message: "Which key?" },
			closedByOperator: true,
		});
	});

	it("hold and release do nothing without a record, and release needs a held one", () => {
		const sessionFile = join(createTestDir(), "child.jsonl");
		holdSubagentExitSidecar(sessionFile);
		assert.equal(existsSync(getSubagentExitSidecarPath(sessionFile)), false, "a consumed record is not recreated");
		assert.equal(releaseSubagentExitSidecar(sessionFile, {}), false);
		writeSubagentExitSidecar(sessionFile, { type: "done" });
		assert.equal(releaseSubagentExitSidecar(sessionFile, { endedBy: "operator" }), false);
		assert.deepEqual(consumeSubagentExitSignal(sessionFile, "child-may-run"), { reason: "done", exitCode: 0 });
	});

	it("clears stale sidecars before reusing a session path", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "resumed-child.jsonl");
		const exitFile = getSubagentExitSidecarPath(sessionFile);
		writeFileSync(sessionFile, "");
		writeFileSync(exitFile, JSON.stringify({ type: "done", outputTokens: 99 }));

		clearSubagentExitSidecar(sessionFile);

		assert.equal(existsSync(exitFile), false);
		assert.equal(consumeSubagentExitSignal(sessionFile, "child-may-run"), null);
		writeFileSync(exitFile, JSON.stringify({ type: "done", outputTokens: 3 }));
		assert.equal(readFileSync(exitFile, "utf8"), JSON.stringify({ type: "done", outputTokens: 3 }));
	});
});
