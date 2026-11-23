import {
	deliverRunEnd,
	pendingRunEndCount,
	queuedRunEnd,
	queuedRunEndIds,
	registerDeliveryQueue,
	settleWaitReply,
} from "../../src/runtime/delivery-queue.ts";
import { runEndIds } from "../../src/runtime/run-end-message.ts";
import { afterEach, assert, describe, it, resetSubagentStateForTest } from "../support/index.ts";

// Ticket F (M4): each run end is one entry in one state (queued, held, in flight). These tests
// drive every state change of an entry through the queue's public calls and Pi's boundary events,
// and read the state back through the queue's views: queued ids, the queued message, the count.

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A registered parent whose session entries the test appends, as Pi commits them. */
function parent() {
	const sent: Array<{ message: object; triggerTurn?: boolean }> = [];
	const handlers = new Map<string, Handler[]>();
	const entries: object[] = [];
	const pi = {
		sendMessage: (message: object, option?: { triggerTurn?: boolean }) =>
			sent.push({ message, triggerTurn: option?.triggerTurn }),
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
	};
	const ctx = { sessionManager: { getEntries: () => entries }, hasUI: false, hasPendingMessages: () => false };
	const fire = (name: string, event: unknown = {}) => (handlers.get(name) ?? []).map((handler) => handler(event, ctx));
	registerDeliveryQueue(pi as never);
	fire("session_start");
	return {
		pi,
		fire,
		/** Pi commits a custom message that carries these run ends. */
		commit: (message: object) => entries.push({ type: "custom_message", ...message }),
		sentIds: () => sent.map(({ message }) => runEndIds({ role: "custom", ...message })),
		sent,
	};
}

const end = (id: string) => ({
	customType: "subagent_result" as const,
	content: `${id} text`,
	display: true as const,
	details: {},
});
const turnEnd = { message: { stopReason: "toolUse" } };
type SettleResult = { entries: Array<{ customType: string; content: unknown; details: unknown }> };
const aborted = () => {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
};

