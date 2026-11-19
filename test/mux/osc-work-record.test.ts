import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatProgramStatus } from "@earendil-works/pi-tui";
import { herdrCoreBackend } from "../../src/mux/herdr-core.ts";
import { createOscWorkReporter, type OscRecordBackend, WORK_RECORD_ID } from "../../src/mux/osc-work-record.ts";
import { rexBackend } from "../../src/mux/rex.ts";
import { groupRunEnds, type RunEndMessage } from "../../src/runtime/run-end-message.ts";
import { wireSubagentSteerBack } from "../../src/runtime/running-registry.ts";
import { resetRuntimeStateForTest, runningSubagents } from "../../src/runtime/state.ts";
import { registerOutstandingWorkReporting } from "../../src/runtime/work-reporting.ts";
import { registerSubagentWaitTool } from "../../src/tools/wait-tool.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { createTestDir, recordOscOnStdout, writeExecutable } from "../support/index.ts";

type Record = { state: string; msg?: string };

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
/** One OSC 7501 report ended by ST. */
const OSC_7501 = new RegExp(`${ESC}\\]7501;([^${BEL}${ESC}]*)${ESC}\\\\`, "g");

/**
 * A fake OSC 7501 terminal, modeled on the stored shape that hc showed live (live-hc-window-checks.md):
 * the root record (no id) and side records by id; `state=clear` removes the record it names.
 * A root clear removes every side record too, as both herdr-core and Rex do (T50 review, P1 #2).
 */
class FakeTerminal {
	readonly isTTY = true;
	root: Record | undefined;
	readonly records = new Map<string, Record>();
	readonly writes: string[] = [];
	write(chunk: string | Uint8Array): boolean {
		const data = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		this.writes.push(data);
		for (const match of data.matchAll(OSC_7501)) {
			const pairs = new Map(match[1].split(":").map((pair) => pair.split("=", 2) as [string, string]));
			const id = pairs.get("id");
			const state = pairs.get("state") ?? "";
			const msg = pairs.get("msg");
			const record = { state, ...(msg ? { msg: Buffer.from(msg, "base64").toString("utf8") } : {}) };
			if (id === undefined && state === "clear") {
				this.root = undefined;
				this.records.clear();
			} else if (id === undefined) this.root = record;
			else if (state === "clear") this.records.delete(id);
			else this.records.set(id, record);
		}
		return true;
	}
	/** The count the extension's record shows, 0 when there is no record. */
	get count(): number {
		const record = this.records.get(WORK_RECORD_ID);
		return record ? Number.parseInt(record.msg ?? "", 10) : 0;
	}
}

const HC_ENV = { HC_TERMINAL_ID: "t7", HC_TERMINAL_SOCKET: "/tmp/hc.sock" };
const REX_ENV = { REX_SESSION: "s1", REX_BLOCK: "block:parent" };
const OLD_HERDR_ENV = { HERDR_ENV: "1", HERDR_PANE_ID: "p1" };
/** The backend's launch check, passed: these tests drive the writer, not detection (herdr-core-detection.test.ts). */
const USABLE = async () => true;
const session = (mode = "tui") => ({ mode, sessionManager: { getSessionFile: () => "parent.jsonl" } });

function child(id: string): RunningSubagent {
	return {
		id,
		name: id,
		task: "test",
		mode: "background",
		phase: "running",
		parentClosePolicy: "terminate",
		async: true,
		sessionFile: "child.jsonl",
		startTime: Date.now(),
	};
}

const done = (running: RunningSubagent) =>
	Promise.resolve({ name: running.name, task: running.task, summary: "done", exitCode: 0, elapsed: 1 });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function harness(backend: OscRecordBackend) {
	resetRuntimeStateForTest(() => {});
	const terminal = new FakeTerminal();
	// Pi's own root record, written before the extension starts.
	terminal.write(formatProgramStatus({ state: "idle", app: "pi" }));
	const piRoot = terminal.root;
	const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const messages: object[] = [];
	// SAFETY: These are the only Pi boundary methods used by reporting and result routing.
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => events.set(name, handler),
		sendMessage: (message: object) => {
			messages.push(message);
		},
	} as unknown as ExtensionAPI;
	// SAFETY: Lifecycle test context deliberately excludes unrelated UI/provider methods.
	const ctx = { ...session(), isIdle: () => true } as unknown as ExtensionContext;
	const env = backend === "herdr-core" ? HC_ENV : REX_ENV;
	const reporting = registerOutstandingWorkReporting(pi, (c) =>
		createOscWorkReporter(c, backend, USABLE, env, terminal),
	);
	await reporting.start(ctx);
	return {
		pi,
		terminal,
		piRoot,
		messages,
		emit: async (name: string, event = {}) => {
			await events.get(name)?.(event, ctx);
		},
		commit: async (message: object) => {
			await events.get("message_end")?.({ message: { ...message, role: "custom" } }, ctx);
		},
		stop: async () => {
			await reporting.stop();
			resetRuntimeStateForTest(() => {});
		},
	};
}

