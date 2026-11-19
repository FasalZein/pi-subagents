import { isParentDeliveryClosed } from "../../src/runtime/delivery-queue.ts";
import { shutdownSubagentsForParentExit } from "../../src/runtime/shutdown.ts";
import { claimRunEnd, isRunEndHeld, runDeliveryState } from "../../src/runtime/wait-holds.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	existsSync,
	getCompletedSubagentResultForTest,
	it,
	join,
	resetSubagentStateForTest,
	routeDetachedSubagentCompletionForTest,
	setRunningSubagentForTest,
	shutdownSubagentsForTest,
	writeFileSync,
} from "../support/index.ts";

describe("subagent shutdown policy", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("awaits interactive surface closure during session shutdown", async () => {
		let closed = 0;
		const running = {
			id: "interactive-close",
			name: "Interactive child",
			task: "Close with parent",
			mode: "interactive" as const,
			phase: "running" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/interactive-close.jsonl",
			abortController: new AbortController(),
			surfaceId: "pane:9",
		};

		const actions = await shutdownSubagentsForParentExit({
			runningSubagents: new Map([[running.id, running]]),
			completedSubagentResults: new Map(),
			parentCloseEscalationMs: 10,
			updateWidget() {},
			cleanupNoSessionSessionFile() {},
			async closeRunningSurface(subagent) {
				assert.equal(subagent, running);
				await Promise.resolve();
				closed++;
			},
		});

		assert.deepEqual(actions, [
			{
				id: running.id,
				policy: "terminate",
				action: "terminate",
			},
		]);
		assert.equal(closed, 1);
	});

	it("honors parent close policies during session shutdown", async () => {
		const dir = createTestDir();
		const abandonSessionFile = join(dir, "abandon-child.jsonl");
		writeFileSync(abandonSessionFile, "");

		const terminateAbort = new AbortController();
		let terminateAbortCount = 0;
		terminateAbort.signal.addEventListener("abort", () => terminateAbortCount++);

		const terminate = {
			id: "child-close-1",
			name: "Terminate child",
			task: "Stop on shutdown",
			mode: "background" as const,
			phase: "running" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/child-close-1.jsonl",
			abortController: terminateAbort,
		};
		const abandon = {
			id: "child-close-2",
			name: "Abandon child",
			task: "Keep running",
			mode: "background" as const,
			phase: "running" as const,
			parentClosePolicy: "continue" as const,
			startTime: Date.now(),
			sessionFile: abandonSessionFile,
		};

		for (const running of [terminate, abandon]) {
			setRunningSubagentForTest(running);
			// A wait owns each run when the parent closes.
			claimRunEnd(running);
		}

		const actions = await shutdownSubagentsForTest({
			escalationMs: 10,
		});

		assert.deepEqual(
			actions.map(({ id, action }) => `${id}:${action}`),
			["child-close-1:terminate", "child-close-2:continue"],
		);
		assert.equal(terminateAbortCount, 1);
		assert.equal(isRunEndHeld(terminate.id), false);
		assert.equal(isRunEndHeld(abandon.id), false);
		assert.equal(runDeliveryState(terminate), "detached");
		assert.equal(runDeliveryState(abandon), "detached");
		assert.equal(isParentDeliveryClosed(abandon), true);
		assert.equal(existsSync(abandon.sessionFile), true);

		const sent: Array<{ message: any; options: any }> = [];
		routeDetachedSubagentCompletionForTest(
			{
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			abandon,
			{
				name: abandon.name,
				task: abandon.task,
				summary: "Finished after parent shutdown",
				sessionFile: abandon.sessionFile,
				exitCode: 0,
				elapsed: 4,
			},
		);

		assert.equal(sent.length, 0);
		assert.equal(getCompletedSubagentResultForTest(abandon.id), undefined);
	});
});
