import { Value } from "typebox/value";
import { pendingRunEndCount } from "../../src/runtime/delivery-queue.ts";
import { wireSubagentSteerBack } from "../../src/runtime/running-registry.ts";
import { joinRuns } from "../../src/runtime/wait-join.ts";
import { registerSubagentWaitTool, SubagentWaitOutput } from "../../src/tools/wait-tool.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";
import { assert, describe, it, resetSubagentStateForTest, setRunningSubagentForTest } from "../support/index.ts";

// T24 below the tool: joinRuns with production routing and the delivery queue. The queue is not
// registered to a session here, so a message it sends goes to the sink at once.

interface Sent {
	customType: string;
	id: string;
}

function sink(sent: Sent[]) {
	return {
		sendMessage: (message: { customType: string; details: { id: string } }) => {
			sent.push({ customType: message.customType, id: message.details.id });
		},
	};
}

function startRun(name: string, sent: Sent[]): (summary: string) => void {
	let finish!: (result: SubagentResult) => void;
	const watch = new Promise<SubagentResult>((resolve) => {
		finish = resolve;
	});
	const running = {
		id: `id-${name}`,
		name,
		task: "t",
		agent: "worker-a",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		blocking: false,
		async: true,
		startTime: Date.now(),
		completionPromise: watch,
	} as RunningSubagent;
	setRunningSubagentForTest(running);
	wireSubagentSteerBack(sink(sent) as never, running, watch, () => {});
	return (summary) => finish({ name, task: "t", summary, summarySource: "subagent", exitCode: 0, elapsed: 1 });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("T24: joinRuns", () => {
	it("check 2: with no ids the wait takes every running run of this parent", async () => {
		resetSubagentStateForTest();
		const sent: Sent[] = [];
		const finishOne = startRun("one", sent);
		const finishTwo = startRun("two", sent);
		const wait = joinRuns({});
		await tick();
		finishOne("ONE");
		await tick();
		finishTwo("TWO");
		const outcome = await wait;
		assert.equal(outcome.status, "complete");
		assert.deepEqual(outcome.results.map((result) => result.id).sort(), ["id-one", "id-two"]);
		assert.deepEqual(sent, [], "no message for a returned result");
		assert.equal(pendingRunEndCount(), 0);
		resetSubagentStateForTest();
	});

	it("check 2: with nothing running or queued the wait returns at once", async () => {
		resetSubagentStateForTest();
		const outcome = await joinRuns({ timeout: 60 });
		assert.equal(outcome.status, "empty");
		assert.deepEqual(outcome.results, []);
		assert.deepEqual(outcome.pending, []);
	});

	it("check 5: a named run that is still active takes part; it never gets no result record", async () => {
		resetSubagentStateForTest();
		const sent: Sent[] = [];
		const finish = startRun("named", sent);
		const wait = joinRuns({ ids: ["named"] });
		await tick();
		finish("NAMED-REPORT");
		const outcome = await wait;
		assert.deepEqual(outcome.missing, []);
		assert.equal(outcome.results[0]?.id, "id-named");
		assert.match(outcome.results[0]!.text, /NAMED-REPORT/);
		resetSubagentStateForTest();
	});

	it("an unknown id gets no result record and nothing to wait for", async () => {
		resetSubagentStateForTest();
		const outcome = await joinRuns({ ids: ["nope"] });
		assert.equal(outcome.status, "empty");
		assert.deepEqual(outcome.missing, [{ id: "nope", error: 'No result record for "nope".' }]);
	});

	it("check 4: one of two overlapping waits is aborted first; the other returns the result and no message is sent", async () => {
		resetSubagentStateForTest();
		const sent: Sent[] = [];
		const finish = startRun("one", sent);
		const abortA = new AbortController();
		const waitA = joinRuns({ ids: ["id-one"] }, abortA.signal);
		const waitB = joinRuns({ ids: ["id-one"] });
		await tick();
		abortA.abort();
		assert.equal((await waitA).status, "interrupted");
		finish("ONE-REPORT");
		const outcome = await waitB;
		assert.match(outcome.results[0]!.text, /ONE-REPORT/);
		assert.deepEqual(sent, [], "the returned wait delivered it; the aborted one sent nothing");
		assert.equal(pendingRunEndCount(), 0);
		resetSubagentStateForTest();
	});

	it("check 4: both waits hold an end that arrived; the aborted one leaves it to the one that returns", async () => {
		resetSubagentStateForTest();
		const sent: Sent[] = [];
		const finishOne = startRun("one", sent);
		const finishTwo = startRun("two", sent);
		const abortA = new AbortController();
		const waitA = joinRuns({ ids: ["id-one", "id-two"] }, abortA.signal);
		const waitB = joinRuns({ ids: ["id-one", "id-two"], timeout: 0.2 });
		await tick();
		finishOne("ONE-REPORT");
		await tick();
		abortA.abort();
		assert.equal((await waitA).status, "interrupted");
		assert.deepEqual(sent, [], "wait b still holds child one");
		const outcome = await waitB;
		assert.equal(outcome.status, "timeout");
		assert.deepEqual(
			outcome.results.map((result) => result.id),
			["id-one"],
		);
		assert.deepEqual(outcome.pending, ["id-two"]);
		finishTwo("TWO-REPORT");
		await tick();
		assert.deepEqual(sent, [{ customType: "subagent_result", id: "id-two" }], "the pending run reports by message");
		resetSubagentStateForTest();
	});

	it("R4: the last aborted wait gives an end it took back as a message", async () => {
		resetSubagentStateForTest();
		const sent: Sent[] = [];
		const finishOne = startRun("one", sent);
		startRun("two", sent);
		const abort = new AbortController();
		const wait = joinRuns({ ids: ["id-one", "id-two"] }, abort.signal);
		await tick();
		finishOne("ONE-REPORT");
		await tick();
		abort.abort();
		const outcome = await wait;
		assert.equal(outcome.status, "interrupted");
		assert.deepEqual(sent, [{ customType: "subagent_result", id: "id-one" }]);
		resetSubagentStateForTest();
	});
});

describe("T24: the tool gives scripts structured records", () => {
	it("check 6: declares an output schema and returns structured content that matches it", async () => {
		resetSubagentStateForTest();
		// biome-ignore lint/suspicious/noExplicitAny: the captured definition is probed dynamically.
		let tool: any;
		registerSubagentWaitTool({ registerTool: (definition: unknown) => (tool = definition) } as never, () => true, {
			mayLaunch: () => true,
		});
		assert.equal(tool.name, "subagent_wait");
		assert.equal(tool.outputSchema, SubagentWaitOutput);
		const sent: Sent[] = [];
		const finish = startRun("one", sent);
		const call = tool.execute("c1", { ids: ["id-one"] }, undefined, undefined, {});
		await tick();
		finish("ONE-REPORT");
		const result = await call;
		assert.ok(Value.Check(SubagentWaitOutput, result.structuredContent), "structured content matches the schema");
		const structured = result.structuredContent as { results: { id: string; record: { id: string } }[] };
		assert.equal(structured.results[0]?.record.id, "id-one");
		assert.equal(structured.results[0]?.id, "id-one");
		resetSubagentStateForTest();
	});

	it("refuses a caller that may not launch, at call time", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: the captured definition is probed dynamically.
		let tool: any;
		registerSubagentWaitTool({ registerTool: (definition: unknown) => (tool = definition) } as never, () => true, {
			mayLaunch: () => false,
		});
		await assert.rejects(tool.execute("c1", {}, undefined, undefined, {}), /may not call subagent_wait/);
	});
});
