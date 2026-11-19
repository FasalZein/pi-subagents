import { registerDeliveryQueue, pendingRunEndCount } from "../../src/runtime/delivery-queue.ts";
import { outstandingWork } from "../../src/runtime/outstanding-work.ts";
import { wireSubagentSteerBack } from "../../src/runtime/running-registry.ts";
import { registerSubagentCoreTools, type SubagentToolRuntime } from "../../src/tools/subagent-tools.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";
import {
	afterEach,
	assert,
	describe,
	getLaunchedSubagentResultForTest,
	it,
	resetSubagentStateForTest,
	routeDetachedSubagentCompletionForTest,
	setRunningSubagentForTest,
	sleep,
	waitForSubagentForTest,
} from "../support/index.ts";

// T23 (D7, D15): a launch that waits takes its results through the delivery queue, and the
// abort signal of the tool call reaches every wait. The parent is a mock Pi whose boundary events
// drive the production delivery queue.

/** The D15 cap on every copy of a result that enters the parent. */
const COPY_CAP = 1_900;
const REPORT_TAIL = "REPORT-TAIL-MARKER";
/** A 20,000-character report whose tail must never enter the parent. */
const LONG_REPORT = `REPORT-HEAD ${"x".repeat(20_000 - 12 - REPORT_TAIL.length - 1)} ${REPORT_TAIL}`;

interface Sent {
	message: { customType: string; content: string; details: { id: string } };
	options: unknown;
}

function mockParent() {
	const sent: Sent[] = [];
	const tools = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
	const pi: any = {
		registerTool(definition: any) {
			tools.set(definition.name, definition);
			return definition;
		},
		getThinkingLevel: () => "low",
		sendMessage(message: Sent["message"], options: unknown) {
			sent.push({ message, options });
		},
		on(name: string, handler: (event: any, ctx: any) => void) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	};
	const fire = (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) handler(event, { hasPendingMessages: () => false });
	};
	registerDeliveryQueue(pi);
	return { pi, sent, tools, fire };
}

function blockingRunning(name: string): RunningSubagent {
	return {
		id: `id-${name}`,
		name,
		task: `t-${name}`,
		title: `T ${name}`,
		agent: "worker-a",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		blocking: true,
		async: false,
		startTime: Date.now(),
		sessionFile: `/tmp/${name}.jsonl`,
	} as RunningSubagent;
}

const endOf = (name: string, summary: string): SubagentResult => ({
	name,
	task: "t",
	summary,
	summarySource: "subagent",
	sessionFile: `/tmp/${name}.jsonl`,
	exitCode: 0,
	elapsed: 1,
});

const toolCtx = {
	hasUI: false,
	cwd: process.cwd(),
	sessionManager: { getSessionFile: () => "/tmp/parent.jsonl", getSessionId: () => "parent" },
};

function launchRuntime(overrides: Partial<SubagentToolRuntime>): SubagentToolRuntime {
	return {
		loadAgentDefaults: () => ({ spawning: true, async: false, mode: "background" }) as any,
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		launchBackgroundSubagent: async (params) => {
			const running = blockingRunning(params.name);
			setRunningSubagentForTest(running as any);
			return running;
		},
		launchSubagent: async () => {
			throw new Error("no pane");
		},
		watchBackgroundSubagent: async () => new Promise<SubagentResult>(() => {}),
		watchSubagent: async () => new Promise<SubagentResult>(() => {}),
		getWatcherSignal: (_running, controller) => controller.signal,
		wireSubagentSteerBack: (pi, running, promise) =>
			wireSubagentSteerBack(pi as any, running, promise, (n) => String(n), () => {}),
		startWidgetRefresh: () => {},
		getLaunchedSubagentResult: (running, signal) => getLaunchedSubagentResultForTest(running, signal),
		stopRunningSubagent: async () => {},
		muxUnavailableResult: () => ({ content: [{ type: "text", text: "mux" }], details: {} }),
		...overrides,
	};
}

