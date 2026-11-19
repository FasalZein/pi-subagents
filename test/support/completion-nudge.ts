import { COMPLETION_NUDGE_MESSAGE } from "../../src/tools/completion-nudge.ts";

/** D12: the agent_end of the model run that answered the completion nudge with plain text and no call. */
export const NUDGE_ANSWERED_WITHOUT_CALL = { messages: [{ role: "assistant", stopReason: "stop" }] };

/**
 * D12: true for the child's missing-call nudge. A fake Pi API that sees it in sendUserMessage can
 * replay NUDGE_ANSWERED_WITHOUT_CALL, so a suite about another behaviour still reaches the exit.
 */
export function isCompletionNudge(message: unknown): boolean {
	return message === COMPLETION_NUDGE_MESSAGE;
}
