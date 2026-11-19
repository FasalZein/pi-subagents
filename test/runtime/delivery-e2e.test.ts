import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pendingRunEndCount } from "../../src/runtime/delivery-queue.ts";
import { readResultRecord } from "../../src/runtime/result-files.ts";
import {
	getSubagentBatchStopMetadata,
	markSubagentBatchBlocking,
	requestSubagentBatchStop,
} from "../../src/runtime/state.ts";
import {
	CHILD_NAME,
	endWatchedChild,
	failWatcher,
	type Parent,
	type Request,
	recordingReply,
	startParent,
	waitFor,
} from "../support/delivery-parent.ts";
import { assert, describe, it } from "../support/index.ts";

// D15 at the extension boundary: a real Pi parent session with a faux provider. The child is a
// fake process under the real background watcher, and its end goes through the production wiring
// (wireSubagentSteerBack) and the production delivery queue, so the result files and the session's
// boundaries decide what the next model request carries.

/**
 * A launch tool that sets the batch flags the way the subagent tool_call hook does and takes the
 * terminate flag from the same state the subagent tool reads. With clearQueue, the person presses
 * Alt+Up after the child ended and before the tool batch ends.
 */
function launchTool(
	parent: () => Parent,
	batch: "terminating" | "blocking",
	options: { clearQueue?: boolean; onEnded?: () => void } = {},
): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "launch_child",
			label: "launch_child",
			description: "Launches one child that ends at once.",
			parameters: Type.Object({}),
			async execute() {
				if (batch === "blocking") markSubagentBatchBlocking();
				requestSubagentBatchStop();
				await endWatchedChild(parent());
				if (options.clearQueue) parent().clearQueue();
				options.onEnded?.();
				return {
					content: [{ type: "text", text: "launched" }],
					details: {},
					...getSubagentBatchStopMetadata(),
				};
			},
		});
	};
}

function carriesResult(request: Request | undefined, runId: string): boolean {
	// Pi hands a custom message to the provider as user text: the rendered header and footer.
	return !!request && request.text.includes(CHILD_NAME) && request.text.includes(`run: ${runId}`);
}

describe("delivery owner at the extension boundary (D15)", () => {
	it("R3: a child that ends in a terminating batch while the stop flag is set reaches the next request without user input (replay 3a)", async () => {
		const parent = await startParent({
			extensions: (p) => [launchTool(p, "terminating")],
			replies: (p) => [
				fauxAssistantMessage([fauxToolCall("launch_child", {}, { id: "l1" })], { stopReason: "toolUse" }),
				recordingReply(p, "Read the result."),
			],
		});
		try {
			await parent.prompt("delegate");
			assert.equal(parent.pendingReplies(), 0, "the result started a model request without a new prompt");
			assert.ok(carriesResult(parent.requests[0], parent.runIds[0]!), "the request carries the result message");
		} finally {
			await parent.dispose();
		}
	});

	it("R3: a child that ends in a blocking batch while the stop flag is set reaches the next request without user input (replay 3b)", async () => {
		const parent = await startParent({
			extensions: (p) => [launchTool(p, "blocking")],
			replies: (p) => [
				fauxAssistantMessage([fauxToolCall("launch_child", {}, { id: "l1" })], { stopReason: "toolUse" }),
				recordingReply(p, "Continue."),
				recordingReply(p, "Read the result."),
			],
		});
		try {
			await parent.prompt("delegate");
			assert.ok(
				carriesResult(parent.requests[0], parent.runIds[0]!),
				"the first request after the tool batch carries the result message",
			);
			const last = parent.requests.at(-1)?.text ?? "";
			assert.equal(last.split(`run: ${parent.runIds[0]}`).length - 1, 1, "the session committed the result once");
		} finally {
			await parent.dispose();
		}
	});

	it("R3: a result survives a cleared Pi queue (Alt+Up) during a blocking batch and reaches the first request after it", async () => {
		const parent = await startParent({
			extensions: (p) => [launchTool(p, "blocking", { clearQueue: true })],
			replies: (p) => [
				fauxAssistantMessage([fauxToolCall("launch_child", {}, { id: "l1" })], { stopReason: "toolUse" }),
				recordingReply(p, "Continue."),
				recordingReply(p, "Read the result."),
			],
		});
		try {
			await parent.prompt("delegate");
			assert.ok(
				carriesResult(parent.requests[0], parent.runIds[0]!),
				"the first request after the tool batch carries the result message",
			);
		} finally {
			await parent.dispose();
		}
	});

	it("R2: a result held during a turn counts as pending until the session commits it", async () => {
		const counts: number[] = [];
		const parent = await startParent({
			extensions: (p) => [launchTool(p, "blocking", { onEnded: () => counts.push(pendingRunEndCount()) })],
			replies: (p) => [
				fauxAssistantMessage([fauxToolCall("launch_child", {}, { id: "l1" })], { stopReason: "toolUse" }),
				recordingReply(p, "Read the result."),
			],
		});
		try {
			await parent.prompt("delegate");
			assert.deepEqual(counts, [1], "the ended child's result was pending while the tool batch ran");
			assert.equal(pendingRunEndCount(), 0, "the committed result left the queue");
		} finally {
			await parent.dispose();
		}
	});

	it("R3: a child that ends while the parent is idle starts a parent turn", async () => {
		const parent = await startParent({
			replies: (p) => [fauxAssistantMessage("Nothing to do."), recordingReply(p, "Read the result.")],
		});
		try {
			await parent.prompt("hello");
			const runId = await endWatchedChild(parent);
			await waitFor(() => parent.requests.length === 1, "the turn that the result starts");
			assert.ok(carriesResult(parent.requests[0], runId), "the started turn carries the result message");
		} finally {
			await parent.dispose();
		}
	});

	it("R2: a watched run's result is in its files before it is handed over", async () => {
		const parent = await startParent({
			replies: (p) => [fauxAssistantMessage("Nothing to do."), recordingReply(p, "Read the result.")],
		});
		try {
			await parent.prompt("hello");
			const runId = await endWatchedChild(parent);
			await waitFor(() => parent.requests.length === 1, "the turn that the result starts");
			assert.ok(carriesResult(parent.requests[0], runId));
			assert.equal(
				parent.requests[0]!.recordOnDisk,
				true,
				"the committed record and its report file were on disk when the result was delivered",
			);
		} finally {
			await parent.dispose();
		}
	});

	it("R2: a watcher error publishes a failed record before it is handed over", async () => {
		const parent = await startParent({
			replies: (p) => [fauxAssistantMessage("Nothing to do."), recordingReply(p, "Read the result.")],
		});
		try {
			await parent.prompt("hello");
			const runId = failWatcher(parent);
			await waitFor(() => parent.requests.length === 1, "the turn that the result starts");
			assert.ok(carriesResult(parent.requests[0], runId));
			assert.equal(parent.requests[0]!.recordOnDisk, true, "the failed end was committed to disk first");
			assert.equal(readResultRecord(join(parent.resultsDir, runId))?.outcome, "failed");
		} finally {
			await parent.dispose();
		}
	});
});
