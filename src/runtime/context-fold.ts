import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseJsonContainer } from "../tools/json-string-args.ts";
import { isFinishedStatus, runEndIds, runEnds } from "./run-end-message.ts";
import { runningSubagents } from "./state.ts";

/**
 * The settle fold (owner rule 2026-11-22T08:40Z; model statecharts/context-fold/target/Target.tla).
 * When the parent settles idle, every run the model already used folds: from then on each provider
 * request carries a short stub instead of that run's launch brief and its result message. The
 * session file keeps the full text, and subagent_wait({ runIds }) returns the stored result (D16).
 *
 * The fold set is the union of the durable fold entries on the session branch. Only agent_settled
 * appends one, so a fold never happens mid-turn, the set is the same on every request of a turn
 * and after /reload or resume, and a folded run never comes back in full: the prompt cache breaks
 * at most once per settle.
 */
export const CONTEXT_FOLD_ENTRY = "subagent_context_fold";

/** The facts a stub names; fixed at the settle that folds the run, so every later stub is the same text. */
export interface FoldedRun {
	id: string;
	name: string;
	outcome: string;
	report?: string;
	/**
	 * Epoch ms of the settle that folded the run. A result message of the same run id from after it
	 * (a resumed run that ended again) is not used yet and stays full until a later settle folds it.
	 */
	foldedAt: number;
}

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
	return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Facts of one run read from a details object; the status stands in when no outcome is there. */
function runFacts(id: string, details: Rec): RunFacts {
	const record = isRecord(details.record) ? details.record : {};
	return {
		id,
		name: str(details.name) ?? str(record.name),
		outcome: str(details.outcome) ?? str(record.outcome) ?? str(details.status),
		report: str(details.reportFile),
	};
}

/**
 * The runs whose finished result one committed session entry carries: a subagent_result or
 * subagent_ping message (single or grouped), a launch reply that delivered a report, or a
 * subagent_wait reply. A result inside a codemode script result is not read (see OPEN in the
 * slice report): such a run folds when its result arrives by message.
 */
type RunFacts = Partial<Omit<FoldedRun, "foldedAt">> & { id: string };

function committedResults(entry: unknown): RunFacts[] {
	if (!isRecord(entry)) return [];
	if (entry.type === "custom_message") {
		return runEnds(entry.customType, entry.content, entry.details).flatMap((end) => {
			const id = str(end.details.id);
			return id ? [runFacts(id, end.details)] : [];
		});
	}
	const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
	if (!message || message.role !== "toolResult" || !isRecord(message.details)) return [];
	const details = message.details;
	if (message.toolName === "subagent") {
		const children = Array.isArray(details.children) ? details.children : [details];
		return children.flatMap((child) => {
			if (!isRecord(child) || !isFinishedStatus(str(child.status))) return [];
			const id = str(child.id);
			return id ? [runFacts(id, child)] : [];
		});
	}
	if (message.toolName === "subagent_wait" && Array.isArray(details.results)) {
		return details.results.flatMap((result) => {
			const id = isRecord(result) ? str(result.runId) : undefined;
			return id && isRecord(result) ? [runFacts(id, result)] : [];
		});
	}
	return [];
}

/** Each folded run with the branch index of the last fold entry that names it; a later entry wins. */
function scanFoldEntries(entries: readonly unknown[]): Map<string, { run: FoldedRun; index: number }> {
	const folded = new Map<string, { run: FoldedRun; index: number }>();
	entries.forEach((entry, index) => {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CONTEXT_FOLD_ENTRY) return;
		const runs = isRecord(entry.data) && Array.isArray(entry.data.runs) ? entry.data.runs : [];
		for (const run of runs) {
			if (isRecord(run) && typeof run.id === "string" && typeof run.foldedAt === "number") {
				folded.set(run.id, { run: run as unknown as FoldedRun, index });
			}
		}
	});
	return folded;
}

/** The fold set: every run that a fold entry on this branch names. */
export function readFoldedRuns(entries: readonly unknown[]): Map<string, FoldedRun> {
	return new Map([...scanFoldEntries(entries)].map(([id, { run }]) => [id, run]));
}

/**
 * The runs to fold at this settle: a run ended, a message with its finished result was committed,
 * and a later assistant message (a provider request) saw every such message. A result committed
 * after the last request (an entry of the settle step whose continuation did not run) is not used
 * yet. A run that runs again (a resume) does not fold; once it ended again and a request saw its
 * new result message, it folds again with the new facts. A later wait or launch reply for a folded
 * run stays full (owner rule) and triggers no new fold.
 */
export function settleFold(
	entries: readonly unknown[],
	isRunning: (id: string) => boolean,
	now: number = Date.now(),
): FoldedRun[] {
	const folded = scanFoldEntries(entries);
	const commits = new Map<string, { index: number; messageIndex: number; facts: Omit<RunFacts, "id"> }>();
	let lastRequest = -1;
	entries.forEach((entry, index) => {
		if (isRecord(entry) && entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant") {
			lastRequest = index;
		}
		const isMessage = isRecord(entry) && entry.type === "custom_message";
		for (const facts of committedResults(entry)) {
			const known = commits.get(facts.id);
			const before = known?.facts ?? {};
			commits.set(facts.id, {
				index,
				messageIndex: isMessage ? index : (known?.messageIndex ?? -1),
				facts: {
					name: before.name ?? facts.name,
					outcome: facts.outcome ?? before.outcome,
					report: facts.report ?? before.report,
				},
			});
		}
	});
	const runs: FoldedRun[] = [];
	for (const [id, { index, messageIndex, facts }] of commits) {
		const fold = folded.get(id);
		if (index > lastRequest || isRunning(id) || (fold && messageIndex < fold.index)) continue;
		runs.push({
			id,
			name: facts.name ?? "unnamed",
			outcome: facts.outcome ?? "ended",
			...(facts.report ? { report: facts.report } : {}),
			foldedAt: now,
		});
	}
	return runs;
}

