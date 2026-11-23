import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseJsonContainer } from "../tools/json-string-args.ts";
import { getLaunchCallChildren } from "./batch-classifier.ts";
import {
	CONTEXT_FOLD_ENTRY,
	CONTEXT_FOLD_LAUNCH_ENTRY,
	type FoldedRun,
	isChildTranscript,
	isRecord,
	type LaunchedRun,
	messageRunIds,
	readFoldedRuns,
	readLaunches,
	settleFold,
	str,
} from "./context-fold-set.ts";
import { runningSubagents } from "./state.ts";

/**
 * The settle fold (owner rule 2026-11-22T08:40Z; model statecharts/context-fold/target/Target.tla).
 * When the parent settles idle, every run the model already used folds: from then on each provider
 * request carries a short stub instead of that run's launch brief and its result message. The
 * session file keeps the full text, and subagent_wait({ runIds }) returns the stored result (D16).
 *
 * The fold set is the union of the durable fold entries on the session branch (context-fold-set.ts).
 * Only agent_settled appends one, so a fold never happens mid-turn, the set is the same on every
 * request of a turn and after /reload or resume, and a folded run never comes back in full while
 * the provider API stays the same: the prompt cache breaks at most once per settle.
 *
 * Limit: this is the agent loop's context hook. Compaction, /tree branch summaries and cache-warmer
 * replays read the session or an earlier request directly and are not folded.
 */

/**
 * Provider APIs proven (live check 2026-11-23, anthropic and cpa/gpt-6.2-sol) to accept changed
 * arguments of earlier tool calls. Others can bind earlier messages to a signature (Bedrock
 * Converse rejects a changed signed history; Google asks for signed parts unchanged): no fold.
 * Revisit after a live check of another API.
 */
const FOLDING_APIS: ReadonlySet<string> = new Set(["anthropic-messages", "openai-responses"]);

function foldsForApi(api: string | undefined): boolean {
	return api !== undefined && FOLDING_APIS.has(api);
}

type Rec = Record<string, unknown>;

/** The stub of one folded run, for its brief and its result alike. */
export function runStub(run: FoldedRun): string {
	return `[Folded subagent run ${run.id} (${run.name}): ${run.outcome}, report ${run.report}. Full result: subagent_wait({ runIds: ["${run.id}"] })]`;
}

/** The run id of each child of a direct launch, by position; undefined where none is known. */
function launchChildIds(details: unknown): Array<string | undefined> {
	if (!isRecord(details)) return [];
	if (Array.isArray(details.children)) {
		return details.children.map((child) => (isRecord(child) ? (str(child.id) ?? str(child.runId)) : undefined));
	}
	return [str(details.id)];
}

/** A direct launch call: the children list when nonempty, else the top-level form (the launch normalizer). */
function foldLaunchArgs(args: Rec, ids: Array<string | undefined>, folded: ReadonlyMap<string, FoldedRun>): Rec {
	const stubFor = (index: number) => {
		const id = ids[index];
		const run = id ? folded.get(id) : undefined;
		return run ? runStub(run) : undefined;
	};
	const children = parseJsonContainer(args.children);
	if (!Array.isArray(children) || children.length === 0) {
		const stub = ids.length === 1 ? stubFor(0) : undefined;
		return stub && typeof args.task === "string" ? { ...args, task: stub } : args;
	}
	if (ids.length !== children.length) return args;
	let changed = false;
	const next = children.map((child, index) => {
		const stub = stubFor(index);
		if (!stub || !isRecord(child) || typeof child.task !== "string") return child;
		changed = true;
		return { ...child, task: stub };
	});
	if (!changed) return args;
	return { ...args, children: typeof args.children === "string" ? JSON.stringify(next) : next };
}

/** The nested calls of a codemode result: Pi's nestedCalls record, or details.calls of older sessions. */
function nestedCalls(result: Rec): unknown[] {
	if (isRecord(result.nestedCalls) && Array.isArray(result.nestedCalls.calls)) return result.nestedCalls.calls;
	return isRecord(result.details) && Array.isArray(result.details.calls) ? result.details.calls : [];
}

const QUOTES = new Set(['"', "'", "`"]);
const escaped = (text: string) => JSON.stringify(text).slice(1, -1);

/** Start offsets of `text` as a whole string literal body: a quote right before and after it. */
function literalOffsets(code: string, text: string): number[] {
	const offsets: number[] = [];
	for (let at = code.indexOf(text); at !== -1; at = code.indexOf(text, at + 1)) {
		const before = code[at - 1];
		if (before !== undefined && QUOTES.has(before) && code[at + text.length] === before) offsets.push(at);
	}
	return offsets;
}

/**
 * A codemode script: only each folded run's exact task text changes, where it stands as one whole
 * string literal in the code (raw or JSON-escaped), once. The runs come from the script's actual
 * nested subagent calls (launch entries), never from its output. When a folded run's text is not
 * found exactly once, or a run that does not fold has the same text, the script stays full.
 */