describe("delivery entry states (ticket F)", () => {
	afterEach(() => resetSubagentStateForTest());

	it("absent -> queued -> committed: a busy parent queues the end; message_end commits it", () => {
		const p = parent();
		p.fire("agent_start");
		deliverRunEnd(p.pi, "a", end("a"));
		assert.deepEqual(queuedRunEndIds(), ["a"]);
		assert.equal(queuedRunEnd("a")?.content, "a text");
		assert.equal(pendingRunEndCount(), 1);
		p.fire("turn_end", turnEnd);
		assert.deepEqual(p.sentIds(), [["a"]]);
		assert.deepEqual(queuedRunEndIds(), ["a"], "a sent end stays queued until Pi commits it");
		p.fire("message_end", { message: { role: "custom", ...p.sent[0].message } });
		assert.deepEqual(queuedRunEndIds(), []);
		assert.equal(pendingRunEndCount(), 0);
	});

	it("absent -> held -> taken: a wait holds the end, no boundary sends it, its reply takes it", () => {
		const p = parent();
		p.fire("agent_start");
		deliverRunEnd(p.pi, "h", end("h"), { heldByWait: true });
		assert.deepEqual(queuedRunEndIds(), ["h"], "a held end is queued for the wait");
		assert.equal(queuedRunEnd("h")?.content, "h text");
		p.fire("turn_end", turnEnd);
		const [settle] = p.fire("agent_before_settle", { entries: [] });
		assert.equal(settle, undefined, "the settle step proposes no held end");
		assert.deepEqual(p.sentIds(), []);
		settleWaitReply(["h"], ["h"]);
		assert.equal(pendingRunEndCount(), 0);
		assert.equal(queuedRunEnd("h"), undefined);
		p.fire("agent_settled");
		assert.deepEqual(p.sentIds(), [], "a taken end never reaches Pi");
	});

	it("held -> queued: a wait that returns without the end leaves it to the next boundary", () => {
		const p = parent();
		p.fire("agent_start");
		deliverRunEnd(p.pi, "h", end("h"), { heldByWait: true });
		settleWaitReply(["h"], []);
		assert.deepEqual(p.sentIds(), [], "a busy parent waits for the boundary");
		assert.deepEqual(queuedRunEndIds(), ["h"]);
		p.fire("turn_end", turnEnd);
		assert.deepEqual(p.sentIds(), [["h"]]);
	});

	it("held -> queued while idle: the unheld end is sent at once with a turn", () => {
		const p = parent();
		deliverRunEnd(p.pi, "h", end("h"), { heldByWait: true });
		settleWaitReply(["h"], []);
		assert.deepEqual(p.sentIds(), [["h"]]);
		assert.equal(p.sent[0].triggerTurn, true);
		assert.deepEqual(queuedRunEndIds(), ["h"]);
	});

	it("held -> in flight -> committed: an aborted wait gives the end back with no turn; its entry commits it", () => {
		const p = parent();
		p.fire("agent_start");
		deliverRunEnd(p.pi, "h", end("h"), { heldByWait: true });
		settleWaitReply(["h"], [], aborted());
		assert.deepEqual(p.sentIds(), [["h"]]);
		assert.equal(p.sent[0].triggerTurn, false);
		assert.deepEqual(queuedRunEndIds(), [], "an in-flight end is not queued");
		assert.equal(queuedRunEnd("h"), undefined);
		assert.equal(pendingRunEndCount(), 1, "an in-flight end is still pending");
		settleWaitReply(["h"], ["h"]);
		assert.equal(pendingRunEndCount(), 1, "a wait reply does not take an in-flight end");
		p.commit(p.sent[0].message);
		p.fire("turn_end", turnEnd);
		assert.equal(pendingRunEndCount(), 0);
		assert.deepEqual(p.sentIds(), [["h"]]);
	});

	it("queued -> in flight -> committed: the settle entry carries the end; agent_settled confirms it", () => {
		const p = parent();
		p.fire("agent_start");
		deliverRunEnd(p.pi, "a", end("a"));
		const [settle] = p.fire("agent_before_settle", { entries: [] }) as SettleResult[];
		assert.deepEqual(runEndIds({ role: "custom", ...settle.entries[0] }), ["a"]);
		assert.deepEqual(queuedRunEndIds(), []);
		assert.equal(pendingRunEndCount(), 1);
		p.commit(settle.entries[0]);
		p.fire("agent_settled");
		assert.equal(pendingRunEndCount(), 0);
		assert.deepEqual(p.sentIds(), [], "a committed settle entry is not sent again");
	});

	it("in flight -> queued: a rejected settle proposal is re-queued after the ends queued meanwhile, and sent", () => {
		const p = parent();
		p.fire("agent_start");
		deliverRunEnd(p.pi, "first", end("first"));
		const [settle] = p.fire("agent_before_settle", { entries: [] }) as SettleResult[];
		assert.deepEqual(runEndIds({ role: "custom", ...settle.entries[0] }), ["first"]);
		assert.deepEqual(queuedRunEndIds(), []);
		deliverRunEnd(p.pi, "second", end("second"));
		// A later handler replaced the proposed entry: Pi never appends it.
		p.fire("agent_settled");
		assert.deepEqual(queuedRunEndIds(), ["second", "first"]);
		assert.equal(pendingRunEndCount(), 2);
		assert.deepEqual(p.sentIds(), [["second", "first"]]);
		assert.equal(p.sent[0].triggerTurn, true);
	});

	it("absent -> in flight -> committed: a registered parent sends a no-turn end (print-mode adoption) and tracks it", () => {
		const p = parent();
		p.fire("agent_start");
		deliverRunEnd(p.pi, "v", end("v"), { triggerTurn: false });
		assert.deepEqual(p.sentIds(), [["v"]]);
		assert.equal(p.sent[0].triggerTurn, false);
		assert.deepEqual(queuedRunEndIds(), [], "an in-flight end is not queued");
		assert.equal(pendingRunEndCount(), 1, "the end stays tracked until Pi appends it");
		p.fire("turn_end", turnEnd);
		assert.equal(pendingRunEndCount(), 1, "no commit without a session entry");
		assert.deepEqual(p.sentIds(), [["v"]], "a boundary does not send an in-flight end");
		p.commit(p.sent[0].message);
		p.fire("turn_end", turnEnd);
		assert.equal(pendingRunEndCount(), 0);
		assert.deepEqual(p.sentIds(), [["v"]]);
	});

	it("queued and held -> given back: an aborted wait gives back both ends as one no-turn message", () => {
		const p = parent();
		p.fire("agent_start");
		deliverRunEnd(p.pi, "q", end("q"));
		deliverRunEnd(p.pi, "h", end("h"), { heldByWait: true });
		settleWaitReply(["q", "h"], [], aborted());
		assert.deepEqual(p.sentIds(), [["q", "h"]]);
		assert.equal(p.sent[0].triggerTurn, false);
		assert.deepEqual(queuedRunEndIds(), []);
		assert.equal(pendingRunEndCount(), 2);
	});

	it("Esc during the settle step: the entry commits and an end queued meanwhile leaves with no turn", () => {
		const p = parent();
		p.fire("agent_start");
		deliverRunEnd(p.pi, "a", end("a"));
		const [settle] = p.fire("agent_before_settle", { entries: [] }) as SettleResult[];
		deliverRunEnd(p.pi, "late", end("late"));
		p.commit(settle.entries[0]);
		p.fire("agent_settled", { aborted: true });
		assert.deepEqual(p.sentIds(), [["late"]]);
		assert.equal(p.sent[0].triggerTurn, false);
		assert.equal(pendingRunEndCount(), 1, "the late end is in flight until committed");
		assert.deepEqual(queuedRunEndIds(), []);
	});

	it("parent close: session_shutdown drops every entry in every state", () => {
		const p = parent();
		p.fire("agent_start");
		deliverRunEnd(p.pi, "h", end("h"), { heldByWait: true });
		deliverRunEnd(p.pi, "f", end("f"));
		p.fire("agent_before_settle", { entries: [] });
		deliverRunEnd(p.pi, "q", end("q"));
		assert.deepEqual(queuedRunEndIds(), ["h", "q"], "held and queued wait; f is in flight");
		assert.equal(pendingRunEndCount(), 3);
		p.fire("session_shutdown");
		assert.equal(pendingRunEndCount(), 0);
		assert.deepEqual(queuedRunEndIds(), []);
	});

	it("an unregistered host: an unheld end leaves through the wait's sink and leaves the queue", () => {
		const sent: object[] = [];
		const sink = { sendMessage: (message: object) => sent.push(message) };
		deliverRunEnd(sink as never, "h", end("h"), { heldByWait: true });
		assert.deepEqual(queuedRunEndIds(), ["h"]);
		settleWaitReply(["h"], []);
		assert.equal(sent.length, 1);
		assert.equal(pendingRunEndCount(), 0);
	});
});
