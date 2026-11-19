import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "../session/session.ts";
import { COMPLETION_LIMIT_TEXT } from "./completion-call.ts";
import { PI_SUBAGENT_TIMEOUT_WRAP_UP } from "./timeout-reminders.ts";
import { SUBAGENT_DONE_TOOL_NAME } from "./tool-names.ts";

/**
 * D12: session entry the child appends just before its missing-call nudge. The parent reads its
 * index as the report boundary: text before the nudge wins over text after it.
 */
const SUBAGENT_COMPLETION_NUDGE_ENTRY = "pi-subagent-completion-nudge";

/**
 * D11/D12: session entry the child appends when a person takes over the pane after the nudge. The
 * nudge then no longer marks the last autonomous report: the parent publishes the last text.
 */
const SUBAGENT_TAKEOVER_AFTER_NUDGE_ENTRY = "pi-subagent-takeover-after-nudge";

const CALL_FIELDS = `outcome (done, partial or blocked), a summary of at most ${COMPLETION_LIMIT_TEXT}, the paths of the files you wrote, and optional data`;

/** The nudge when the run already wrote a report: the call alone. */
export const COMPLETION_NUDGE_AFTER_REPORT = `Call ${SUBAGENT_DONE_TOOL_NAME} now with ${CALL_FIELDS}. Make only the call.`;

/** The nudge when the run wrote no text yet. */
export const COMPLETION_NUDGE_WITHOUT_REPORT = `Write your report, then call ${SUBAGENT_DONE_TOOL_NAME} with ${CALL_FIELDS}.`;

/** True when an assistant message of this model run holds non-blank text: the run wrote a report. */
export function hasAssistantText(messages: readonly unknown[] | undefined): boolean {
	return (messages ?? []).some((message) => {
		const m = message as { role?: unknown; content?: unknown };
		if (m.role !== "assistant" || !Array.isArray(m.content)) return false;
		return m.content.some(
			(block: { type?: unknown; text?: unknown }) =>
				block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
		);
	});
}

/**
 * D12: an auto-exit child about to exit without a completion call gets one nudge per run (this
 * process: a launch, a resume), however many model runs it takes. A child in report-only wrap-up
 * (D7) gets none. The completion tools report each accepted call through markCallAccepted.
 */
export function createCompletionNudge(
	pi: Pick<ExtensionAPI, "appendEntry" | "sendUserMessage">,
	options: { hasCompletionTool: boolean },
) {
	// A child whose completion tool is denied cannot answer the nudge.
	const enabled = options.hasCompletionTool && process.env[PI_SUBAGENT_TIMEOUT_WRAP_UP] !== "1";
	let callAccepted = false;
	let nudged = false;
	let takeoverRecorded = false;
	return {
		markCallAccepted() {
			callAccepted = true;
		},
		/** A person took over the pane; after the nudge the parent must publish the last text. */
		markTakenOver() {
			if (!nudged || takeoverRecorded) return;
			takeoverRecorded = true;
			pi.appendEntry(SUBAGENT_TAKEOVER_AFTER_NUDGE_ENTRY, {});
		},
		/** Sends the nudge and returns true when this run may still get one; the caller then stays open. */
		nudgeOnce(hasReport: boolean): boolean {
			if (nudged || callAccepted || !enabled) return false;
			nudged = true;
			pi.appendEntry(SUBAGENT_COMPLETION_NUDGE_ENTRY, {});
			pi.sendUserMessage(hasReport ? COMPLETION_NUDGE_AFTER_REPORT : COMPLETION_NUDGE_WITHOUT_REPORT, {
				deliverAs: "steer",
			});
			return true;
		},
	};
}

/**
 * D12: index of the nudge entry that marks this process's last autonomous report: the first one at
 * or after `fromEntry` (the launch, resume or time-limit restart boundary), unless a person took
 * over the pane after it.
 */
export function findNudgeEntryIndex(entries: readonly SessionEntry[], fromEntry: number): number | undefined {
	let nudgeIndex: number | undefined;
	for (let i = fromEntry; i < entries.length; i++) {
		const { type, customType } = entries[i];
		if (type !== "custom") continue;
		if (customType === SUBAGENT_COMPLETION_NUDGE_ENTRY) nudgeIndex ??= i;
		if (customType === SUBAGENT_TAKEOVER_AFTER_NUDGE_ENTRY && nudgeIndex !== undefined) return undefined;
	}
	return nudgeIndex;
}
