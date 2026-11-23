import { routeSubagentOutcome } from "../../src/runtime/result-router.ts";
import { RESULT_TEXT_MAX_CHARS } from "../../src/runtime/result-render.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";
import { afterEach, assert, describe, it, resetSubagentStateForTest, setRunningSubagentForTest } from "../support/index.ts";

function makeRunning(overrides: Partial<RunningSubagent> = {}): RunningSubagent {
	return {
		id: "child-timeout-delivery",
		name: "runaway",
		task: "Loop forever",
		mode: "background",
		phase: { kind: "running" },
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile: "/tmp/runaway-child.jsonl",
		...overrides,
	};
}

function makeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
	return {
		name: "runaway",
		task: "Loop forever",
		summary: "Background agent exited with code 143",
		summarySource: "runtime",
		sessionFile: "/tmp/runaway-child.jsonl",
		exitCode: 143,
		elapsed: 900,
		...overrides,
	};
}

function deliver(running: RunningSubagent, result: SubagentResult): string {
	const sent: Array<{ content: string; details: Record<string, unknown> }> = [];
	setRunningSubagentForTest(running);
	routeSubagentOutcome({
		pi: {
			sendMessage(message: unknown) {
				sent.push(message as { content: string; details: Record<string, unknown> });
			},
		},
		running,
		result,
		updateWidget: () => {},
	});
	return sent[0]?.content ?? "";
}

/**
 * D7 and D14: a result that reached delivery without a published record still gets the one
 * renderer's text: the time-limit facts and guidance, no session path, no raw resume command.
 */
describe("timeout result delivery", () => {
	afterEach(() => resetSubagentStateForTest());

	it("explains the kill instead of reporting a bare non-zero exit", () => {
		const content = deliver(makeRunning(), makeResult({ timedOut: "timeout", timedOutAfter: 900 }));

		assert.match(content.split("\n")[0], / · timed out · /);
		assert.match(content, /time limit: 900s for the whole run/);
		assert.doesNotMatch(content, /Background agent exited with code 143/);
		assert.ok(content.length <= RESULT_TEXT_MAX_CHARS);
	});

	it("hands the parent the partial work a warned child managed to deliver", () => {
		const content = deliver(
			makeRunning(),
			makeResult({
				summary: "Mapped the auth flow; the session layer is untouched.",
				summarySource: "subagent",
				timedOut: "idle-timeout",
				timedOutAfter: 180,
			}),
		);

		assert.match(content, /time limit: 180s without output/);
		assert.match(content, /Mapped the auth flow; the session layer is untouched./);
	});

	it("names neither the session file nor a raw resume command", () => {
		const content = deliver(makeRunning(), makeResult({ timedOut: "timeout", timedOutAfter: 900 }));

		assert.doesNotMatch(content, /runaway-child\.jsonl/);
		assert.doesNotMatch(content, /Resume: pi --session/);
	});

	it("says the run cannot resume when the agent blocks resume", () => {
		const content = deliver(
			makeRunning({ timeoutBlocksResume: true }),
			makeResult({ timedOut: "timeout", timedOutAfter: 900, timeoutBlocksResume: true }),
		);

		assert.match(content, /not resumable: its agent does not allow a resume after a time limit stops it/);
		assert.doesNotMatch(content, /Resume: pi --session/);
	});

	it("warns when the kill of a timed-out run could not be confirmed", () => {
		const content = deliver(
			makeRunning(),
			makeResult({ timedOut: "timeout", timedOutAfter: 900, timeoutKillFailed: true }),
		);

		assert.match(content, /warning: the system could not confirm that this sub-agent stopped/);
		assert.ok(content.length <= RESULT_TEXT_MAX_CHARS);
	});

	it("renders an ordinary completion as done", () => {
		const content = deliver(
			makeRunning(),
			makeResult({ summary: "All done.", summarySource: "subagent", exitCode: 0, elapsed: 12 }),
		);

		assert.match(content.split("\n")[0], / · done · /);
		assert.match(content, /All done\./);
		assert.doesNotMatch(content, /time limit/);
	});

	it("marks a completed report after a warning-threshold interruption as a wrap-up", () => {
		const content = deliver(
			makeRunning(),
			makeResult({
				summary: "Reported the committed findings; the final integration check remains unfinished.",
				summarySource: "subagent",
				exitCode: 0,
				elapsed: 81,
				timeoutWrapUp: { kind: "timeout", seconds: 100, threshold: 80 },
			}),
		);

		assert.match(content, /wrap-up: 100s for the whole run/);
		assert.match(content, /Reported the committed findings/);
	});
});