function foldScriptArgs(
	args: Rec,
	result: Rec | undefined,
	folded: ReadonlyMap<string, FoldedRun>,
	launches: ReadonlyMap<string, LaunchedRun[]>,
): Rec {
	if (!result || typeof args.code !== "string") return args;
	const runs = nestedCalls(result).flatMap((call) =>
		isRecord(call) && call.name === "subagent" && typeof call.id === "string" ? (launches.get(call.id) ?? []) : [],
	);
	const toFold = runs.filter((run) => folded.has(run.id));
	if (toFold.length === 0) return args;
	const kept = new Set(runs.filter((run) => !folded.has(run.id)).map((run) => run.task));
	let code = args.code;
	for (const run of toFold) {
		if (kept.has(run.task)) return args;
		const forms = [...new Set([escaped(run.task), run.task])];
		const hits = forms.flatMap((form) => literalOffsets(code, form).map((at) => ({ at, form })));
		if (hits.length !== 1) return args;
		const [{ at, form }] = hits;
		code = code.slice(0, at) + escaped(runStub(folded.get(run.id) as FoldedRun)) + code.slice(at + form.length);
	}
	return { ...args, code };
}

/**
 * The provider messages with the folded runs' briefs and result messages as stubs. Only the task
 * text of a launch call, folded task literals of a codemode launch script and the content of a
 * result message change; tool-call ids, results, thinking blocks and every other message stay the
 * same objects. Each call pairs with the tool results of its own turn. Without a change the same
 * list returns.
 */
export function foldMessages<T>(
	messages: T[],
	folded: ReadonlyMap<string, FoldedRun>,
	launches: ReadonlyMap<string, LaunchedRun[]> = new Map(),
): T[] {
	if (folded.size === 0) return messages;
	let changed = false;
	const next = messages.map((message, index) => {
		const out = foldMessage(message as unknown, () => turnResults(messages, index), folded, launches);
		if (out !== message) changed = true;
		return out as T;
	});
	return changed ? next : messages;
}

/** The tool results after the assistant message at `index`, up to the next assistant message. */
function turnResults(messages: readonly unknown[], index: number): Map<string, Rec> {
	const results = new Map<string, Rec>();
	for (let i = index + 1; i < messages.length; i++) {
		const message = messages[i];
		if (!isRecord(message) || message.role === "assistant") break;
		if (message.role === "toolResult" && typeof message.toolCallId === "string")
			results.set(message.toolCallId, message);
	}
	return results;
}

function foldMessage(
	message: unknown,
	results: () => Map<string, Rec>,
	folded: ReadonlyMap<string, FoldedRun>,
	launches: ReadonlyMap<string, LaunchedRun[]>,
): unknown {
	if (!isRecord(message)) return message;
	if (message.role === "custom") {
		const ids = messageRunIds(message.customType, message.content, message.details);
		const sent = typeof message.timestamp === "number" ? message.timestamp : 0;
		if (!ids || !ids.every((id) => sent <= (folded.get(id)?.foldedAt ?? -1))) return message;
		return { ...message, content: ids.map((id) => runStub(folded.get(id) as FoldedRun)).join("\n") };
	}
	if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
	let changed = false;
	let turn: Map<string, Rec> | undefined;
	const content = message.content.map((block) => {
		if (!isRecord(block) || block.type !== "toolCall" || !isRecord(block.arguments)) return block;
		if (block.name !== "subagent" && block.name !== "codemode") return block;
		turn ??= results();
		const result = typeof block.id === "string" ? turn.get(block.id) : undefined;
		const args =
			block.name === "subagent"
				? foldLaunchArgs(block.arguments, launchChildIds(result?.details), folded)
				: foldScriptArgs(block.arguments, result, folded, launches);
		if (args === block.arguments) return block;
		changed = true;
		return { ...block, arguments: args };
	});
	return changed ? { ...message, content } : message;
}

function isRunning(id: string): boolean {
	const running = runningSubagents.get(id);
	return running !== undefined && running.phase !== "ended";
}

/** The runs a nested subagent call started, with its children's exact task texts; undefined when unsure. */
function launchedRuns(input: unknown, details: unknown): LaunchedRun[] | undefined {
	if (!isRecord(details) || details.status === "launch_failed") return undefined;
	const ids = launchChildIds(details);
	const children = getLaunchCallChildren<Rec>(input);
	if (ids.length !== children.length) return undefined;
	const runs: LaunchedRun[] = [];
	for (const [index, child] of children.entries()) {
		const id = ids[index];
		const task = str(child.task);
		if (!id || !task) return undefined;
		runs.push({ id, task });
	}
	return runs;
}

export function registerContextFold(pi: ExtensionAPI): void {
	// A script's launch call: Pi records the nested call (id and arguments) on the script's result but
	// not the runs it started; this entry keeps them, so a script folds by its actual launches.
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent" || !event.parentToolCallId || event.isError) return;
		const runs = launchedRuns(event.input, (event as { details?: unknown }).details);
		if (runs) pi.appendEntry(CONTEXT_FOLD_LAUNCH_ENTRY, { callId: event.toolCallId, runs });
	});
	pi.on("agent_settled", (_event, ctx) => {
		const runs = settleFold(ctx.sessionManager.getBranch(), isRunning);
		if (runs.length > 0) pi.appendEntry(CONTEXT_FOLD_ENTRY, { runs });
	});
	pi.on("context", (event, ctx) => {
		if (!foldsForApi(ctx.model?.api)) return undefined;
		const branch = ctx.sessionManager.getBranch();
		if (isChildTranscript(branch)) return undefined;
		const messages = foldMessages(event.messages, readFoldedRuns(branch), readLaunches(branch));
		// An unchanged list goes back as no result, so Pi keeps it as it is (extensions.md, context).
		return messages === event.messages ? undefined : { messages };
	});
}
