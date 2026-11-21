import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export function getSubagentExitSidecarPath(sessionFile: string): string {
	return `${sessionFile}.exit`;
}

/**
 * True once the child has published an outcome of its own. The parent checks
 * this before starting a timeout kill: a child that already recorded a verdict
 * finished on its own terms and must not be relabelled as a runaway.
 */
export function hasSubagentExitSidecar(sessionFile: string): boolean {
	return existsSync(getSubagentExitSidecarPath(sessionFile));
}

export function clearSubagentExitSidecar(sessionFile: string): void {
	rmSync(getSubagentExitSidecarPath(sessionFile), { force: true });
}

/**
 * Write the child's exit outcome. Returns false when an outcome already owns
 * this child and the write was refused, so callers never record a verdict the
 * parent will not see.
 */
export function writeSubagentExitSidecar(
	sessionFile: string,
	payload: object,
	opts?: { supersede?: boolean },
): boolean {
	const exitFile = getSubagentExitSidecarPath(sessionFile);
	if (existsSync(exitFile)) {
		if (!opts?.supersede) return false;
		try {
			const existing = JSON.parse(readFileSync(exitFile, "utf8")) as {
				type?: unknown;
			};
			if (existing.type !== "error") return false;
		} catch {
			// A consumed or unreadable sidecar carries no verdict worth protecting.
			// Let a genuine completion replace it.
		}
	}
	writeFileSync(exitFile, JSON.stringify(payload), "utf8");
	return true;
}

/**
 * T85 (D11): set on the child's exit record when a person took over the pane after the child wrote
 * the record and before its close ran. A held record is the child's answer, not proof that the child
 * exited: a watcher that still sees the process alive leaves it in place.
 */
export const HELD_EXIT_FIELD = "held";

function readExitRecord(exitFile: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(readFileSync(exitFile, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Marks the child's exit record held (T85). Without a record (none written, or consumed) it does nothing. */
export function holdSubagentExitSidecar(sessionFile: string): void {
	const exitFile = getSubagentExitSidecarPath(sessionFile);
	if (!existsSync(exitFile)) return;
	const record = readExitRecord(exitFile);
	if (record) writeFileSync(exitFile, JSON.stringify({ ...record, [HELD_EXIT_FIELD]: true }), "utf8");
}

/**
 * Releases a held exit record when the child really closes, with the fact of who closed it. Keeps the
 * answer. Returns false when no held record exists.
 */
export function releaseSubagentExitSidecar(sessionFile: string, closedBy: object): boolean {
	const exitFile = getSubagentExitSidecarPath(sessionFile);
	if (!existsSync(exitFile)) return false;
	const record = readExitRecord(exitFile);
	if (record?.[HELD_EXIT_FIELD] !== true) return false;
	const { [HELD_EXIT_FIELD]: _held, ...answer } = record;
	writeFileSync(exitFile, JSON.stringify({ ...answer, ...closedBy }), "utf8");
	return true;
}
