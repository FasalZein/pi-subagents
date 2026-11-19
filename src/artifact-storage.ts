import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export function resolveArtifactProjectRoot(cwd: string): string {
	let dir = resolve(cwd);
	let packageRoot: string | null = null;

	while (true) {
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		if (!packageRoot && existsSync(join(dir, "package.json"))) {
			packageRoot = dir;
		}

		const parent = dirname(dir);
		if (parent === dir) {
			return packageRoot ?? resolve(cwd);
		}
		dir = parent;
	}
}

export function getArtifactStorageRoot(): string {
	const envRoot = process.env.PI_ARTIFACT_PROJECT_ROOT?.trim();
	return envRoot ? resolve(envRoot) : join(homedir(), ".pi", "history");
}

export function getArtifactProjectName(cwd: string): string {
	return basename(resolveArtifactProjectRoot(cwd));
}

export function getProjectArtifactsDir(cwd: string): string {
	return join(getArtifactStorageRoot(), getArtifactProjectName(cwd), "artifacts");
}

/**
 * A session id comes from a session header on disk, which Pi checks only for its type. It becomes
 * one folder name here, so an id that is not one plain path component is refused before any lookup
 * or folder creation: no separator, no "." or "..", no NUL.
 */
function assertSessionIdComponent(sessionId: string): void {
	if (sessionId === "" || sessionId === "." || sessionId === ".." || /[/\\\0]/.test(sessionId)) {
		throw new Error(`session id is not one path component: ${JSON.stringify(sessionId)}`);
	}
}

export function getSessionArtifactDir(cwd: string, sessionId: string): string {
	assertSessionIdComponent(sessionId);
	return join(getProjectArtifactsDir(cwd), sessionId);
}

/** D13: one folder per run of this parent session; the extension never deletes it. */
export function getSessionResultsDir(cwd: string, sessionId: string): string {
	return join(getSessionArtifactDir(cwd, sessionId), "results");
}

export function resolveSessionArtifactPath(cwd: string, sessionId: string, name: string): string {
	return resolve(getSessionArtifactDir(cwd, sessionId), name);
}