/** The stub of one folded run, for its brief and its result alike. */
export function runStub(run: FoldedRun): string {
	const report = run.report ? `, report ${run.report}` : "";
	return `[Folded subagent run ${run.id} (${run.name}): ${run.outcome}${report}. Full result: subagent_wait({ runIds: ["${run.id}"] })]`;
}

/** A run id as a word of its own: a session file name's hex parts sit between dashes and do not count. */
const RUN_ID_TOKEN = /(?<![0-9A-Za-z_-])[0-9a-f]{8}(?![0-9A-Za-z_-])/g;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : "")).join("\n");
}

/** The run id of each child of a direct launch, by position; undefined where none is known. */
function launchChildIds(details: unknown): Array<string | undefined> {
	if (!isRecord(details)) return [];
	if (Array.isArray(details.children)) {
		return details.children.map((child) => (isRecord(child) ? (str(child.id) ?? str(child.runId)) : undefined));
	}
	return [str(details.id)];
}

function foldLaunchArgs(args: Rec, ids: Array<string | undefined>, folded: ReadonlyMap<string, FoldedRun>): Rec {
	const stubFor = (index: number) => {
		const id = ids[index];
		const run = id ? folded.get(id) : undefined;
		return run ? runStub(run) : undefined;
	};
	const children = parseJsonContainer(args.children);
	if (!Array.isArray(children)) {
		const stub = stubFor(0);
		return stub && typeof args.task === "string" ? { ...args, task: stub } : args;
	}
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

/**
 * A codemode script that launched runs folds only when every run id its result names is folded;
 * it must name at least one id per launch call. A script whose runs are not all folded stays full.
 */
function foldScriptArgs(args: Rec, result: Rec | undefined, folded: ReadonlyMap<string, FoldedRun>): Rec {
	if (!result || typeof args.code !== "string") return args;
	const calls = nestedCalls(result);
	const launches = calls.filter((call) => isRecord(call) && call.name === "subagent").length;
	if (launches === 0) return args;
	const ids = [...new Set(textOf(result.content).match(RUN_ID_TOKEN) ?? [])];
	if (ids.length < launches || !ids.every((id) => folded.has(id))) return args;
	const stubs = ids.map((id) => `// ${runStub(folded.get(id) as FoldedRun)}`);
	return { ...args, code: [`// Folded launch script of runs ${ids.join(", ")}.`, ...stubs].join("\n") };
}

/**
 * The provider messages with the folded runs' briefs and result messages as stubs. Only the task
 * text of a launch call, the code of a codemode launch script and the content of a result message
 * change; tool-call ids, results, thinking blocks and every other message stay the same objects.
 * Without a change the same list returns.
 */
export function foldMessages<T>(messages: T[], folded: ReadonlyMap<string, FoldedRun>): T[] {
	if (folded.size === 0) return messages;
	const results = new Map<string, Rec>();
	for (const message of messages) {
		if (isRecord(message) && message.role === "toolResult" && typeof message.toolCallId === "string") {
			results.set(message.toolCallId, message);
		}
	}
	let changed = false;
	const next = messages.map((message) => {
		const out = foldMessage(message as unknown, results, folded);
		if (out !== message) changed = true;
		return out as T;
	});
	return changed ? next : messages;
}

function foldMessage(message: unknown, results: Map<string, Rec>, folded: ReadonlyMap<string, FoldedRun>): unknown {
	if (!isRecord(message)) return message;
	if (message.role === "custom") {
		const ids = runEndIds(message);
		const sent = typeof message.timestamp === "number" ? message.timestamp : 0;
		if (ids.length === 0 || !ids.every((id) => sent <= (folded.get(id)?.foldedAt ?? -1))) return message;
		return { ...message, content: ids.map((id) => runStub(folded.get(id) as FoldedRun)).join("\n") };
	}
	if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
	let changed = false;
	const content = message.content.map((block) => {
		if (!isRecord(block) || block.type !== "toolCall" || !isRecord(block.arguments)) return block;
		const result = typeof block.id === "string" ? results.get(block.id) : undefined;
		const args =
			block.name === "subagent"
				? foldLaunchArgs(block.arguments, launchChildIds(result?.details), folded)
				: block.name === "codemode"
					? foldScriptArgs(block.arguments, result, folded)
					: block.arguments;
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

/** A child session (PI_SUBAGENT_SESSION set) does not fold. */
function isChildSession(): boolean {
	return Boolean(process.env.PI_SUBAGENT_SESSION);
}

export function registerContextFold(pi: ExtensionAPI): void {
	pi.on("agent_settled", (_event, ctx) => {
		if (isChildSession()) return;
		const runs = settleFold(ctx.sessionManager.getBranch(), isRunning);
		if (runs.length > 0) pi.appendEntry(CONTEXT_FOLD_ENTRY, { runs });
	});
	pi.on("context", (event, ctx) => {
		if (isChildSession()) return undefined;
		const messages = foldMessages(event.messages, readFoldedRuns(ctx.sessionManager.getBranch()));
		// An unchanged list goes back as no result, so Pi keeps it as it is (extensions.md, context).
		return messages === event.messages ? undefined : { messages };
	});
}
