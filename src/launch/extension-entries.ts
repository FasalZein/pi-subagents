import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

/** The extension list a child starts with, and the entries dropped from it because they do not resolve (D10). */
export interface ExtensionEntryCheck {
	kept: string[];
	dropped: string[];
}

/** Prefixes Pi reads as a package or built-in source rather than a local path (Pi's isLocalPath). */
const NON_LOCAL_PREFIXES = ["npm:", "git:", "github:", "http:", "https:", "ssh:", "builtin:"];

/** An entry that brings in pi-subagents itself is mandatory and never dropped. */
function isSubagentsEntry(entry: string): boolean {
	return /(^|[/@:])pi-subagents(\b|[/@])/.test(entry.trim());
}

/** Resolves a local entry the way Pi resolves `-e <path>`: `~` and file: URLs expand, relative paths start at cwd. */
function localEntryPath(entry: string, cwd: string): string {
	const trimmed = entry.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	if (trimmed.startsWith("file://")) return fileURLToPath(trimmed);
	return resolve(cwd, trimmed);
}

/**
 * Drops each entry that does not resolve: a local path that does not exist, or an npm or git
 * package that Pi has not installed in user or project scope. Pi's package manager answers the
 * install question. A package present only as a temporary `-e` checkout counts as not installed:
 * Pi exposes no lookup for that location, and D10 stops relying on temporary installs.
 */
export function dropMissingExtensionEntries(
	entries: readonly string[],
	options: { cwd: string; agentDir: string },
): ExtensionEntryCheck {
	let packageManager: DefaultPackageManager | undefined;
	const isInstalled = (entry: string): boolean => {
		// Project trust gates loading, not this existence check, so the lookup may read project scope.
		packageManager ??= new DefaultPackageManager({
			cwd: options.cwd,
			agentDir: options.agentDir,
			settingsManager: SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: true }),
		});
		for (const scope of ["project", "user"] as const) {
			try {
				if (packageManager.getInstalledPath(entry, scope)) return true;
			} catch {
				// An unparseable source or a failed global npm root lookup leaves this scope without an install.
			}
		}
		return false;
	};
	const kept: string[] = [];
	const dropped: string[] = [];
	for (const entry of entries) {
		const trimmed = entry.trim();
		const resolves =
			isSubagentsEntry(entry) ||
			trimmed.startsWith("builtin:") ||
			(NON_LOCAL_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
				? isInstalled(trimmed)
				: existsSync(localEntryPath(trimmed, options.cwd)));
		(resolves ? kept : dropped).push(entry);
	}
	return { kept, dropped };
}

/** One reply line per dropped entry, each entry named once (D10). */
export function droppedExtensionLines(dropped: Iterable<string>): string[] {
	return [...new Set(dropped)].map((entry) => `dropped missing extension: ${entry}`);
}
