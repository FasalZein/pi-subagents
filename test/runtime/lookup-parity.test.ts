import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSessionResultsDir } from "../../src/artifact-storage.ts";
import { sessionResultStore } from "../../src/runtime/result-files.ts";
import { publishedResultFields, publishRunResult, type WatchedEnd } from "../../src/runtime/run-result.ts";
import { wireSubagentSteerBack } from "../../src/runtime/running-registry.ts";
import { registerSubagentWaitTool } from "../../src/tools/wait-tool.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";
import { lookUpInFreshParent } from "../support/fresh-parent-lookup.ts";
import {
	assert,
	createTestDir,
	describe,
	it,
	resetSubagentStateForTest,
	setRunningSubagentForTest,
} from "../support/index.ts";
import { sessionHeader, toolCall, toolResult, user } from "../support/result-fixtures.ts";

// T25 fix round 1, P1 lossy replay: D16 says a lookup returns "the same rendering". A differential
// check: the delivered message, a lookup in the same process and a lookup from a restarted parent
// in another working directory must carry the same text, for the display facts the rendering takes
// beyond the record (context-usage policy, launch warnings, the unconfirmed-kill warning) and for a
// ping, which bypasses the completed cache.

const LAUNCH_WARNING = "model override ignored: the agent does not allow it";

let counter = 0;

interface Case {
	reportContextUsage: boolean;
	end: Partial<WatchedEnd>;
	timeoutKillFailed?: boolean;
}

async function deliverAndLookUp(spec: Case) {
	resetSubagentStateForTest();
	const cwd = createTestDir();
	const sessionId = `t25-parity-${++counter}`;
	const resultsDir = getSessionResultsDir(cwd, sessionId);
	const store = sessionResultStore(resultsDir);
	const reservation = store.reserve();
	let finish!: (result: SubagentResult) => void;
	const watch = new Promise<SubagentResult>((resolve) => {
		finish = resolve;
	});
	const running = {
		id: reservation.runId,
		name: "parity-check",
		task: "t",
		agent: "worker-a",
		mode: "background",
		phase: "running",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		completionPromise: watch,
		sessionFile: join(cwd, "child.jsonl"),
		reportContextUsage: spec.reportContextUsage,
		timeoutKillFailed: spec.timeoutKillFailed,
		resultTarget: { store, reservation, parentCwd: cwd, warnings: [LAUNCH_WARNING] },
	} as RunningSubagent;
	setRunningSubagentForTest(running);
	const delivered: string[] = [];
	const sink = { sendMessage: (message: { content: string }) => delivered.push(message.content) };
	wireSubagentSteerBack(sink as never, running, watch, () => {});
	const args = { outcome: "done", summary: "PARITY-SUMMARY" };
	const entries = [
		sessionHeader(),
		user("task"),
		// A hard time limit is filed only when no accepted completion beat it (D7): no call then.
		...(spec.end.timedOut ? [] : [toolCall("subagent_done", args, "d1"), toolResult("subagent_done", "d1", "ok")]),
	];
	writeFileSync(running.sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	const end: WatchedEnd = {
		exitCode: 0,
		operatorClosed: false,
		stopped: false,
		exitSignal: spec.end.timedOut ? undefined : { reason: "done", exitCode: 0, acceptedCall: { toolCallId: "d1", args } },
		contextUsage: { contextTokens: 1234, contextWindow: 100_000 },
		...spec.end,
	};
	const published = publishRunResult(running, end);
	finish({
		name: running.name,
		task: "t",
		summary: "PARITY-SUMMARY",
		summarySource: "subagent",
		exitCode: 0,
		elapsed: 1,
		...(end.ping ? { ping: { name: running.name, message: end.ping.message } } : {}),
		...publishedResultFields(published),
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(delivered.length, 1, "the run end went out by message");

	// biome-ignore lint/suspicious/noExplicitAny: the captured definition is probed dynamically.
	let tool: any;
	registerSubagentWaitTool({ registerTool: (definition: unknown) => (tool = definition) } as never, () => true, {
		mayLaunch: () => true,
	});
	const ctx = { cwd, sessionManager: { getSessionId: () => sessionId } };
	const sameProcess = await tool.execute("c1", { ids: [running.id] }, undefined, undefined, ctx);
	return {
		delivered: delivered[0]!,
		sameProcess: sameProcess.content[0].text as string,
		cwd,
		sessionId,
		id: running.id,
	};
}

/** The restarted parent opens the same session (same cwd, so the same results folder) from another process directory. */
function assertParity(result: Awaited<ReturnType<typeof deliverAndLookUp>>): void {
	const restarted = lookUpInFreshParent({
		scriptDir: result.cwd,
		cwd: result.cwd,
		processCwd: createTestDir(),
		sessionId: result.sessionId,
		ids: [result.id],
		artifactRoot: process.env.PI_ARTIFACT_PROJECT_ROOT ?? "",
	});
	assert.equal(result.sameProcess, result.delivered, "same-process lookup = delivered text");
	assert.equal(restarted.text, result.delivered, "lookup after restart = delivered text");
}

describe("T25 fix round 1: a lookup replays the delivered rendering", () => {
	it("report-context-usage false and a launch warning survive the lookup, in process and after a restart", async () => {
		const result = await deliverAndLookUp({ reportContextUsage: false, end: {} });
		assert.doesNotMatch(result.delivered, /context:/);
		assert.match(result.delivered, /model override ignored/);
		assertParity(result);
	});

	it("the unconfirmed-kill warning of a timed-out run survives the lookup", async () => {
		const result = await deliverAndLookUp({
			reportContextUsage: true,
			end: { timedOut: { kind: "timeout", seconds: 60 } },
			timeoutKillFailed: true,
		});
		assert.match(result.delivered, /could not confirm that this sub-agent stopped/);
		assertParity(result);
	});

	it("a delivered ping is looked up with its launch warning, in process and after a restart", async () => {
		const result = await deliverAndLookUp({ reportContextUsage: true, end: { ping: { message: "need a decision" } } });
		assert.match(result.delivered, /model override ignored/);
		assertParity(result);
	});
});
