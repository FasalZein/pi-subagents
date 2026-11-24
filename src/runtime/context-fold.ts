import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseJsonContainer } from "../tools/json-string-args.ts";
import { WAITED_RETURN_LINE } from "../tools/launch-reply.ts";
import { type FoldedScript, readFoldedScripts, scriptKey, settleScripts } from "./context-fold-scripts.ts";
import {
	CONTEXT_FOLD_ENTRY,
	CONTEXT_FOLD_LAUNCH_ENTRY,
	type FoldedRun,
	isChildTranscript,
	isRecord,
	isVerifiedOrNotice,
	messageRunIds,
	readFoldedRuns,
	replyDigest,
	settleFold,
	str,
} from "./context-fold-set.ts";
import { isFinishedStatus } from "./run-end-message.ts";
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

/** A frozen launch-only script: its whole code becomes one stub naming its runs (context-fold-scripts.ts). */
function scriptStub(script: FoldedScript, folded: ReadonlyMap<string, FoldedRun>): string | undefined {
	const runs = script.runIds.map((id) => folded.get(id));
	if (runs.some((run) => run === undefined)) return undefined;
	const lines = (runs as FoldedRun[]).map((run) => `// ${runStub(run)}`);
	return [`// Folded launch script of runs ${script.runIds.join(", ")}.`, ...lines].join("\n");
}

/** The runs of a tool result that can fold, its creation time, and for a launch reply the head lines it keeps. */
type CleanReply = { ids: string[]; sent: number; head?: string };

/**
 * The text of a reply that is still what its tool built: one text block whose digest the tool kept
 * in the details. Another extension's change to the content (an added block, an appended note)
 * leaves the details, so the digest no longer matches and the reply stays full.
 */
function producerText(content: unknown, details: Rec): string | undefined {
	if (!Array.isArray(content) || content.length !== 1) return;
	const block = content[0];
	if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return;
	return details.replyDigest === replyDigest(block.text) ? block.text : undefined;
}

/**
 * The run ids of a clean subagent_wait join reply (fold-waits S2), or undefined when the reply must
 * stay full: an error (an interrupted wait), a status other than complete (timeout, empty, recent),
 * a pending or missing run, no run, a verified run or provenance notice, content that is not the
 * tool's own text (producerText), or no creation time to compare with a fold.
 */
function cleanWaitReply(message: Rec): CleanReply | undefined {
	const { details, content, timestamp } = message;
	if (message.toolName !== "subagent_wait" || message.isError !== false || typeof timestamp !== "number") return;
	if (!isRecord(details) || producerText(content, details) === undefined) return;
	if (details.status !== "complete" || !Array.isArray(details.results)) return;
	if (!Array.isArray(details.pending) || details.pending.length > 0) return;
	if (!Array.isArray(details.missing) || details.missing.length > 0) return;
	if (details.results.length === 0) return;
	const ids: string[] = [];
	for (const item of details.results) {
		if (!isRecord(item) || isVerifiedOrNotice(item)) return;
		if (isRecord(item.record) && isVerifiedOrNotice(item.record)) return;
		const id = str(item.runId);
		if (!id) return;
		ids.push(id);
	}
	return { ids, sent: timestamp };
}

/**
 * The run ids and head lines of a waited launch or resume reply (fold-waits S3, D2 keep-head), or
 * undefined when it must stay full: an error (a launch failure), a child that did not deliver a
 * finished report (started, interrupted, wait failed), a verified child or provenance notice, content
 * that is not the tool's own text (producerText), or no creation time. The head (child lines up to the first blank line)
 * must be one line per child and then the waited return line; any other head (a partly waited batch,
 * a wait error, a warning) stays full.
 */
function cleanLaunchReply(message: Rec): CleanReply | undefined {
	const { details, content, timestamp } = message;
	if (message.toolName !== "subagent" && message.toolName !== "subagent_resume") return;
	if (message.isError !== false || typeof timestamp !== "number" || !isRecord(details)) return;
	const text = producerText(content, details);
	if (text === undefined) return;
	const children = Array.isArray(details.children) ? details.children : [details];
	if (Array.isArray(details.children) && details.status !== "batch") return;
	if (children.length === 0) return;
	const ids: string[] = [];
	for (const child of children) {
		if (!isRecord(child) || isVerifiedOrNotice(child) || !isFinishedStatus(str(child.status))) return;
		if (isRecord(child.record) && isVerifiedOrNotice(child.record)) return;
		const id = str(child.id) ?? str(child.runId);
		if (!id) return;
		ids.push(id);
	}
	const end = text.indexOf("\n\n");
	const head = end < 0 ? undefined : text.slice(0, end);
	const lines = head?.split("\n");
	if (!lines || lines.length !== ids.length + 1 || lines.at(-1) !== WAITED_RETURN_LINE) return;
	return { ids, sent: timestamp, head };
}

/**
 * A used wait, launch or resume reply becomes its stubs when every run in it folded at a settle after
 * the reply was created (a request saw it): one stub line per run, after the head lines of a launch
 * reply. Call id, tool name, details and the error flag stay, so the reply still pairs with its call.
 */