for (const backend of ["herdr-core", "rex"] as const) {
	test(`${backend}: two launches write the count 2 until the message with both results is committed, then clear it`, async () => {
		const h = await harness(backend);
		try {
			const [first, second] = [child("first"), child("second")];
			runningSubagents.set(first.id, first);
			runningSubagents.set(second.id, second);
			await h.emit("tool_result");
			assert.equal(h.terminal.count, 2);
			assert.deepEqual(h.terminal.records.get(WORK_RECORD_ID), { state: "working", msg: "2 children" });
			for (const running of [first, second]) wireSubagentSteerBack(h.pi, running, done(running), () => {});
			await tick();
			await h.emit("agent_settled");
			assert.equal(runningSubagents.size, 0);
			assert.equal(h.terminal.count, 2, "queued results still count");
			await h.commit(groupRunEnds(h.messages as RunEndMessage[]));
			await h.emit("agent_settled");
			assert.equal(h.terminal.records.has(WORK_RECORD_ID), false, "cleared at zero");
			assert.deepEqual(h.terminal.root, h.piRoot, "Pi's root record is unchanged");
		} finally {
			await h.stop();
		}
	});
}

test("through the subagent_wait tool: runs in a long wait count, and an aborted wait leaves its running runs counted", async () => {
	const h = await harness("herdr-core");
	try {
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ details: { status: string } }> }>();
		(h.pi as unknown as { registerTool: (tool: { name: string }) => void }).registerTool = (tool) =>
			tools.set(tool.name, tool as never);
		registerSubagentWaitTool(h.pi, () => true, { mayLaunch: () => true });
		const never = new Promise<never>(() => {});
		const [waited, other] = [child("waited"), child("other")].map((running) => ({
			...running,
			completionPromise: never,
		}));
		runningSubagents.set(waited.id, waited);
		runningSubagents.set(other.id, other);
		await h.emit("tool_result");
		assert.equal(h.terminal.count, 2);
		const abort = new AbortController();
		const toolCtx = {
			cwd: createTestDir(),
			sessionManager: { getSessionId: () => "parent", getSessionFile: () => "" },
		};
		const wait = tools
			.get("subagent_wait")!
			.execute("wait-1", { ids: [waited.id, other.id] }, abort.signal, undefined, toolCtx);
		// The wait stays open across many settles: the runs it waits on still count.
		for (let turn = 0; turn < 3; turn++) await h.emit("agent_settled");
		assert.equal(h.terminal.count, 2);
		abort.abort();
		assert.equal((await wait).details.status, "interrupted");
		await h.emit("tool_result");
		assert.equal(runningSubagents.size, 2, "Esc stops only the wait (D16)");
		assert.equal(h.terminal.count, 2, "an aborted wait leaves its running runs counted");
	} finally {
		await h.stop();
	}
});

test("a message with one of two results releases that run once by id and leaves the sibling counted", async () => {
	const h = await harness("rex");
	try {
		const [first, second] = [child("first"), child("second")];
		runningSubagents.set(first.id, first);
		runningSubagents.set(second.id, second);
		await h.emit("tool_result");
		wireSubagentSteerBack(h.pi, first, done(first), () => {});
		await tick();
		assert.equal(h.terminal.count, 2, "the first result is queued, not yet committed");
		await h.commit(h.messages[0]);
		assert.equal(h.terminal.count, 1);
		assert.deepEqual(h.terminal.records.get(WORK_RECORD_ID), { state: "working", msg: "1 child" });
		const writes = h.terminal.writes.length;
		await h.commit(h.messages[0]);
		await h.emit("agent_settled");
		assert.equal(h.terminal.count, 1, "a second copy releases nothing");
		assert.equal(h.terminal.writes.length, writes, "an unchanged count writes nothing");
	} finally {
		await h.stop();
	}
});

