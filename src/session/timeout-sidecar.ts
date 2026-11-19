import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { SubagentTimeoutBudget, SubagentTimeoutKind } from "../types.ts";

/**
 * Verdict for a child the parent killed on a budget.
 *
 * A killed child cannot record its own outcome, and its Pi process writes an
 * ordinary `done` completion on the way out of the SIGTERM it was sent. That
 * makes the child's own session an unsafe place for this verdict: the two
 * writers would race, and the child's record would sometimes land last.
 *
 * The parent owns the kill, so the parent owns the record. It lives beside the
 * session rather than inside it. A resume leaves it in force until the resumed
 * run ends (D8): a clean end removes it, a new timeout replaces it.
 */
export interface SubagentTimeoutVerdict {
	kind: SubagentTimeoutKind;
	/** True when the agent's `on-timeout` policy refuses a resume. */
	blocksResume: boolean;
	/**
	 * The budgets this child ran under.
	 *
	 * Recorded because persisted launch metadata is not available for every
	 * session mode — a `session-mode: standalone` child has no seeded session
	 * file at launch, so nothing persists its configuration. Without this, a
	 * resume of a session that already proved it runs away would run unbounded.
	 */
	budget?: SubagentTimeoutBudget;
}

export function getSubagentTimeoutSidecarPath(sessionFile: string): string {
	return `${sessionFile}.timeout`;
}

/**
 * D8: a verdict is replaced by an atomic rename, never by truncation, so a reader or a parent
 * that dies mid-write always finds the old verdict or the new one in full.
 */
export function writeSubagentTimeoutSidecar(sessionFile: string, verdict: SubagentTimeoutVerdict): void {
	const path = getSubagentTimeoutSidecarPath(sessionFile);
	const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(verdict), { encoding: "utf8", flag: "wx" });
		renameSync(temp, path);
	} catch {
		try {
			rmSync(temp, { force: true });
		} catch {}
	}
}

export function readSubagentTimeoutSidecar(sessionFile: string): SubagentTimeoutVerdict | null {
	const path = getSubagentTimeoutSidecarPath(sessionFile);
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as {
			kind?: unknown;
			blocksResume?: unknown;
			budget?: { timeoutSeconds?: unknown; idleTimeoutSeconds?: unknown };
		};
		if (parsed?.kind !== "timeout" && parsed?.kind !== "idle-timeout") return null;
		const timeoutSeconds = parsed.budget?.timeoutSeconds;
		const idleTimeoutSeconds = parsed.budget?.idleTimeoutSeconds;
		const budget: SubagentTimeoutBudget = {
			...(typeof timeoutSeconds === "number" && timeoutSeconds > 0 ? { timeoutSeconds } : {}),
			...(typeof idleTimeoutSeconds === "number" && idleTimeoutSeconds > 0 ? { idleTimeoutSeconds } : {}),
		};
		return {
			kind: parsed.kind,
			blocksResume: parsed.blocksResume === true,
			...(budget.timeoutSeconds || budget.idleTimeoutSeconds ? { budget } : {}),
		};
	} catch {
		return null;
	}
}

export function clearSubagentTimeoutSidecar(sessionFile: string): void {
	try {
		rmSync(getSubagentTimeoutSidecarPath(sessionFile), { force: true });
	} catch {}
}
