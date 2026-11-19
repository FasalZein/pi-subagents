import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunEnd, type RunFacts } from "../../src/runtime/result-assembler.ts";
import { parseRunId } from "../../src/runtime/result-record.ts";
import type { SessionEntry } from "../../src/session/session.ts";

let resultsRoot: string | undefined;
/** A results folder for resume calls, removed when the test process exits. */
export function testResultsDir(): string {
	if (!resultsRoot) {
		const root = mkdtempSync(join(tmpdir(), "pi-results-"));
		resultsRoot = root;
		process.once("exit", () => rmSync(root, { recursive: true, force: true }));
	}
	return join(resultsRoot, "results");
}

/**
 * A parent tool context for tools that reserve run ids; callers point PI_ARTIFACT_PROJECT_ROOT at a
 * test folder so the results folder stays out of the home folder.
 */
export function parentToolCtx<T extends object>(cwd: string, extra: T) {
	return { cwd, sessionManager: { getSessionId: () => "results-test-parent" }, ...extra };
}

let nextId = 0;
const id = () => `e${++nextId}`;

export function sessionHeader(): SessionEntry {
	return { type: "session", id: id() };
}

export function user(text: string): SessionEntry {
	return { type: "message", id: id(), message: { role: "user", content: [{ type: "text", text }] } };
}

/** One assistant message with one text block per argument. */
export function assistant(...texts: string[]): SessionEntry {
	const content = texts.map((text) => ({ type: "text", text }));
	return { type: "message", id: id(), message: { role: "assistant", content } };
}

/** One assistant message with optional text, then one tool call. */
export function toolCall(name: string, args: Record<string, unknown>, callId: string, text?: string): SessionEntry {
	const content: unknown[] = text ? [{ type: "text", text }] : [];
	content.push({ type: "toolCall", id: callId, name, arguments: args });
	return { type: "message", id: id(), message: { role: "assistant", content, stopReason: "toolUse" } };
}

/** A nested call record as Pi stores it on the outer tool result (pi-ai NestedToolCallRecord). */
export interface NestedCall {
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
	argumentsBytes?: number;
	status: "ok" | "error" | "unfinished";
}

export function toolResult(
	name: string,
	callId: string,
	text: string,
	isError = false,
	nestedCalls?: NestedCall[],
): SessionEntry {
	const nested = nestedCalls && { calls: nestedCalls, complete: nestedCalls.every((c) => c.status !== "unfinished") };
	return {
		type: "message",
		id: id(),
		message: {
			role: "toolResult",
			toolName: name,
			toolCallId: callId,
			isError,
			content: [{ type: "text", text }],
			...(nested ? { nestedCalls: nested } : {}),
		},
	};
}

export function facts(entries: SessionEntry[], overrides: Partial<RunFacts> = {}): RunFacts {
	const end: RunEnd = { kind: "exited", code: 0 };
	return {
		runId: parseRunId("r-0001"),
		name: "scout",
		agent: "worker",
		sessionFile: "/tmp/sessions/child-session-file.jsonl",
		startedAt: 1_000,
		endedAt: 66_000,
		end,
		entries,
		launchEntryCount: 0,
		resume: { resumable: true },
		...overrides,
	};
}

const REPORT_LINES = [
	"## Findings",
	"The parser drops the last field when the line ends in a delimiter.",
	"```ts",
	"export function parse(line: string): string[] {",
	'\treturn line.split(",").filter(Boolean);',
	"}",
	"```",
	"Проверка: тесты проходят на ветке, кроме одного случая с пустым полем.",
	"日本語のテキスト: 結果は正しいですが、境界条件を確認してください。",
	"Emoji check 🚀✅ and combining marks: é ñ ü.",
	"- warning: 3 tests skipped on CI",
];

/** Synthetic report text of exactly `length` characters with code, non-Latin text and emoji. */
export function syntheticReport(length: number): string {
	let text = "";
	for (let i = 0; text.length < length; i++) text += `${REPORT_LINES[i % REPORT_LINES.length]}\n`;
	text = text.slice(0, length);
	// Do not end inside a surrogate pair or on whitespace that the assembler trims.
	if (/[\uD800-\uDBFF\s]/.test(text.at(-1) ?? "")) text = `${text.slice(0, -1)}x`;
	return text;
}
