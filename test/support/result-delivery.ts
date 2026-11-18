import { deliverCompletedSubagentResult } from "../../src/runtime/result-router.ts";
import { buildCompletedSubagentResult } from "../../src/runtime/state.ts";
import { waitForSubagentResult } from "../../src/runtime/wait-result.ts";
import { withToolWarningForTest } from "../../src/testing/test-helpers.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";
import { assert } from "./index.ts";

export const START_MARKER = "<<T07-START>>";
export const END_MARKER = "<<T07-END>>";
/** The tickets' long answer: a 20,000-character last message with a marker at each end. */
export const LONG_ANSWER = `${START_MARKER}${"lorem ipsum dolor sit amet\n".repeat(800).slice(0, 20_000 - START_MARKER.length - END_MARKER.length)}${END_MARKER}`;

export function assistantText(text: string) {
	return { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text }] } };
}

/** The text that the message path delivers for one finished run. */
export function messageText(result: SubagentResult, running: RunningSubagent): string {
	const sent: Array<{ content: string }> = [];
	const completed = buildCompletedSubagentResult(running, result);
	deliverCompletedSubagentResult(
		{ sendMessage: (message) => sent.push(message as { content: string }) },
		completed,
		String,
	);
	assert.equal(sent.length, 1);
	return sent[0].content;
}

/** The text that the waiting launch returns for one finished run. */
export async function waitText(result: SubagentResult, running: RunningSubagent, launchWarning = ""): Promise<string> {
	const cached = buildCompletedSubagentResult(running, result);
	const reply = await waitForSubagentResult({ id: running.id }, { findTrackedSubagent: () => ({ cached }) } as never);
	// The launch tool wraps the waited reply with its launch warning (subagent-tools, resume-tool).
	const content = withToolWarningForTest(reply, launchWarning).content as Array<{ type: string; text?: string }>;
	assert.equal(content.length, 1, "the waiting launch returns one text block");
	return content[0].text ?? "";
}
