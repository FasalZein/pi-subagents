import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { COMPLETION_LIMIT_TEXT, SUBAGENT_ACCEPTED_CALL_ENTRY } from "./completion-call.ts";
import { PI_SUBAGENT_TIMEOUT_WRAP_UP } from "./timeout-reminders.ts";
import { SUBAGENT_DONE_TOOL_NAME } from "./tool-names.ts";

/**
 * D12: session entry the child appends just before its missing-call nudge. The parent reads its
 * index as the report boundary: text before the nudge wins over text after it.
 */
export const SUBAGENT_COMPLETION_NUDGE_ENTRY = "pi-subagent-completion-nudge";

export const COMPLETION_NUDGE_MESSAGE =
	`You are about to end without calling ${SUBAGENT_DONE_TOOL_NAME}. Call ${SUBAGENT_DONE_TOOL_NAME} now with outcome (done, partial or blocked), ` +
	`a summary of at most ${COMPLETION_LIMIT_TEXT}, the paths of the files you wrote, and optional data. ` +
	"Do not repeat your report: the text you already wrote is kept.";

type SessionEntriesContext = Pick<ExtensionContext, "sessionManager">;

/**
 * D12: an auto-exit child about to exit without a completion call gets one nudge per run (this
 * process: a launch, a resume), however many model runs it takes. A child in report-only wrap-up
 * (D7) gets none. Accepted calls are read from the session entries this process appended.
 */
export function createCompletionNudge(pi: Pick<ExtensionAPI, "appendEntry" | "sendUserMessage">) {
	const wrapUpMode = process.env[PI_SUBAGENT_TIMEOUT_WRAP_UP] === "1";
	let runStartEntryCount: number | undefined;
	let nudged = false;
	const entries = (ctx: SessionEntriesContext): readonly unknown[] => ctx.sessionManager.getEntries();
	return {
		/** Call at session_start: entries before this point belong to fork history or an earlier run. */
		markRunStart(ctx: SessionEntriesContext) {
			runStartEntryCount ??= entries(ctx).length;
		},
		/** Sends the nudge and returns true when this run may still get one; the caller then stays open. */
		nudgeOnce(ctx: SessionEntriesContext): boolean {
			if (nudged || wrapUpMode) return false;
			const runEntries = entries(ctx).slice(runStartEntryCount ?? 0);
			if (runEntries.some((entry) => isCustomEntry(entry, SUBAGENT_ACCEPTED_CALL_ENTRY))) return false;
			nudged = true;
			pi.appendEntry(SUBAGENT_COMPLETION_NUDGE_ENTRY, {});
			pi.sendUserMessage(COMPLETION_NUDGE_MESSAGE, { deliverAs: "steer" });
			return true;
		},
	};
}

function isCustomEntry(entry: unknown, customType: string): boolean {
	const raw = entry as { type?: unknown; customType?: unknown } | undefined;
	return raw?.type === "custom" && raw.customType === customType;
}

/** D12: index of this run's nudge entry, the first one at or after the run's launch boundary. */
export function findNudgeEntryIndex(entries: readonly unknown[], launchEntryCount: number): number | undefined {
	for (let i = launchEntryCount; i < entries.length; i++) {
		if (isCustomEntry(entries[i], SUBAGENT_COMPLETION_NUDGE_ENTRY)) return i;
	}
	return undefined;
}
