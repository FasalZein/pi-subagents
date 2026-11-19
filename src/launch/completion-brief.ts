import { COMPLETION_LIMIT_TEXT } from "../tools/completion-call.ts";
import { SUBAGENT_DONE_TOOL_NAME } from "../tools/tool-names.ts";

/**
 * D12: the brief line that asks for the completion call and states the limit. Empty when
 * deny-tools removes subagent_done, so the brief never asks for a tool the child lacks.
 */
export function completionCallBrief(denySet: ReadonlySet<string>): string {
	if (denySet.has(SUBAGENT_DONE_TOOL_NAME)) return "";
	return (
		`When your task is complete, call ${SUBAGENT_DONE_TOOL_NAME} with outcome (done, partial or blocked), ` +
		`a summary of at most ${COMPLETION_LIMIT_TEXT}, artifacts (paths of the files you wrote) and optional JSON data. ` +
		`A summary over ${COMPLETION_LIMIT_TEXT} is refused once; put long detail in your final message or a file.`
	);
}

/** Appends the completion line to a brief or a direct (fork) task; the task text itself stays first and whole. */
export function withCompletionBrief(text: string, completionBrief: string): string {
	return completionBrief ? `${text}\n\n${completionBrief}` : text;
}
