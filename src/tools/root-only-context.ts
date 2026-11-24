import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Context files (AGENTS.md) may wrap text meant only for the root session in
 *   <!-- pi-subagents:root-only -->
 *   ...
 *   <!-- /pi-subagents:root-only -->
 * Each marker sits on a line of its own; a marker inside a line of prose or
 * inline code is ordinary text. Child sessions load the same files; the child
 * extension removes each block, marker lines included, before the run starts,
 * and from a system message the child inherited (a fork seed, a resumed
 * session). The file on disk and the root session are unchanged.
 */
const MARKER_LINE = /^[ \t]*<!--[ \t]*(\/?)pi-subagents:root-only[ \t]*-->[ \t]*(?:\r?\n|$)/gm;

type RootOnlyStrip = { kind: "stripped"; text: string } | { kind: "malformed"; reason: string };

/**
 * Remove every root-only block from `text`: whole lines, from the opening
 * marker line through the closing one. Markers must pair up in order: open,
 * close, open, close. Any other order (a close first, two opens in a row, an
 * open left unclosed) is malformed and removes nothing, so a typo can never
 * drop text silently.
 */
export function stripRootOnlyBlocks(text: string): RootOnlyStrip {
	let result = "";
	let keptFrom = 0;
	let openAt: number | undefined;
	for (const match of text.matchAll(MARKER_LINE)) {
		const closing = match[1] === "/";
		if (!closing) {
			if (openAt !== undefined)
				return { kind: "malformed", reason: "an opening root-only marker inside an open block" };
			openAt = match.index;
			continue;
		}
		if (openAt === undefined) return { kind: "malformed", reason: "a closing root-only marker without an opening one" };
		result += text.slice(keptFrom, openAt);
		keptFrom = match.index + match[0].length;
		openAt = undefined;
	}
	if (openAt !== undefined) return { kind: "malformed", reason: "an opening root-only marker without a closing one" };
	return { kind: "stripped", text: result + text.slice(keptFrom) };
}

// One context file as Pi renders it into the project_context section (renderProjectContext).
const PROJECT_INSTRUCTIONS = /(<project_instructions path="[^"\n]*">\n)([\s\S]*?)(\n<\/project_instructions>)/g;

/**
 * The rendered project_context section with each file's root-only blocks
 * removed, file by file: a malformed file stays whole, as in a child's own build.
 */
export function stripRootOnlyProjectContext(section: string): string {
	return section.replace(PROJECT_INSTRUCTIONS, (whole: string, open: string, content: string, close: string) => {
		const outcome = stripRootOnlyBlocks(content);
		return outcome.kind === "stripped" ? open + outcome.text + close : whole;
	});
}

type SystemSections = { sections?: Record<string, unknown> };

/** A system message whose project_context section holds no root-only block; the same object when nothing changes. */
export function withoutRootOnlyContext<T extends SystemSections>(message: T): T {
	const section = message.sections?.project_context;
	if (typeof section !== "string") return message;
	const stripped = stripRootOnlyProjectContext(section);
	return stripped === section ? message : { ...message, sections: { ...message.sections, project_context: stripped } };
}

type NoticeContext = Pick<ExtensionContext, "hasUI" | "ui"> | undefined;

function warn(ctx: NoticeContext, message: string): void {
	if (ctx?.hasUI) ctx.ui.notify(message, "warning");
	else process.stderr.write(`[pi-subagents] ${message}\n`);
}

/** Warn once per file path (per `warned` set) about each malformed file. */
function noticeMalformed(
	files: ReadonlyArray<{ path: string; content: string }>,
	warned: Set<string>,
	ctx: NoticeContext,
	consequence: string,
): void {
	for (const file of files) {
		const outcome = stripRootOnlyBlocks(file.content);
		if (outcome.kind === "stripped" || warned.has(file.path)) continue;
		warned.add(file.path);
		warn(ctx, `root-only markers in ${file.path} are unbalanced (${outcome.reason}); ${consequence}`);
	}
}

/**
 * Root side: the parent loads the same files its children load, and has the
 * person's UI. A background child's own warning goes to its stderr, which the
 * parent shows only when the child fails, so the parent warns too.
 */
export function installRootOnlyMarkerCheck(pi: ExtensionAPI): void {
	const warned = new Set<string>();
	pi.on("before_agent_start", (event: Pick<BeforeAgentStartEvent, "systemPromptOptions">, ctx) => {
		noticeMalformed(
			event.systemPromptOptions.contextFiles ?? [],
			warned,
			ctx,
			"child sessions get that file whole, root-only text included",
		);
		return undefined;
	});
}

/**
 * Child side. Register before any other child prompt hook (subagent-done.ts
 * loads first and installs this first): later hooks that read
 * `event.systemPrompt` then see the stripped text.
 */
export function installRootOnlyContextStrip(pi: ExtensionAPI): void {
	const warned = new Set<string>();
	pi.on("before_agent_start", (event: Pick<BeforeAgentStartEvent, "systemPromptOptions">, ctx) => {
		const files = event.systemPromptOptions.contextFiles ?? [];
		noticeMalformed(files, warned, ctx, "this child keeps that text whole");
		for (const file of files) {
			const outcome = stripRootOnlyBlocks(file.content);
			if (outcome.kind === "stripped") file.content = outcome.text;
		}
		return undefined;
	});
	// A session saved before the fork seed stripped the parent's system
	// message still holds the blocks; models that keep mid-conversation
	// system messages would send that text, so each request is cleaned.
	pi.on("context_with_system", (event) => {
		let changed = false;
		const messages = event.messages.map((message) => {
			if (message.role !== "system") return message;
			const next = withoutRootOnlyContext(message);
			if (next !== message) changed = true;
			return next;
		});
		return changed ? { messages } : undefined;
	});
}
