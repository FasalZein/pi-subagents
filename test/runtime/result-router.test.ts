import { deliverCompletedSubagentResult, routeSubagentOutcome } from "../../src/runtime/result-router.ts";
import { buildCompletedSubagentResult, requestSubagentBatchStop } from "../../src/runtime/state.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";
import {
	afterEach,
	assert,
	describe,
	getCompletedSubagentResultForTest,
	it,
	resetSubagentStateForTest,
	setRunningSubagentForTest,
} from "../support/index.ts";

function makeRunning(overrides: Partial<RunningSubagent> = {}): RunningSubagent {
	return {
		id: "child-result-router",
		name: "Result child",
		task: "Report result",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile: "/tmp/result-child.jsonl",
		...overrides,
	};
}

function makeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
	return {
		name: "Result child",
		task: "Report result",
		summary: "Finished the delegated work.",
		summarySource: "subagent",
		sessionFile: "/tmp/result-child.jsonl",
		exitCode: 0,
		elapsed: 3,
		...overrides,
	};
}

describe("result router", () => {
	afterEach(() => resetSubagentStateForTest());

	it("tells the parent an early stop was instructed and not to resume it", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = makeRunning();
		setRunningSubagentForTest(running);

		routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult({
				summary: "Partial findings so far.",
				contextTokens: 182_000,
				contextWindow: 200_000,
				contextWarned: true,
			}),
			updateWidget: () => {},
		});

		const content = sent[0]?.message?.content ?? "";
		assert.match(content, /context: 182000\/200000 tokens/);
		assert.match(content, /not resumable: stopped early by its context-warning policy/);
		assert.match(content, /launch a fresh sub-agent/i);
	});

	it("keeps the plain context line when no warning was delivered", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = makeRunning();
		setRunningSubagentForTest(running);

		routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult({ contextTokens: 40_000, contextWindow: 200_000 }),
			updateWidget: () => {},
		});

		const content = sent[0]?.message?.content ?? "";
		assert.match(content, /context: 40000\/200000 tokens/);
		assert.doesNotMatch(content, /not resumable/);
	});

	it("still explains an instructed stop when usage reporting is off", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = makeRunning({ reportContextUsage: false });
		setRunningSubagentForTest(running);

		routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult({
				summary: "Partial findings so far.",
				contextTokens: 182_000,
				contextWindow: 200_000,
				contextWarned: true,
			}),
			updateWidget: () => {},
		});

		const content = sent[0]?.message?.content ?? "";
		assert.match(content, /not resumable: stopped early by its context-warning policy/);
		// report-context-usage: false still hides the token counts.
		assert.doesNotMatch(content, /182000/);
		assert.doesNotMatch(content, /context: /);
	});

	it("warns that context is spent when a failure follows the final warning", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = makeRunning();
		setRunningSubagentForTest(running);

		routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult({
				summary: "Background agent exited with code 1",
				summarySource: "runtime",
				errorMessage: "provider overloaded",
				exitCode: 1,
				contextTokens: 182_000,
				contextWindow: 200_000,
				contextExhausted: true,
			}),
			updateWidget: () => {},
		});

		const content = sent[0]?.message?.content ?? "";
		// A provider error is a real failure, and it names the error, never a raw resume command.
		assert.match(content.split("\n")[0], / · failed · /);
		assert.match(content, /provider overloaded/);
		assert.doesNotMatch(content, /Resume: pi --session/);
	});

	it("explains an instructed stop even without a usable token snapshot", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = makeRunning();
		setRunningSubagentForTest(running);

		routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			// resolveFinalContextUsage yields contextWarned with no counts when the
			// model ref does not match the snapshot or the window size is unknown.
			result: makeResult({
				summary: "Partial findings so far.",
				contextWarned: true,
			}),
			updateWidget: () => {},
		});

		const content = sent[0]?.message?.content ?? "";
		assert.match(content, /not resumable: stopped early by its context-warning policy/);
		assert.doesNotMatch(content, /context: /);
	});

	it("routes detached completion through one parent-visible result", () => {
		const sent: Array<{ message: any; options: any }> = [];
		let widgetUpdates = 0;
		const running = makeRunning();
		setRunningSubagentForTest(running);

		const routed = routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult(),
			updateWidget: () => {
				widgetUpdates += 1;
			},
		});

		assert.equal(routed.kind, "completion");
		assert.equal(routed.completed.status, "completed");
		assert.equal(routed.completed.deliveredTo, "steer");
		assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "steer");
		assert.equal(widgetUpdates, 1);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].message.customType, "subagent_result");
		assert.equal(sent[0].message.display, true, "parent-visible completion messages must be displayed");
		assert.equal(sent[0].message.details.id, running.id);
		assert.equal(sent[0].message.details.deliveryState, "detached");
		assert.equal(sent[0].message.details.status, "completed");
		assert.deepEqual(sent[0].options, {
			triggerTurn: true,
			deliverAs: "steer",
		});
	});

	it("does not redeliver an awaited or already delivered completion", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const pi = {
			sendMessage(message: any, options: any) {
				sent.push({ message, options });
			},
		};

		const awaited = buildCompletedSubagentResult(makeRunning({ deliveryState: "awaited" }), makeResult());
		const deliveredAwaited = deliverCompletedSubagentResult(pi, awaited);
		assert.equal(deliveredAwaited, awaited);
		assert.equal(sent.length, 0);

		const alreadyDelivered = buildCompletedSubagentResult(makeRunning(), makeResult());
		alreadyDelivered.deliveredTo = "steer";
		const deliveredAgain = deliverCompletedSubagentResult(pi, alreadyDelivered);
		assert.equal(deliveredAgain, alreadyDelivered);
		assert.equal(sent.length, 0);
	});

	it("keeps optional delivery facts in structured completion details", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = makeRunning();
		setRunningSubagentForTest(running);

		routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult({
				deliveryId: "run-1-g2",
				timedOut: "timeout",
				timedOutAfter: 10,
				timeoutBlocksResume: true,
				timeoutWrapUp: { kind: "timeout", seconds: 20, threshold: 80 },
				errorMessage: "provider unavailable",
			}),
			updateWidget: () => {},
		});

		assert.equal(sent.length, 1);
		assert.equal(sent[0].message.details.deliveryId, "run-1-g2");
		assert.equal(sent[0].message.details.timedOut, "timeout");
		assert.equal(sent[0].message.details.timedOutAfter, 10);
		assert.equal(sent[0].message.details.timeoutBlocksResume, true);
		assert.deepEqual(sent[0].message.details.timeoutWrapUp, { kind: "timeout", seconds: 20, threshold: 80 });
		assert.equal(sent[0].message.details.errorMessage, "provider unavailable");
	});

	it("renders an ordinary non-zero exit as a failed child result", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = makeRunning();
		setRunningSubagentForTest(running);

		routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult({ exitCode: 2, summary: "Child failed" }),
			updateWidget: () => {},
		});

		assert.match(sent[0].message.content.split("\n")[0], /^Result child · {2}· failed · /);
		assert.match(sent[0].message.content, /Child failed/);
	});

	it("appends final child context usage after the session reference", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = makeRunning();
		setRunningSubagentForTest(running);

		routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult({
				contextTokens: 145_000,
				contextWindow: 200_000,
			}),
			updateWidget: () => {},
		});

		assert.match(sent[0].message.content, /Finished the delegated work\./);
		assert.match(sent[0].message.content, /\ncontext: 145000\/200000 tokens$/);
		assert.doesNotMatch(sent[0].message.content, /result-child\.jsonl/);
		assert.equal(sent[0].message.details.contextTokens, 145_000);
		assert.equal(sent[0].message.details.contextWindow, 200_000);
	});

	it("keeps final context telemetry structured when the agent definition hides it from the parent message", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = makeRunning({ reportContextUsage: false });
		setRunningSubagentForTest(running);

		routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult({
				contextTokens: 145_000,
				contextWindow: 200_000,
			}),
			updateWidget: () => {},
		});

		assert.doesNotMatch(sent[0].message.content, /context: /);
		assert.equal(sent[0].message.details.contextTokens, 145_000);
		assert.equal(sent[0].message.details.contextWindow, 200_000);
	});

	it("delivers salvaged child output with provider errors", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = makeRunning();
		setRunningSubagentForTest(running);

		routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult({
				summary: "Completed the requested implementation.",
				errorMessage: "Provider unavailable",
				contextTokens: 145_000,
				contextWindow: 200_000,
			}),
			updateWidget: () => {},
		});

		assert.match(sent[0].message.content.split("\n")[0], / · failed · 3\.0s · untyped$/);
		assert.match(sent[0].message.content, /Completed the requested implementation\./);
		assert.match(sent[0].message.content, /\ncontext: 145000\/200000 tokens$/);
	});

	it("does not present runtime diagnostics as salvaged child output", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = makeRunning();
		setRunningSubagentForTest(running);

		routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult({
				summary: "Background agent exited with code 1\n\nprovider stack trace",
				summarySource: "runtime",
				errorMessage: "Provider unavailable",
			}),
			updateWidget: () => {},
		});

		assert.match(sent[0].message.content, /failed: Provider unavailable/);
		assert.doesNotMatch(sent[0].message.content, /provider stack trace/);
	});

	it("steers a result that ends while the stop flag is set, in live and auto-exit parents (D15: no parking)", () => {
		const savedAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		try {
			delete process.env.PI_SUBAGENT_AUTO_EXIT;
			const liveSent: Array<{ message: any; options: any }> = [];
			const liveRunning = makeRunning({ id: "live-parent-child" });
			setRunningSubagentForTest(liveRunning);
			requestSubagentBatchStop();
			routeSubagentOutcome({
				pi: {
					sendMessage(message: any, options: any) {
						liveSent.push({ message, options });
					},
				},
				running: liveRunning,
				result: makeResult(),
				updateWidget: () => {},
			});
			assert.deepEqual(liveSent[0]?.options, { triggerTurn: true, deliverAs: "steer" });

			resetSubagentStateForTest();
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			const steerSent: Array<{ message: any; options: any }> = [];
			const autoExitRunning = makeRunning({ id: "auto-exit-parent-child" });
			setRunningSubagentForTest(autoExitRunning);
			requestSubagentBatchStop();
			routeSubagentOutcome({
				pi: {
					sendMessage(message: any, options: any) {
						steerSent.push({ message, options });
					},
				},
				running: autoExitRunning,
				result: makeResult(),
				updateWidget: () => {},
			});
			assert.equal(steerSent[0]?.options.deliverAs, "steer");
		} finally {
			if (savedAutoExit === undefined) delete process.env.PI_SUBAGENT_AUTO_EXIT;
			else process.env.PI_SUBAGENT_AUTO_EXIT = savedAutoExit;
		}
	});

	it("routes child pings without caching a completed result", () => {
		const sent: Array<{ message: any; options: any }> = [];
		let widgetUpdates = 0;
		const running = makeRunning();
		setRunningSubagentForTest(running);

		const routed = routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult({
				ping: {
					name: "Result child",
					message: "Need parent input.",
				},
			}),
			updateWidget: () => {
				widgetUpdates += 1;
			},
		});

		assert.equal(routed.kind, "ping");
		assert.equal(getCompletedSubagentResultForTest(running.id), undefined);
		assert.equal(widgetUpdates, 1);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].message.customType, "subagent_ping");
		assert.equal(sent[0].message.details.id, running.id);
		assert.equal(sent[0].message.details.message, "Need parent input.");
		assert.match(sent[0].message.content, /Need parent input\./);
		assert.deepEqual(sent[0].options, {
			triggerTurn: true,
			deliverAs: "steer",
		});
	});
});
