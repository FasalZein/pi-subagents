import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Context files (AGENTS.md) may wrap text meant only for the root session in
 *   <!-- pi-subagents:root-only --> ... <!-- /pi-subagents:root-only -->
 * Child sessions load the same files; this hook, installed only by the child
 * extension, removes each such block, markers included, before the run starts.
 * The file on disk and the root session are unchanged.
 */
const MARKER = /<!--\s*(\/?)pi-subagents:root-only\s*-->/g;

type RootOnlyStrip = { kind: "stripped"; text: string } | { kind: "malformed"; reason: string };

/**
 * Remove every root-only block from `text`, with the line break(s) that follow
 * it. Markers must pair up in order: open, close, open, close. Any other order
 * (a close first, two opens in a row, an open left unclosed) is malformed and
 * removes nothing, so a typo can never drop text silently.
 */
function stripRootOnlyBlocks(text: string): RootOnlyStrip {
	let result = "";
	let keptFrom = 0;
	let openAt: number | undefined;
	for (const match of text.matchAll(MARKER)) {
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
		while (text[keptFrom] === "\r" || text[keptFrom] === "\n") keptFrom++;
		openAt = undefined;
	}
	if (openAt !== undefined) return { kind: "malformed", reason: "an opening root-only marker without a closing one" };
	return { kind: "stripped", text: result + text.slice(keptFrom) };
}

function warn(ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined, message: string): void {
	if (ctx?.hasUI) ctx.ui.notify(message, "warning");
	else process.stderr.write(`[pi-subagents] ${message}\n`);
}

/**
 * Register before any other child prompt hook: later hooks that read
 * `event.systemPrompt` then see the stripped text. A prompt an earlier
 * extension already forced whole is stripped as text too.
 */
export function installRootOnlyContextStrip(pi: ExtensionAPI): void {
	const warned = new Set<string>();
	const strip = (source: string, text: string, ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined) => {
		const outcome = stripRootOnlyBlocks(text);
		if (outcome.kind === "stripped") return outcome.text;
		if (!warned.has(source)) {
			warned.add(source);
			warn(ctx, `root-only markers in ${source} are unbalanced (${outcome.reason}); this child keeps that text whole`);
		}
		return text;
	};
	pi.on("before_agent_start", (event: Pick<BeforeAgentStartEvent, "systemPromptOptions">, ctx) => {
		const options = event.systemPromptOptions;
		for (const file of options.contextFiles ?? []) file.content = strip(file.path, file.content, ctx);
		const forced = options.forceSystemPrompt;
		if (forced === undefined) return undefined;
		const next = strip("the forced system prompt", forced, ctx);
		return next === forced ? undefined : { systemPrompt: next };
	});
}