function foldToolResult(message: Rec, folded: ReadonlyMap<string, FoldedRun>): Rec {
	const clean = message.toolName === "subagent_wait" ? cleanWaitReply(message) : cleanLaunchReply(message);
	if (!clean) return message;
	const runs: FoldedRun[] = [];
	for (const id of clean.ids) {
		const run = folded.get(id);
		if (!run || clean.sent > run.foldedAt) return message;
		runs.push(run);
	}
	const stubs = runs.map(runStub).join("\n");
	const text = clean.head === undefined ? stubs : `${clean.head}\n\n${stubs}`;
	return { ...message, content: [{ type: "text", text }] };
}

/**
 * The provider messages with the folded runs' briefs, result messages and used waited replies as
 * stubs. Only the task text of a launch or resume call, the code of a frozen launch-only script, the
 * content of a result message and the content of a clean wait, launch or resume reply change;
 * tool-call ids, other tool results, thinking blocks and every other message stay the same objects.
 * Each call pairs with the tool results of its own turn. Without a change the same list returns.
 */
export function foldMessages<T>(
	messages: T[],
	folded: ReadonlyMap<string, FoldedRun>,
	scripts: ReadonlyMap<string, FoldedScript> = new Map(),
): T[] {
	if (folded.size === 0) return messages;
	let changed = false;
	const next = messages.map((message, index) => {
		const out = foldMessage(message as unknown, () => turnResults(messages, index), folded, scripts);
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
	scripts: ReadonlyMap<string, FoldedScript>,
): unknown {
	if (!isRecord(message)) return message;
	if (message.role === "custom") {
		const ids = messageRunIds(message.customType, message.content, message.details);
		const sent = typeof message.timestamp === "number" ? message.timestamp : 0;
		if (!ids || !ids.every((id) => sent <= (folded.get(id)?.foldedAt ?? -1))) return message;
		return { ...message, content: ids.map((id) => runStub(folded.get(id) as FoldedRun)).join("\n") };
	}
	if (message.role === "toolResult") return foldToolResult(message, folded);
	if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
	let changed = false;
	let turn: Map<string, Rec> | undefined;
	const content = message.content.map((block) => {
		if (!isRecord(block) || block.type !== "toolCall" || !isRecord(block.arguments)) return block;
		if (block.name !== "subagent" && block.name !== "subagent_resume" && block.name !== "codemode") return block;
		let args = block.arguments;
		if (block.name !== "codemode") {
			// A resume call has the single form (task, no children); its reply names the new run id.
			turn ??= results();
			const result = typeof block.id === "string" ? turn.get(block.id) : undefined;
			args = foldLaunchArgs(block.arguments, launchChildIds(result?.details), folded);
		} else {
			const key = typeof block.id === "string" ? scriptKey(block.id, message.timestamp) : undefined;
			const script = key ? scripts.get(key) : undefined;
			const stub = script && typeof block.arguments.code === "string" ? scriptStub(script, folded) : undefined;
			if (stub) args = { ...block.arguments, code: stub };
		}
		if (args === block.arguments) return block;
		changed = true;
		return { ...block, arguments: args };
	});
	return changed ? { ...message, content } : message;
}

function isRunning(id: string): boolean {
	const running = runningSubagents.get(id);
	return running !== undefined && running.phase.kind !== "ended";
}

export function registerContextFold(pi: ExtensionAPI): void {
	// A script's launch call: Pi records the nested call (id, status) on the script's result but not
	// the runs it started; this entry keeps only the run ids, never the task text.
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "subagent" || !event.parentToolCallId || event.isError) return;
		if (isChildTranscript(ctx.sessionManager.getBranch())) return;
		const runIds = launchChildIds((event as { details?: unknown }).details);
		if (runIds.length === 0 || runIds.some((id) => id === undefined)) return;
		pi.appendEntry(CONTEXT_FOLD_LAUNCH_ENTRY, { callId: event.parentToolCallId, nestedId: event.toolCallId, runIds });
	});
	pi.on("agent_settled", (_event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const runs = settleFold(branch, isRunning);
		if (isChildTranscript(branch)) return;
		const folded = new Set([...readFoldedRuns(branch).keys(), ...runs.map((run) => run.id)]);
		const scripts = settleScripts(branch, (id) => folded.has(id));
		if (runs.length > 0 || scripts.length > 0) pi.appendEntry(CONTEXT_FOLD_ENTRY, { runs, scripts });
	});
	pi.on("context", (event, ctx) => {
		if (!foldsForApi(ctx.model?.api)) return undefined;
		const branch = ctx.sessionManager.getBranch();
		if (isChildTranscript(branch)) return undefined;
		const messages = foldMessages(event.messages, readFoldedRuns(branch), readFoldedScripts(branch));
		// An unchanged list goes back as no result, so Pi keeps it as it is (extensions.md, context).
		return messages === event.messages ? undefined : { messages };
	});
}
