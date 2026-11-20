import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

