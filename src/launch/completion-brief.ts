import { COMPLETION_LIMIT_TEXT } from "../tools/completion-call.ts";
import { CALLER_PING_TOOL_NAME, SUBAGENT_DONE_TOOL_NAME } from "../tools/tool-names.ts";

/** True when the child registers subagent_done: only a deny entry removes it (D12). */
export function hasCompletionCall(denySet: ReadonlySet<string>): boolean {
	return !denySet.has(SUBAGENT_DONE_TOOL_NAME);
}

/**
 * D12: the brief line that asks for the completion call and states the limit. Empty when
 * deny-tools removes subagent_done, so the brief never asks for a tool the child lacks.
 */
export function completionCallBrief(denySet: ReadonlySet<string>): string {
	if (!hasCompletionCall(denySet)) return "";
	const ping = denySet.has(CALLER_PING_TOOL_NAME)
		? ""
		: ` A ${CALLER_PING_TOOL_NAME} message has the same ${COMPLETION_LIMIT_TEXT} limit.`;
	return (
		`When your task is complete, call ${SUBAGENT_DONE_TOOL_NAME} with outcome (done, partial or blocked), ` +
		`a summary of at most ${COMPLETION_LIMIT_TEXT}, artifacts (paths of the files you wrote) and optional JSON data. ` +
		`A summary over ${COMPLETION_LIMIT_TEXT} is refused once; put long detail in your final message or a file.${ping}`
	);
}
