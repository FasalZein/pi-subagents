import { deliverRunEnd, registerDeliveryQueue } from "../../src/runtime/delivery-queue.ts";
import { afterEach, assert, describe, it, resetSubagentStateForTest } from "../support/index.ts";

// Owner decision 2026-11-21: a busy parent shows a TUI notice when a run end queues behind its turn.
// The model still gets the result at the next tool boundary; the notice is no model-visible text.

function parent(hasUI: boolean) {
	const notices: string[] = [];
	const sent: object[] = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const ctx = {
		hasUI,
		ui: { notify: (message: string) => notices.push(message) },
		hasPendingMessages: () => false,
		sessionManager: { getEntries: () => [] },
	};
	const pi = {
		sendMessage: (message: object) => sent.push(message),
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
	};
	registerDeliveryQueue(pi as never);
	const fire = (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) handler(event, ctx);
	};
	return { pi, notices, sent, fire };
}

const end = (name: string) => ({
	customType: "subagent_result" as const,
	content: `${name} text`,
	display: true as const,
	details: { name },
});

describe("busy parent notice for a queued run end", () => {
	afterEach(() => resetSubagentStateForTest());

	it("a run end queued while the parent is busy shows one notice that names the run; delivery waits as before", () => {
		const p = parent(true);
		p.fire("agent_start");
		deliverRunEnd(p.pi, "r1", end("scout-1"));
		assert.equal(p.notices.length, 1);
		assert.match(p.notices[0], /scout-1/);
		assert.equal(p.notices[0], "The result of scout-1 is ready.");
		assert.equal(p.sent.length, 0, "the result still waits for the boundary");
		p.fire("turn_end", { message: { stopReason: "toolUse" } });
		assert.equal(p.sent.length, 1);
		assert.equal(p.notices.length, 1, "the boundary shows no second notice");
	});

	it("two run ends queued in one busy frame: the last notice names both, since Pi shows only the last", () => {
		const p = parent(true);
		p.fire("agent_start");
		deliverRunEnd(p.pi, "r1", end("scout-1"));
		deliverRunEnd(p.pi, "r2", end("scout-2"));
		assert.equal(p.notices.at(-1), "The results of scout-1, scout-2 are ready.");
		p.fire("turn_end", { message: { stopReason: "toolUse" } });
		p.fire("message_end", { message: { role: "custom", ...p.sent[0] } });
		deliverRunEnd(p.pi, "r3", end("scout-3"));
		assert.equal(p.notices.at(-1), "The result of scout-3 is ready.", "handed-over results leave the notice");
	});

	it("an idle parent gets the result at once and no notice", () => {
		const p = parent(true);
		p.fire("agent_start");
		p.fire("agent_settled", { aborted: false });
		deliverRunEnd(p.pi, "r1", end("scout-1"));
		assert.equal(p.sent.length, 1);
		assert.deepEqual(p.notices, []);
	});

	it("a busy session without a UI gets no notice", () => {
		const p = parent(false);
		p.fire("agent_start");
		deliverRunEnd(p.pi, "r1", end("scout-1"));
		assert.deepEqual(p.notices, []);
	});
});
