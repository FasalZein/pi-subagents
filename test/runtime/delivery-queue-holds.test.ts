import { deliverRunEnd, registerDeliveryQueue, settleWaitReply } from "../../src/runtime/delivery-queue.ts";
import { runEndIds } from "../../src/runtime/run-end-message.ts";
import { afterEach, assert, describe, it, resetSubagentStateForTest } from "../support/index.ts";

// T22 fix round 1 (D15, R4): a run end that a running wait holds is the wait's until its reply
// settles; a turn boundary in between hands over only the run ends no wait holds.

function mockParent() {
	const sent: object[] = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
	const pi = {
		sendMessage: (message: object) => sent.push(message),
		on: (name: string, handler: (event: unknown, ctx: unknown) => void) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
	};
	const fire = (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) handler(event, { hasPendingMessages: () => false });
	};
	registerDeliveryQueue(pi as never);
	return { pi, sent, fire, ids: () => sent.flatMap((message) => runEndIds({ role: "custom", ...message })) };
}

const end = (id: string) => ({
	customType: "subagent_result" as const,
	content: `${id} text`,
	display: true as const,
	details: {},
});
const turnEnd = { message: { stopReason: "toolUse" } };

describe("boundaries skip run ends a wait holds (T22)", () => {
	afterEach(() => resetSubagentStateForTest());

	it("a boundary during the wait sends only the unheld run end; an aborted wait gives its run end to the next boundary", () => {
		const parent = mockParent();
		parent.fire("agent_start");
		deliverRunEnd(parent.pi, "held", end("held"), { heldByWait: true });
		deliverRunEnd(parent.pi, "free", end("free"));
		parent.fire("turn_end", turnEnd);
		assert.deepEqual(parent.ids(), ["free"]);
		parent.fire("message_end", { message: { role: "custom", ...parent.sent[0] } });
		const aborted = new AbortController();
		aborted.abort();
		settleWaitReply(["held"], [], aborted.signal);
		parent.fire("turn_end", turnEnd);
		assert.deepEqual(parent.ids(), ["free", "held"]);
	});

	it("a returned wait reply takes its run end: no boundary sends it", () => {
		const parent = mockParent();
		parent.fire("agent_start");
		deliverRunEnd(parent.pi, "held", end("held"), { heldByWait: true });
		parent.fire("turn_end", turnEnd);
		assert.deepEqual(parent.ids(), []);
		settleWaitReply(["held"], ["held"]);
		parent.fire("turn_end", turnEnd);
		parent.fire("agent_settled");
		assert.deepEqual(parent.ids(), []);
	});
});