test("only the extension's own record is cleared, never Pi's root record", async () => {
	const terminal = new FakeTerminal();
	const reporter = await createOscWorkReporter(session(), "herdr-core", USABLE, HC_ENV, terminal);
	assert.ok(reporter);
	await reporter.publish(2);
	terminal.write(formatProgramStatus({ state: "working", app: "pi" }));
	await reporter.publish(0);
	assert.equal(terminal.records.size, 0);
	assert.deepEqual(terminal.root, { state: "working" });
	await reporter.publish(3);
	await reporter.stop();
	await reporter.stop();
	assert.equal(terminal.records.size, 0, "stop clears the extension's record");
	assert.deepEqual(terminal.root, { state: "working" });
	for (const write of terminal.writes.slice(1)) {
		if (write.includes("app=pi")) continue;
		assert.match(write, new RegExp(`:id=${WORK_RECORD_ID}(:|${ESC})`), "every write of the extension names its own id");
	}
	assert.equal(
		terminal.writes.filter((write) => write.includes("state=clear")).length,
		2,
		"a second stop writes nothing",
	);
	await reporter.publish(4);
	assert.equal(terminal.records.size, 0, "no write after stop");
});

test("old herdr, other backends and non-TUI sessions write no OSC record", async () => {
	const cases: Array<[string, OscRecordBackend, NodeJS.ProcessEnv, string]> = [
		["old herdr pane", "herdr-core", OLD_HERDR_ENV, "tui"],
		["old herdr pane", "rex", OLD_HERDR_ENV, "tui"],
		["herdr-core env, print mode", "herdr-core", HC_ENV, "print"],
		["herdr-core env, tmux pinned", "herdr-core", { ...HC_ENV, PI_SUBAGENT_MUX: "tmux" }, "tui"],
		["rex env, herdr pinned", "rex", { ...REX_ENV, PI_SUBAGENT_MUX: "herdr" }, "tui"],
		["rex block only", "rex", { REX_BLOCK: "block:x" }, "tui"],
	];
	for (const [name, backend, env, mode] of cases) {
		const terminal = new FakeTerminal();
		assert.equal(await createOscWorkReporter(session(mode), backend, USABLE, env, terminal), undefined, name);
		assert.equal(terminal.writes.length, 0, name);
	}
	const notTty = { isTTY: false, write: () => assert.fail("no write to a non-terminal") };
	assert.equal(await createOscWorkReporter(session(), "rex", USABLE, REX_ENV, notTty), undefined);
	for (const [backend, env] of [
		["herdr-core", HC_ENV],
		["rex", REX_ENV],
	] as const) {
		const terminal = new FakeTerminal();
		const unusable = await createOscWorkReporter(session(), backend, async () => false, env, terminal);
		assert.equal(unusable, undefined, `${backend} markers without a usable backend`);
		assert.equal(terminal.writes.length, 0);
	}
	assert.ok(
		await createOscWorkReporter(
			session(),
			"herdr-core",
			USABLE,
			{ ...HC_ENV, PI_SUBAGENT_MUX: "herdr-core" },
			new FakeTerminal(),
		),
	);
});

/** hc whose app answers for the caller terminal, and rex at the tested API revision 16: both backends usable. */
const ANSWERING_HC = `#!/bin/sh
[ "$1" = get ] && { echo "{\\"address\\":\\"$2\\"}"; exit 0; }
exit 1
`;
const ANSWERING_REX = `#!/bin/sh
[ "$1" = whoami ] && { echo '{"api_revision":16}'; exit 0; }
exit 1
`;

