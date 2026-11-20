import { resolveToCwd } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js";
import { assembleResult } from "../../src/runtime/result-assembler.ts";
import type { SessionEntry } from "../../src/session/session.ts";
import { assert, describe, it } from "../support/index.ts";
import { cleanupPaneChild, loadPaneChild } from "../support/pane-child.ts";
import { assistant, facts, type NestedCall, toolCall, toolResult, user } from "../support/result-fixtures.ts";

/**
 * T70 review P1s: an untyped run lists the files Pi wrote, as Pi's own resolver names them, also
 * for a nested write whose arguments Pi left out of the session. Each case drives the real child
 * extension with the tool_result events Pi emits, writes the session Pi would write, and assembles
 * the record from it. Expected paths come from Pi's resolveToCwd, not from the code under test.
 */
interface WriteCall {
	path: string;
	content: string;
	/** Run by a codemode script: the session keeps only the nested call record. */
	nested?: boolean;
}

/** Pi drops a nested call's arguments above 8 KiB (NESTED_CALL_LIMITS.maxArgumentBytesPerCall). */
const NESTED_ARGUMENT_LIMIT = 8 * 1024;

function recordedArtifacts(calls: WriteCall[]): { artifacts: string[]; cwd: string } {
	const child = loadPaneChild({ autoExit: false, pane: false });
	try {
		const cwd = child.dir;
		const entries: SessionEntry[] = [{ type: "session", id: "h", cwd } as SessionEntry, user("task")];
		calls.forEach((call, i) => {
			const args = { path: call.path, content: call.content };
			const before = child.entries.length;
			// Pi runs direct and nested calls through the same tool_result hooks.
			child.emit("tool_result", { toolName: "write", toolCallId: `w${i}`, input: args, isError: false, content: [] });
			if (call.nested) {
				const size = JSON.stringify(args).length;
				const record: NestedCall =
					size > NESTED_ARGUMENT_LIMIT
						? { id: `w${i}`, name: "write", argumentsBytes: size, status: "ok" }
						: { id: `w${i}`, name: "write", arguments: args, status: "ok" };
				entries.push(toolCall("codemode", { code: "..." }, `c${i}`));
				entries.push(toolResult("codemode", `c${i}`, "ok", false, [record]));
			} else {
				entries.push(toolCall("write", args, `w${i}`));
				entries.push(toolResult("write", `w${i}`, "ok"));
			}
			for (const entry of child.entries.slice(before)) {
				entries.push({ type: "custom", id: `x${i}`, ...entry } as unknown as SessionEntry);
			}
		});
		entries.push(assistant("Report."));
		const { record } = assembleResult(facts(entries, { launchEntryCount: 1 }));
		assert.equal(record.typed, false);
		return { artifacts: record.artifacts, cwd };
	} finally {
		cleanupPaneChild(child.dir);
	}
}

describe("untyped runs list the files Pi wrote (T70 review)", () => {
	it("a nested write whose 9 KiB arguments Pi omitted still lists its file", () => {
		const content = "x".repeat(9 * 1024);
		const { artifacts, cwd } = recordedArtifacts([{ path: "reports/big.md", content, nested: true }]);
		assert.deepEqual(artifacts, [resolveToCwd("reports/big.md", cwd)]);
	});

	it("recorded paths match the file Pi's resolver writes, one entry per file", () => {
		const paths = [
			"~/t70-report.md",
			"@notes/at.md",
			"file:///tmp/t70-url.md",
			"notes/\u00A0space.md",
			"plan.md",
			"./sub/../plan.md",
			"/tmp/t70/../t70-abs.md",
			"/tmp/t70-abs.md",
		];
		const { artifacts, cwd } = recordedArtifacts(paths.map((path) => ({ path, content: "c" })));
		const expected = [...new Set(paths.map((path) => resolveToCwd(path, cwd)))];
		assert.equal(expected.length, 6, "two pairs name one file each");
		assert.deepEqual(artifacts, expected);
	});
});
