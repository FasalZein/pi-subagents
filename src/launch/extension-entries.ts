import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

/** The extension list a child starts with, and the entries dropped from it because they do not resolve (D10). */
interface ExtensionEntryCheck<Kept extends string[] | undefined = string[]> {
	kept: Kept;
	dropped: string[];
}

/** Prefixes Pi reads as a package or built-in source rather than a local path (Pi's isLocalPath). */
const NON_LOCAL_PREFIXES = ["npm:", "git:", "github:", "http:", "https:", "ssh:", "builtin:"];

const PACKAGE_ROOT = realPath(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const PACKAGE_MANIFEST = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
	name: string;
	pi: { extensions: string[] };
};
/** The paths that load this package: its root and each extension entry its manifest declares. */
const PACKAGE_PATHS = new Set([
	PACKAGE_ROOT,
	...PACKAGE_MANIFEST.pi.extensions.map((entry) => realPath(resolve(PACKAGE_ROOT, entry))),
]);

function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** The package name of an npm spec, parsed the way Pi parses it (`@scope/name@version` or `name@version`). */
function npmPackageName(spec: string): string {
	return spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/)?.[1] ?? spec;
}

function packageNameAt(directory: string): string | undefined {
	try {
		return (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name?: unknown }).name as string;
	} catch {
		return undefined;
	}
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
 * Whether an entry loads pi-subagents itself: the exact npm package name, this package's root or
 * declared entry, or a package directory whose manifest has this package's name (an installed copy).
 * A directory merely named pi-subagents or a lookalike name such as `npm:pi-subagents-extra` is not.
 */
export function isSubagentsExtensionEntry(entry: string, cwd = process.cwd()): boolean {
	const trimmed = entry.trim();
	if (trimmed.startsWith("npm:")) return npmPackageName(trimmed.slice("npm:".length)) === PACKAGE_MANIFEST.name;
	if (NON_LOCAL_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return false;
	const path = realPath(localEntryPath(trimmed, cwd));
	return PACKAGE_PATHS.has(path) || packageNameAt(path) === PACKAGE_MANIFEST.name;
}

/**
 * Drops each entry that does not resolve: a local path that does not exist, or an npm or git
 * package that Pi has not installed in user or project scope. No list stays no list. The mandatory
 * pi-subagents entry is never dropped. A package present only as a temporary `-e` checkout counts
 * as not installed: Pi exposes no lookup for that location, and D10 stops relying on temporary installs.
 *
 * The check runs no command. An unapproved project can set `npmCommand`, and Pi's lookup of a
 * legacy global npm install runs it, so npm entries are looked up only in Pi's managed npm
 * locations. Limit: a package installed only by the legacy global npm route counts as not installed.
 */
export function dropMissingExtensionEntries(
	entries: readonly string[],
	options: { cwd: string; agentDir: string },
): ExtensionEntryCheck;
export function dropMissingExtensionEntries(
	entries: readonly string[] | undefined,
	options: { cwd: string; agentDir: string },
): ExtensionEntryCheck<string[] | undefined>;
export function dropMissingExtensionEntries(
	entries: readonly string[] | undefined,
	options: { cwd: string; agentDir: string },
): ExtensionEntryCheck<string[] | undefined> {
	if (entries === undefined) return { kept: undefined, dropped: [] };
	let packageManager: DefaultPackageManager | undefined;
	const isInstalled = (entry: string): boolean => {
		if (entry.startsWith("npm:")) {
			const name = npmPackageName(entry.slice("npm:".length));
			return [
				join(options.cwd, CONFIG_DIR_NAME, "npm", "node_modules", name),
				join(options.agentDir, "npm", "node_modules", name),
			].some((path) => existsSync(path));
		}
		// For git sources Pi's lookup only computes and checks paths; project trust lets it read project scope.
		packageManager ??= new DefaultPackageManager({
			cwd: options.cwd,
			agentDir: options.agentDir,
			settingsManager: SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: true }),
		});
		for (const scope of ["project", "user"] as const) {
			try {
				if (packageManager.getInstalledPath(entry, scope)) return true;
			} catch {
				// An unparseable source leaves this scope without an install.
			}
		}
		return false;
	};
	const kept: string[] = [];
	const dropped: string[] = [];
	for (const entry of entries) {
		const trimmed = entry.trim();
		const resolves =
			isSubagentsExtensionEntry(entry, options.cwd) ||
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