test("herdr-core and Rex expose the OSC writer as their status ability; with old herdr's environment both decline", async () => {
	const saved = { ...process.env };
	const binDir = mkdtempSync(join(tmpdir(), "osc-abilities-"));
	writeExecutable(binDir, "hc", ANSWERING_HC);
	writeExecutable(binDir, "rex", ANSWERING_REX);
	// The abilities write to the real stdout; it must look like a terminal so only the environment and the
	// fakes decide, and its records stay off the real stdout.
	const terminal = recordOscOnStdout();
	try {
		for (const name of [
			"HC_TERMINAL_ID",
			"HC_TERMINAL_SOCKET",
			"REX_SESSION",
			"REX_BLOCK",
			"REX_BIN_DIR",
			"PI_SUBAGENT_MUX",
		])
			delete process.env[name];
		// Only the fakes answer: no installed hc or rex is reachable.
		process.env.PATH = `${binDir}:/usr/bin:/bin`;
		Object.assign(process.env, OLD_HERDR_ENV);
		assert.equal(await herdrCoreBackend.connectWorkReporter?.(session()), undefined);
		assert.equal(await rexBackend.connectWorkReporter?.(session()), undefined);
		Object.assign(process.env, HC_ENV);
		const hc = await herdrCoreBackend.connectWorkReporter?.(session());
		assert.ok(hc);
		await hc.stop();
		Object.assign(process.env, REX_ENV);
		const rex = await rexBackend.connectWorkReporter?.(session());
		assert.ok(rex);
		await rex.stop();
		assert.equal(terminal.records.length, 2, "each stop clears the extension's own record once");
	} finally {
		terminal.restore();
		for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
		Object.assign(process.env, saved);
		rmSync(binDir, { recursive: true, force: true });
	}
});

/**
 * Pi's TUI stop (exit, Ctrl+Z, Ctrl+G external editor, a TUI mode change) writes a root clear to stdout
 * (pi-tui terminal.js stop()); its start writes Pi's root record again (writeProgramStatus). Both go
 * through the same stdout the reporter writes to, so the test drives them through the terminal's write.
 */
const piStopsTui = (terminal: FakeTerminal) => terminal.write(formatProgramStatus({ state: "clear" }));
const piStartsTui = (terminal: FakeTerminal) => terminal.write(formatProgramStatus({ state: "idle", app: "pi" }));

test("after Pi stops and restarts its TUI, the named record is restored with the current count", async () => {
	const h = await harness("herdr-core");
	try {
		const [first, second] = [child("first"), child("second")];
		runningSubagents.set(first.id, first);
		runningSubagents.set(second.id, second);
		await h.emit("tool_result");
		assert.equal(h.terminal.count, 2);
		piStopsTui(h.terminal);
		assert.equal(h.terminal.records.size, 0, "the root clear drops the side record");
		await h.emit("tool_result");
		assert.equal(h.terminal.records.size, 0, "no record is written while Pi's TUI is stopped");
		piStartsTui(h.terminal);
		assert.deepEqual(h.terminal.records.get(WORK_RECORD_ID), { state: "working", msg: "2 children" });
		assert.deepEqual(h.terminal.root, { state: "idle" }, "Pi's root record is Pi's own write");
		// A count change while stopped is written at the restart.
		piStopsTui(h.terminal);
		runningSubagents.delete(second.id);
		await h.emit("tool_result");
		assert.equal(h.terminal.records.size, 0);
		piStartsTui(h.terminal);
		assert.deepEqual(h.terminal.records.get(WORK_RECORD_ID), { state: "working", msg: "1 child" });
		// At zero a restart writes nothing.
		runningSubagents.delete(first.id);
		await h.emit("tool_result");
		piStopsTui(h.terminal);
		const writes = h.terminal.writes.length;
		piStartsTui(h.terminal);
		assert.equal(h.terminal.writes.length, writes + 1, "only Pi's own root write");
		assert.equal(h.terminal.records.size, 0);
	} finally {
		await h.stop();
	}
});

test("stop restores the terminal's write and writes no record after Pi's exit clear", async () => {
	const terminal = new FakeTerminal();
	const ownWrite = terminal.write;
	const reporter = await createOscWorkReporter(session(), "rex", USABLE, REX_ENV, terminal);
	assert.ok(reporter);
	await reporter.publish(2);
	piStopsTui(terminal);
	const writes = terminal.writes.length;
	await reporter.stop();
	assert.equal(terminal.writes.length, writes, "the exit clear already removed the record");
	assert.equal(terminal.write, ownWrite);
	piStartsTui(terminal);
	assert.equal(terminal.records.size, 0, "a stopped reporter restores nothing");
});
