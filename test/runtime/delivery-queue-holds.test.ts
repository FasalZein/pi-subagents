import { deliverRunEnd, registerDeliveryQueue, settleWaitReply } from "../../src/runtime/delivery-queue.ts";
import { runEndIds } from "../../src/runtime/run-end-message.ts";
import { afterEach, assert, describe, it, resetSubagentStateForTest } from "../support/index.ts";

// T22 fix round 1 (D15, R4): a run end that a running wait holds is the wait's until its reply
// settles; a turn boundary in between hands over only the run ends no wait holds.

function mockParent() {
	const sent: object[] = [];
	const options: Array<{ triggerTurn?: boolean } | undefined> = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const pi = {
		sendMessage: (message: object, option?: { triggerTurn?: boolean }) => {
			sent.push(message);
			options.push(option);
		},
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
	};
	const fire = (name: string, event: unknown = {}) =>
		(handlers.get(name) ?? []).map((handler) => handler(event, { hasPendingMessages: () => false }));
	registerDeliveryQueue(pi as never);
	return { pi, sent, options, fire, ids: () => sent.flatMap((message) => runEndIds({ role: "custom", ...message })) };
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

	it("a boundary during the wait sends only the unheld run end; an aborted wait gives its run end back with no turn", () => {
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
		// T26 (D15): the given-back run end leaves at once as a message that starts no turn.
		assert.deepEqual(parent.ids(), ["free", "held"]);
		assert.equal(parent.options[1]?.triggerTurn, false);
		parent.fire("turn_end", turnEnd);
		parent.fire("agent_settled");
		assert.deepEqual(parent.ids(), ["free", "held"], "no boundary hands it over again");
	});

	it("T26: the settle step appends queued run ends as one entry and asks for a request; agent_settled sends nothing more", () => {
		const parent = mockParent();
		parent.fire("agent_start");
		deliverRunEnd(parent.pi, "one", end("one"));
		deliverRunEnd(parent.pi, "two", end("two"));
		deliverRunEnd(parent.pi, "held", end("held"), { heldByWait: true });
		const [result] = parent.fire("agent_before_settle", { entries: [] }) as Array<{
			entries: Array<{ type: string; customType: string; details: unknown }>;
			continue: boolean;
		}>;
		assert.equal(result.continue, true);
		assert.equal(result.entries.length, 1, "all queued results at one boundary leave as one entry");
		assert.equal(result.entries[0].type, "custom_message");
		assert.deepEqual(runEndIds({ role: "custom", ...result.entries[0] }), ["one", "two"], "the held run end stays");
		parent.fire("agent_settled", { aborted: true });
		assert.deepEqual(parent.ids(), [], "the entry is committed even on Esc; settled starts no second copy");
	});

	it("T26 check 4: an abort before the settle step parks nothing; agent_settled hands the result over with a turn", () => {
		const parent = mockParent();
		parent.fire("agent_start");
		deliverRunEnd(parent.pi, "one", end("one"));
		// Pi skips agent_before_settle for an aborted run.
		parent.fire("agent_settled", { aborted: true });
		assert.deepEqual(parent.ids(), ["one"]);
		assert.equal(parent.options[0]?.triggerTurn, true);
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
