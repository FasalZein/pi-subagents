import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import { pendingRunEndCount } from "../../src/runtime/delivery-queue.ts";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { ResultRecordSchema } from "../../src/runtime/result-record-schema.ts";
import { runEndIds } from "../../src/runtime/run-end-message.ts";
import { publishedResultFields, publishRunResult, type WatchedEnd } from "../../src/runtime/run-result.ts";
import { wireSubagentSteerBack } from "../../src/runtime/running-registry.ts";
import { joinRuns } from "../../src/runtime/wait-join.ts";
import { runningSubagents } from "../../src/runtime/wiring.ts";
import {
	registerSubagentWaitTool,
	SubagentWaitOutput,
	type SubagentWaitStructured,
} from "../../src/tools/wait-tool.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";
import {
	assert,
	createTestDir,
	describe,
	it,
	resetSubagentStateForTest,
	setRunningSubagentForTest,
} from "../support/index.ts";
import { parentToolCtx, sessionHeader, toolCall, toolResult, user } from "../support/result-fixtures.ts";

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

/** With a root, the run publishes a typed record when it ends, as its watcher does after subagent_done. */
function startRun(
	name: string,
	sent: Sent[],
	root?: string,
	pi: { sendMessage: (message: never, options?: never) => void } = sink(sent),
): (summary: string) => void {
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
		phase: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		blocking: false,
		async: true,
		startTime: Date.now(),
		completionPromise: watch,
	} as RunningSubagent;
	if (root) {
		const store = new ResultStore(join(root, "results"), () => {});
		running.sessionFile = join(root, `${name}.jsonl`);
		running.resultTarget = { store, reservation: store.reserve(), parentCwd: root, warnings: [] };
	}
	setRunningSubagentForTest(running);
	wireSubagentSteerBack(pi as never, running, watch, () => {});
	return (summary) => {
		const base = { name, task: "t", summary, summarySource: "subagent" as const, exitCode: 0, elapsed: 1 };
		if (!root) return finish(base);
		const args = { outcome: "done", summary, data: { answer: 42 } };
		const entries = [
			sessionHeader(),
			user("task"),
			toolCall("subagent_done", args, "d1"),
			toolResult("subagent_done", "d1", "ok"),
		];
		writeFileSync(running.sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const exitSignal: WatchedEnd["exitSignal"] = {
			reason: "done",
			exitCode: 0,
			acceptedCall: { toolCallId: "d1", args },
		};
		const published = publishRunResult(running, {
			exitCode: 0,
			operatorClosed: false,
			stopped: false,
			exitSignal,
			contextUsage: {},
		});
		finish({ ...base, ...publishedResultFields(published) });
	};
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

	it("T26 check 1: an aborted wait stops no run and gives the ends it took back as one message that starts no turn", async () => {
		resetSubagentStateForTest();
		const messages: Array<{ ids: string[]; triggerTurn?: boolean }> = [];
		const pi = {
			sendMessage: (message: { customType: string; details: unknown }, options?: { triggerTurn?: boolean }) =>
				messages.push({ ids: runEndIds({ role: "custom", ...message }), triggerTurn: options?.triggerTurn }),
		};
		const finishOne = startRun("one", [], undefined, pi as never);
		const finishTwo = startRun("two", [], undefined, pi as never);
		const finishThree = startRun("three", [], undefined, pi as never);
		const abort = new AbortController();
		const wait = joinRuns({ ids: ["id-one", "id-two", "id-three"] }, abort.signal);
		await tick();
		finishOne("ONE-REPORT");
		finishTwo("TWO-REPORT");
		await tick();
		abort.abort();
		const outcome = await wait;
		assert.equal(outcome.status, "interrupted");
		assert.deepEqual(outcome.pending, ["id-three"]);
		assert.equal(runningSubagents.get("id-three")?.phase, "running", "no stop was sent");
		assert.deepEqual(messages, [{ ids: ["id-one", "id-two"], triggerTurn: false }]);
		// Check 2: a run that ends later reports by message and starts a turn.
		finishThree("THREE-REPORT");
		await tick();
		assert.equal(messages.length, 2);
		assert.deepEqual(messages[1].ids, ["id-three"]);
		assert.notEqual(messages[1].triggerTurn, false, "the later end starts a turn");
		resetSubagentStateForTest();
	});
});

