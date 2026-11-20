import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** T70: one file a successful write or edit call of this child changed, as an absolute path. */
export const SUBAGENT_WRITTEN_FILE_ENTRY = "pi-subagent-written-file";

export interface WrittenFileEntry {
	path: string;
}

/** Pi's file-writing tools; both name their target in `path`. */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["write", "edit"]);

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * The file Pi's write and edit tools change for `path`: their resolveToCwd (pi-coding-agent
 * core/tools/path-utils.js, not exported) on POSIX: Unicode spaces become spaces, one leading @ goes,
 * ~ expands, a file URL becomes its path, and the result is normalized against `cwd`. A differential
 * test compares it with Pi's own function. Windows shell paths are not covered.
 */
export function resolveWriteTarget(path: string, cwd: string): string {
	let normalized = path.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~") normalized = homedir();
	else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
	else if (/^file:\/\//.test(normalized)) normalized = fileURLToPath(normalized);
	return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

/**
 * T70: records the target of every successful write and edit call in the child session, direct or
 * nested (Pi runs a codemode script's calls through the same tool_result hooks). The session's nested
 * call record omits large arguments, so the target is taken here, where the call ran.
 */
export function installWrittenFileRecorder(pi: Pick<ExtensionAPI, "on" | "appendEntry">): void {
	pi.on("tool_result", (event, ctx) => {
		if (event.isError || !WRITE_TOOL_NAMES.has(event.toolName)) return;
		const path = event.input?.path;
		if (typeof path !== "string" || path.trim() === "") return;
		try {
			pi.appendEntry<WrittenFileEntry>(SUBAGENT_WRITTEN_FILE_ENTRY, { path: resolveWriteTarget(path, ctx.cwd) });
		} catch {
			// A stale context after shutdown records nothing; the file list is a record fact, not behaviour.
		}
	});
}
