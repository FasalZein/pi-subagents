import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { watchSubagent } from "../../src/runtime/interactive-watch.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { SUBAGENT_DONE_TOOL_NAME } from "../../src/tools/tool-names.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { assert, createSessionFile, createTestDir, describe, it } from "../support/index.ts";
import { toolCall, toolResult } from "../support/result-fixtures.ts";

// Review b2 g1 P1: the opt-in PI_SUBAGENT_TRACE_LOG traced the whole poll result, the accepted
// call's typed data, artifacts and full summary included, into a file with the default mode. A
// trace names ids, reasons and sizes only, in a file only its owner can read.

/** A synthetic private value; it must never reach the trace. */
const MARKER = "TRACE-PRIVATE-MARKER-7f3a";

async function tracePaneEnd(pollResult: Record<string, unknown>): Promise<string> {
	const root = createTestDir();
	const traceLog = join(root, "trace", "trace.jsonl");
	const args = {
		outcome: "done",
		summary: `summary ${MARKER}`,
		artifacts: [`/tmp/${MARKER}.md`],
		data: { secret: MARKER },
	};
	const sessionFile = createSessionFile(root, [
		toolCall(SUBAGENT_DONE_TOOL_NAME, args, "d1", "Report."),
		toolResult(SUBAGENT_DONE_TOOL_NAME, "d1", "ok"),
	]);
	const store = new ResultStore(join(root, "results"), () => {});
	const reservation = store.reserve();
	const running = {
		id: reservation.runId,
		name: "worker",
		task: "Work",
		agent: "scout",
		mode: "interactive",
		phase: { kind: "running" },
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		surface: "pi-subagents-nonexistent-surface",
		resultTarget: { store, reservation, parentCwd: root, warnings: [] },
	} as RunningSubagent;
	const saved = { trace: process.env.PI_SUBAGENT_TRACE_LOG, mux: process.env.PI_SUBAGENT_MUX };
	process.env.PI_SUBAGENT_TRACE_LOG = traceLog;
	process.env.PI_SUBAGENT_MUX = "tmux";
	try {
		await watchSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				async closeRunningSurface() {},
				async pollForExit() {
					return { ...pollResult, acceptedCall: { toolCallId: "d1", args } };
				},
			} as never,
			new AbortController().signal,
		);
	} finally {
		if (saved.trace === undefined) delete process.env.PI_SUBAGENT_TRACE_LOG;
		else process.env.PI_SUBAGENT_TRACE_LOG = saved.trace;
		if (saved.mux === undefined) delete process.env.PI_SUBAGENT_MUX;
		else process.env.PI_SUBAGENT_MUX = saved.mux;
	}
	assert.equal(statSync(traceLog).mode & 0o777, 0o600, "the trace file is owner-only");
	return readFileSync(traceLog, "utf8");
}

describe("trace redaction (b2 g1)", () => {
	it("traces a pane end without the accepted call's payload", async () => {
		const trace = await tracePaneEnd({ reason: "done", exitCode: 0 });
		assert.match(trace, /interactive\.watch\.pollResult/);
		assert.match(trace, /"reason":"done"/);
		assert.ok(!trace.includes(MARKER), "no payload value reaches the trace");
	});

	it("traces a ping without its message", async () => {
		const trace = await tracePaneEnd({
			reason: "ping",
			exitCode: 0,
			ping: { name: "worker", message: `help ${MARKER}` },
		});
		assert.match(trace, /"reason":"ping"/);
		assert.ok(!trace.includes(MARKER), "no ping message reaches the trace");
	});
});