/** A verified run this session watches (D18); a recipient may receive it, an observer may not. */
function watchVerifiedRun(id: string, recipient: boolean): void {
	setRunningSubagentForTest({
		id,
		name: `vf-${id}`,
		task: "t",
		agent: "worker-a",
		mode: "background",
		phase: "running",
		deliveryState: "detached",
		parentClosePolicy: "continue",
		async: true,
		startTime: Date.now(),
		sessionFile: "",
		verifiedRunId: `run-${id}`,
		verifiedRunCancelDenied: !recipient,
		completionPromise: new Promise<SubagentResult>(() => {}),
	} as RunningSubagent);
}

describe("T24 fix round 1 (P2): an aborted wait lists canonical ids that still run", () => {
	it("no alias, and no run that another wait already returned", async () => {
		resetSubagentStateForTest();
		const sent: Sent[] = [];
		startRun("one", sent);
		const finishTwo = startRun("two", sent);
		const abort = new AbortController();
		const waitA = joinRuns({ ids: ["one", "id-two"] }, abort.signal);
		const waitB = joinRuns({ ids: ["id-two"] });
		await tick();
		finishTwo("TWO-REPORT");
		assert.equal((await waitB).results[0]?.id, "id-two");
		abort.abort();
		const outcome = await waitA;
		assert.equal(outcome.status, "interrupted");
		assert.deepEqual(outcome.pending, ["id-one"]);
		assert.deepEqual(sent, [], "wait b delivered child two; the aborted wait sends nothing");
		resetSubagentStateForTest();
	});

	it("an ended run is found by id only; its old name gets no result record", async () => {
		resetSubagentStateForTest();
		const sent: Sent[] = [];
		const finish = startRun("one", sent);
		finish("ONE-REPORT");
		await tick();
		const byName = await joinRuns({ ids: ["one"] });
		assert.deepEqual(byName.missing, [{ id: "one", error: 'No result record for "one".' }]);
		const byId = await joinRuns({ ids: ["id-one"] });
		assert.match(byId.results[0]?.text ?? "", /ONE-REPORT/);
		resetSubagentStateForTest();
	});
});

describe("T24 fix round 1 (P1): a wait sees only runs this parent may receive", () => {
	it("a no-ids wait skips a verified-run observer that is not a recipient", async () => {
		resetSubagentStateForTest();
		watchVerifiedRun("foreign", false);
		const outcome = await joinRuns({ timeout: 0.2 });
		assert.equal(outcome.status, "empty");
		assert.deepEqual(outcome.pending, []);
		resetSubagentStateForTest();
	});

	it("an observer's id or name gets no result record", async () => {
		resetSubagentStateForTest();
		watchVerifiedRun("foreign", false);
		const outcome = await joinRuns({ ids: ["foreign", "vf-foreign"], timeout: 0.2 });
		assert.equal(outcome.status, "empty");
		assert.deepEqual(
			outcome.missing.map((missing) => missing.id),
			["foreign", "vf-foreign"],
		);
		resetSubagentStateForTest();
	});

	it("an authorized adopter still waits for its verified run", async () => {
		resetSubagentStateForTest();
		watchVerifiedRun("adopted", true);
		const outcome = await joinRuns({ timeout: 0.1 });
		assert.equal(outcome.status, "timeout");
		assert.deepEqual(outcome.pending, ["adopted"]);
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
		const root = createTestDir();
		const finish = startRun("one", sent, root);
		const call = tool.execute("c1", { ids: ["id-one"] }, undefined, undefined, parentToolCtx(createTestDir(), {}));
		await tick();
		finish("ONE-REPORT");
		const result = await call;
		assert.ok(Value.Check(SubagentWaitOutput, result.structuredContent), "structured content matches the schema");
		const structured = result.structuredContent as SubagentWaitStructured;
		const record = structured.results[0]?.record;
		assert.equal(structured.results[0]?.id, "id-one");
		assert.ok(record && Value.Check(ResultRecordSchema, record), "the published record matches the record schema");
		assert.equal(record.outcome, "done");
		assert.equal(record.typed, true);
		assert.deepEqual(record.data, { answer: 42 });
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
