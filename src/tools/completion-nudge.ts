import type { SessionEntry } from "../session/session.ts";

// T72 (D01 revert): a child no longer sends the D12 missing-call nudge. Sessions from before T72 can
// still hold its entries, and the parent reads them so those results render as before.

/** D12: entry a pre-T72 child appended just before its missing-call nudge; the report boundary. */
const SUBAGENT_COMPLETION_NUDGE_ENTRY = "pi-subagent-completion-nudge";

/** D11/D12: entry a pre-T72 child appended when a person took over the pane after the nudge. */
const SUBAGENT_TAKEOVER_AFTER_NUDGE_ENTRY = "pi-subagent-takeover-after-nudge";

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
