import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { pendingRunEndCount } from "../../src/runtime/delivery-queue.ts";
import { outstandingWork } from "../../src/runtime/outstanding-work.ts";
import { registerOutstandingWorkReporting } from "../../src/runtime/work-reporting.ts";
import {
	CHILD_NAME,
	endWatchedChild,
	type Parent,
	type Request,
	recordingReply,
	startParent,
	waitFor,
} from "../support/delivery-parent.ts";
import { assert, describe, it } from "../support/index.ts";

// T26 (D15) in a real Pi 1.5.2 session with a faux provider: a child ends after the last turn
// boundary of a run, so its result is queued when the settle step starts. Esc during that step
// commits the result and starts no turn; an abort before the step parks nothing. Each committed
// result ends its work lease (D30), also on the commit paths that emit no extension message_end.

function carriesResult(request: Request | undefined, runId: string): boolean {
	return !!request && request.text.includes(CHILD_NAME) && request.text.includes(`run: ${runId}`);
}

type SettleAction = "esc" | "none" | "replace" | "late-child-then-esc";

/**
 * Ends one watched child when the first run ends (after its last turn_end, before the settle
 * step). Its settle handler is registered after the delivery queue, so it sees the queue's proposed
 * entry and then acts: Esc, nothing, drop the proposal, or end a second child and then Esc.
 */
function childEndsAtRunEnd(parent: () => Parent, action: SettleAction, proposed: string[][]): ExtensionFactory {
	return (pi) => {
		let ended = false;
		let acted = false;
		pi.on("agent_end", async () => {
			if (ended) return;
			ended = true;
			await endWatchedChild(parent());
		});
		pi.on("agent_before_settle", async (event, ctx) => {
			if (acted) return;
			acted = true;
			proposed.push(event.entries.map((entry) => (entry.type === "custom_message" ? entry.customType : entry.type)));
			if (action === "replace") return { entries: [] };
			if (action === "late-child-then-esc") await endWatchedChild(parent(), "late-worker");
			if (action !== "none") ctx.abort();
		});
	};
}

/** A capturing work reporter (D30), started with the session. */
function workReporter(counts: number[]): ExtensionFactory {
	return (pi) => {
		const reporting = registerOutstandingWorkReporting(pi, async () => ({
			publish: async (count) => void counts.push(count),
			stop: async () => {},
		}));
		pi.on("session_start", (_event, ctx) => reporting.start(ctx));
		pi.on("session_shutdown", () => reporting.stop());
	};
}

function committedResultEntries(parent: Parent, runId: string): number {
	return readFileSync(parent.sessionFile(), "utf8")
		.split("\n")
		.filter((line) => line.includes('"subagent_result"') && line.includes(runId)).length;
}

function copies(request: Request | undefined, runId: string): number {
	return (request?.text ?? "").split(`run: ${runId}`).length - 1;
}

describe("T26: Esc and the settle boundary (real Pi session, D15)", () => {
	it("check 3: a result appended at the settle boundary with Esc during settling starts no turn and is in the next request", async () => {
		const proposed: string[][] = [];
		const counts: number[] = [];
		const parent = await startParent({
			extensions: (p) => [workReporter(counts), childEndsAtRunEnd(p, "esc", proposed)],
			replies: (p) => [fauxAssistantMessage("Done."), recordingReply(p, "Read the result.")],
		});
		try {
			await parent.prompt("hello");
			assert.deepEqual(proposed, [["subagent_result"]], "the queue proposed the result entry");
			assert.equal(parent.requests.length, 0, "the result started no turn");
			assert.equal(parent.pendingReplies(), 1, "no model request was made");
			const runId = parent.runIds[0]!;
			assert.equal(committedResultEntries(parent, runId), 1, "the result is committed in the session once");
			assert.equal(pendingRunEndCount(), 0);
			assert.equal(outstandingWork.count, 0, "the committed settle entry ended the work lease");
			assert.equal(counts.at(-1), 0);
			await parent.prompt("next");
			assert.equal(parent.requests.length, 1);
			assert.ok(carriesResult(parent.requests[0], runId), "the next request after the person types holds the result");
			assert.equal(copies(parent.requests[0], runId), 1, "exactly one copy");
		} finally {
			await parent.dispose();
		}
	});

	it("without Esc, the result appended at the settle boundary starts one more request at once", async () => {
		const parent = await startParent({
			extensions: (p) => [childEndsAtRunEnd(p, "none", [])],
			replies: (p) => [fauxAssistantMessage("Done."), recordingReply(p, "Read the result.")],
		});
		try {
			await parent.prompt("hello");
			await waitFor(() => parent.requests.length === 1, "the request the settle entry starts");
			assert.ok(carriesResult(parent.requests[0], parent.runIds[0]!));
			assert.equal(pendingRunEndCount(), 0);
		} finally {
			await parent.dispose();
		}
	});

	it("fix round 1 (P2): a later settle handler drops the proposed entry; the result is queued again and starts a turn", async () => {
		const parent = await startParent({
			extensions: (p) => [childEndsAtRunEnd(p, "replace", [])],
			replies: (p) => [fauxAssistantMessage("Done."), recordingReply(p, "Read the result.")],
		});
		try {
			await parent.prompt("hello");
			await waitFor(() => parent.requests.length === 1, "the turn the requeued result starts");
			assert.equal(copies(parent.requests[0], parent.runIds[0]!), 1, "the request holds the result once");
			assert.equal(pendingRunEndCount(), 0);
		} finally {
			await parent.dispose();
		}
	});

	it("fix round 1 (P2): a child that ends after the proposal and before Esc in a later settle handler starts no turn either", async () => {
		const counts: number[] = [];
		const parent = await startParent({
			extensions: (p) => [workReporter(counts), childEndsAtRunEnd(p, "late-child-then-esc", [])],
			replies: (p) => [fauxAssistantMessage("Done."), recordingReply(p, "Read the results.")],
		});
		try {
			await parent.prompt("hello");
			assert.equal(parent.requests.length, 0, "neither result started a turn");
			assert.equal(parent.pendingReplies(), 1);
			const [first, late] = parent.runIds;
			assert.equal(committedResultEntries(parent, first!), 1);
			assert.equal(committedResultEntries(parent, late!), 1, "the late result is committed with no turn");
			assert.equal(outstandingWork.count, 0, "both leases ended");
			assert.equal(counts.at(-1), 0);
			await parent.prompt("next");
			assert.equal(parent.requests.length, 1);
			assert.equal(copies(parent.requests[0], first!), 1);
			assert.equal(copies(parent.requests[0], late!), 1, "the next request holds the late result once");
		} finally {
			await parent.dispose();
		}
	});

	it("check 4: an abort before the settle step parks nothing; the queued result starts a turn once the parent is idle", async () => {
		const parent = await startParent({
			replies: (p) => [
				// The child ends while the model streams; then the person presses Esc in that response.
				async (_context, options) => {
					await endWatchedChild(p());
					void p().abort();
					if (!options?.signal?.aborted)
						await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve, { once: true }));
					return fauxAssistantMessage("", { stopReason: "aborted" });
				},
				recordingReply(p, "Read the result."),
			],
		});
		try {
			await parent.prompt("delegate");
			await waitFor(() => parent.requests.length === 1, "the turn the queued result starts");
			assert.ok(carriesResult(parent.requests[0], parent.runIds[0]!), "the result left without a prompt");
			assert.equal(pendingRunEndCount(), 0);
		} finally {
			await parent.dispose();
		}
	});
});
