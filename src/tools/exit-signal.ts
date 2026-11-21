import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeSubagentExitSidecar } from "../session/exit-sidecar.ts";
import {
	SUBAGENT_COMPLETION_ENTRY,
	SUBAGENT_CONTEXT_PRESSURE_FAILURE_REASON,
	SUBAGENT_CONTEXT_PRESSURE_REASON,
} from "./context-reminders.ts";
import type { FinalContextSnapshot } from "./final-context-snapshot.ts";

interface ExitSignalWriterDeps {
	pi: Pick<ExtensionAPI, "appendEntry">;
	getFinalContextUsage(): FinalContextSnapshot | undefined;
	hasDeliveredFinalWarning(): boolean;
	/** T73: the final text of an in-memory child (inMemoryFinalOutput); undefined for a persisted one. */
	getFinalOutput(): string | undefined;
}

/**
 * T73 (D13): the final text of a child that runs with Pi --no-session, as Pi print mode writes it to
 * stdout (print-mode.js): each text block of the last message, when that message is an assistant
 * answer that did not fail. A pane or a headless child with ignored stdio has no stdout that the
 * parent reads, so the exit record carries this text. Undefined for a persisted session: the parent
 * reads its transcript.
 */
export function inMemoryFinalOutput(
	session: Pick<ExtensionContext["sessionManager"], "getSessionFile" | "getBranch"> | undefined,
): string | undefined {
	if (!session || session.getSessionFile() !== undefined) return undefined;
	const branch = session.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") {
			return undefined;
		}
		const text = message.content.flatMap((block) => (block.type === "text" ? [`${block.text}\n`] : [])).join("");
		return text || undefined;
	}
	return undefined;
}

/**
 * Owns what a child records when it exits: the sidecar the parent reads, and
 * the durable completion marker the resume guard reads. Returns why the write
 * landed or did not, so callers never claim a verdict the parent will not see
 * and can still guarantee liveness when an earlier outcome already owns the
 * child: "accepted" (this write owns the sidecar), "owned" (a durable
 * non-error outcome already owns it), "no-session" (not a subagent context).
 */
interface ExitClassification {
	isNormalCompletion: boolean;
	contextPressure: boolean;
	failedWhileSpent: boolean;
}

/**
 * Decide whether a payload is a child-decided completion and which context
 * pressure markers it must carry. Pure classification, separate from writing.
 */
function classifyExitPayload(
	deps: ExitSignalWriterDeps,
	payload: object,
	opts?: { supersede?: boolean; autonomous?: boolean },
): ExitClassification {
	const type = (payload as { type?: unknown }).type;
	// Only a normal completion the child itself decided can be owned by the
	// context policy. Errors, pings, and lifecycle shutdowns such as an
	// operator closing the pane must never be labelled an instructed wrap-up.
	const isNormalCompletion = type === "done";
	const finalWarningHeld = deps.hasDeliveredFinalWarning();
	return {
		isNormalCompletion,
		contextPressure: isNormalCompletion && opts?.autonomous !== false && finalWarningHeld,
		// A failure is not an instructed wrap-up, but the parent still needs to
		// know the context was spent so it can choose between a cheap retry and
		// a fresh child. This never blocks resume.
		failedWhileSpent: type === "error" && finalWarningHeld,
	};
}

export function createExitSignalWriter(deps: ExitSignalWriterDeps) {
	/**
	 * The type of the verdict this process wrote, per session file. The parent can consume the exit
	 * record before this child's session_shutdown runs (it wakes on the file), so the file alone does
	 * not prove that no verdict exists: the same first-wins rule applies to the remembered verdict.
	 */
	const written = new Map<string, unknown>();
	return function writeExitSignal(payload: object, opts?: { supersede?: boolean; autonomous?: boolean }) {
		const sessionFile = process.env.PI_SUBAGENT_SESSION;
		if (!sessionFile) return "no-session" as const;
		if (written.has(sessionFile) && !(opts?.supersede && written.get(sessionFile) === "error")) {
			return "owned" as const;
		}
		const { isNormalCompletion, contextPressure, failedWhileSpent } = classifyExitPayload(deps, payload, opts);
		const output = deps.getFinalOutput();
		const accepted = writeSubagentExitSidecar(
			sessionFile,
			{
				...payload,
				...deps.getFinalContextUsage(),
				...(output ? { output } : {}),
				...(contextPressure ? { completionReason: SUBAGENT_CONTEXT_PRESSURE_REASON } : {}),
				...(failedWhileSpent ? { completionReason: SUBAGENT_CONTEXT_PRESSURE_FAILURE_REASON } : {}),
			},
			{ supersede: opts?.supersede },
		);
		// Record only the outcome the parent will actually read. A refused write
		// means a ping or an earlier completion already owns this child, and
		// caller_ping in particular promises the parent can resume it.
		if (!accepted) return "owned" as const;
		written.set(sessionFile, (payload as { type?: unknown }).type);
		if (!isNormalCompletion) return "accepted" as const;
		try {
			deps.pi.appendEntry(SUBAGENT_COMPLETION_ENTRY, {
				reason: contextPressure ? SUBAGENT_CONTEXT_PRESSURE_REASON : "normal",
			});
		} catch {}
		return "accepted" as const;
	};
}