describe("T23: launches that wait use the delivery owner", () => {
	afterEach(() => resetSubagentStateForTest());

	it("replay 1: child 1 ends while child 2 launches; the tool result holds it and no other copy enters", async () => {
		const parent = mockParent();
		parent.fire("agent_start");
		const finish: Record<string, (result: SubagentResult) => void> = {};
		let releaseLaunch2!: () => void;
		const gate2 = new Promise<void>((resolve) => {
			releaseLaunch2 = resolve;
		});
		registerSubagentCoreTools(
			parent.pi,
			() => true,
			launchRuntime({
				launchBackgroundSubagent: async (params) => {
					if (params.name === "child-two") await gate2;
					const running = blockingRunning(params.name);
					setRunningSubagentForTest(running as any);
					return running;
				},
				watchBackgroundSubagent: (running) =>
					new Promise<SubagentResult>((resolve) => {
						finish[running.name] = resolve;
					}),
			}),
		);
		const exec = parent.tools.get("subagent").execute(
			"call-1",
			{
				children: [
					{ name: "child-one", task: "a", title: "One", agent: "worker-a" },
					{ name: "child-two", task: "b", title: "Two", agent: "worker-a" },
				],
			},
			undefined,
			undefined,
			toolCtx,
		);
		await sleep(10);
		finish["child-one"](endOf("child-one", LONG_REPORT));
		await sleep(10);
		releaseLaunch2();
		await sleep(10);
		finish["child-two"](endOf("child-two", "REPORT-TWO"));
		const result = await exec;
		// The turn boundaries after the tool call: a result the wait took is not handed over again.
		parent.fire("turn_end", { message: { stopReason: "stop" } });
		parent.fire("agent_settled");

		const text = result.content[0].text as string;
		const children = (result.details as { children: Array<{ id: string; report?: string }> }).children;
		const one = children.find((child) => child.id === "id-child-one");
		assert.match(one?.report ?? "", /REPORT-HEAD/, "the tool result holds child 1's result");
		assert.ok((one?.report ?? "").length <= COPY_CAP, `tool-result copy is ${one?.report?.length} chars`);
		const copies = parent.sent.filter((entry) => entry.message.details.id === "id-child-one");
		assert.deepEqual(copies, [], "the queued result was taken by the wait, so no message carries it");
		for (const entry of parent.sent) assert.ok(entry.message.content.length <= COPY_CAP);
		for (const copy of [text, ...parent.sent.map((entry) => entry.message.content)]) {
			assert.ok(!copy.includes(REPORT_TAIL), "the 20,000-character report never enters the parent");
		}
		assert.equal(pendingRunEndCount(), 0);
	});

	it("replay 2: a wait that starts aborted takes no result, and the result goes out as a message", async () => {
		const parent = mockParent();
		let resolveCompletion!: (result: SubagentResult) => void;
		const completionPromise = new Promise<SubagentResult>((resolve) => {
			resolveCompletion = resolve;
		});
		const running = { ...blockingRunning("lost-child"), completionPromise };
		setRunningSubagentForTest(running as any);
		const abort = new AbortController();
		abort.abort();
		const waited = await waitForSubagentForTest({ id: running.id }, abort.signal);
		assert.equal((waited.details as { error?: string }).error, "interrupted");
		const end = endOf(running.name, "LATE REPORT");
		resolveCompletion(end);
		routeDetachedSubagentCompletionForTest(parent.pi, running as any, end);
		const messages = parent.sent.filter((entry) => entry.message.details.id === running.id);
		assert.equal(messages.length, 1, "the result is delivered as a message");
		assert.equal(messages[0].message.customType, "subagent_result");
		assert.match(messages[0].message.content, /LATE REPORT/);
	});

	it("replay 7c: the wait for a child of an async:false agent receives the abort signal", async () => {
		const parent = mockParent();
		const seen: Array<AbortSignal | undefined> = [];
		registerSubagentCoreTools(
			parent.pi,
			() => true,
			launchRuntime({
				getLaunchedSubagentResult: async (_running, signal) => {
					seen.push(signal);
					return { content: [{ type: "text", text: "ok" }], details: {} } as any;
				},
			}),
		);
		const abort = new AbortController();
		await parent.tools
			.get("subagent")
			.execute("c", { children: [{ name: "sync-child", title: "Sync", task: "t", agent: "sync-agent" }] }, abort.signal, undefined, toolCtx);
		assert.equal(seen.length, 1);
		assert.equal(seen[0], abort.signal);
	});

	it("a tool result and a committed message both carry child 1: capped copies, released once by id", async () => {
		const parent = mockParent();
		const counts: number[] = [];
		const unsubscribe = outstandingWork.subscribe(() => counts.push(outstandingWork.count));
		try {
			const running = { ...blockingRunning("child-one"), blocking: false, async: true };
			setRunningSubagentForTest(running as any);
			// The parent is idle, so the run end goes to Pi at once and Pi holds a copy.
			routeDetachedSubagentCompletionForTest(parent.pi, running as any, endOf(running.name, LONG_REPORT));
			assert.equal(parent.sent.length, 1);
			// From here the run is outstanding only as a delivery lease.
			assert.equal(outstandingWork.count, 1);
			counts.length = 0;
			const waited = await waitForSubagentForTest({ id: running.id });
			const waitCopy = waited.content[0].text as string;
			const message = parent.sent[0].message;
			// Pi commits the copy it already held and the next request carries it.
			parent.fire("message_end", { message: { role: "custom", ...message } });
			outstandingWork.consume([{ role: "custom", ...message }]);
			outstandingWork.settle();

			for (const copy of [waitCopy, message.content]) {
				assert.match(copy, /REPORT-HEAD/);
				assert.ok(copy.length <= COPY_CAP, `copy is ${copy.length} chars`);
				assert.ok(!copy.includes(REPORT_TAIL));
			}
			const releases = counts.filter((count, index) => count === 0 && (counts[index - 1] ?? 1) > 0);
			assert.equal(releases.length, 1, `counts ${JSON.stringify(counts)}`);
			assert.equal(outstandingWork.count, 0);
			assert.equal(pendingRunEndCount(), 0);
		} finally {
			unsubscribe();
		}
	});
});
