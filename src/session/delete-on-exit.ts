import { existsSync, rmSync, writeFileSync } from "node:fs";

/**
 * D13, continue detach: the parent quits while a no-session child keeps running and appending to
 * its temporary session file by pathname. Nothing in the parent may delete that file then, because
 * the next append recreates it. The parent leaves this marker instead, and the child deletes the
 * file on its own process exit, after its last write. A parent crash writes no marker and can
 * leave the file (ticket).
 */
export function getDeleteOnExitMarkerPath(sessionFile: string): string {
	return `${sessionFile}.delete-on-exit`;
}

export function markSessionFileForDeletionOnExit(sessionFile: string): void {
	writeFileSync(getDeleteOnExitMarkerPath(sessionFile), "", { mode: 0o600 });
}

/** Deletes the session file and its marker when the marker exists; safe to call more than once. */
export function deleteSessionFileMarkedForDeletion(sessionFile: string): void {
	const marker = getDeleteOnExitMarkerPath(sessionFile);
	if (!existsSync(marker)) return;
	rmSync(sessionFile, { force: true });
	rmSync(marker, { force: true });
}

/**
 * Child side: the process `exit` event runs after Pi's session shutdown handlers, so no append
 * follows it. A child killed by SIGKILL skips it and can leave the file.
 */
export function deleteMarkedSessionFileOnProcessExit(sessionFile: string | undefined): void {
	if (!sessionFile) return;
	process.once("exit", () => {
		try {
			deleteSessionFileMarkedForDeletion(sessionFile);
		} catch {}
	});
}
