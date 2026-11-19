import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { pendingRunEndCount } from "../../src/runtime/delivery-queue.ts";
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
// commits the result and starts no turn; an abort before the step parks nothing.

function carriesResult(request: Request | undefined, runId: string): boolean {
	return !!request && request.text.includes(CHILD_NAME) && request.text.includes(`run: ${runId}`);
}

/** Ends one watched child when the first run ends (after its last turn_end, before the settle step). */
function childEndsAtRunEnd(
	parent: () => Parent,
	options: { escDuringSettle: boolean; queued: number[] },
): ExtensionFactory {
	return (pi) => {
		let ended = false;
		let pressed = false;
		pi.on("agent_end", async () => {
			if (ended) return;
			ended = true;
			await endWatchedChild(parent());
		});
		// Registered after the delivery queue, so it runs after the queue proposed its entry.
		pi.on("agent_before_settle", (_event, ctx) => {
			options.queued.push(pendingRunEndCount());
			if (!options.escDuringSettle || pressed) return;
			pressed = true;
			ctx.abort();
		});
	};
}

function committedResultEntries(parent: Parent, runId: string): number {
	return readFileSync(parent.sessionFile(), "utf8")
		.split("\n")
		.filter((line) => line.includes('"subagent_result"') && line.includes(runId)).length;
}

describe("T26: Esc and the settle boundary (real Pi session, D15)", () => {
	it("check 3: a result appended at the settle boundary with Esc during settling starts no turn and is in the next request", async () => {
		const queued: number[] = [];
		const parent = await startParent({
			extensions: (p) => [childEndsAtRunEnd(p, { escDuringSettle: true, queued })],
			replies: (p) => [fauxAssistantMessage("Done."), recordingReply(p, "Read the result.")],
		});
		try {
			await parent.prompt("hello");
			// Give a deferred run the chance to start.
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(parent.requests.length, 0, "the result started no turn");
			assert.equal(parent.pendingReplies(), 1, "no model request was made");
			assert.deepEqual(queued, [0], "the queue had already moved the result into its settle entry");
			const runId = parent.runIds[0]!;
			assert.equal(committedResultEntries(parent, runId), 1, "the result is committed in the session once");
			assert.equal(pendingRunEndCount(), 0);
			await parent.prompt("next");
			assert.equal(parent.requests.length, 1);
			assert.ok(carriesResult(parent.requests[0], runId), "the next request after the person types holds the result");
			assert.equal(parent.requests[0]!.text.split(`run: ${runId}`).length - 1, 1, "exactly one copy");
		} finally {
			await parent.dispose();
		}
	});

	it("without Esc, the result appended at the settle boundary starts one more request at once", async () => {
		const queued: number[] = [];
		const parent = await startParent({
			extensions: (p) => [childEndsAtRunEnd(p, { escDuringSettle: false, queued })],
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
