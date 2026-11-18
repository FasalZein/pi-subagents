/**
 * Delivery accounting of the orchestration benchmark (G2.1): pure functions only.
 *
 * A transfer counts by run id: an entry of the parent session that the extension
 * bound to one finished run (its details carry the run id), whether or not its
 * text holds the expected fact. Transport is counted apart from correctness.
 * Text that a later request repeats is no transfer, so only carrier entries count.
 *
 * Handover of one child run, by run id:
 * - delivered: exactly one own carrier handed the run over before the terminal reply.
 * - duplicate-carrier: more than one own carrier did (duplicates are reported, not gated).
 * The row field delivered is stricter: an own carrier holds the expected result.
 * - digest: no own carrier, but another carrier or allowed tool result holds the
 *   result (a deliberate digest, for example a workflow script). It is not lost.
 * - parked: no carrier, the child ended with its result, and the parent ended its
 *   turn: the result waits for user input that never comes inside the deadline.
 * - lost: no carrier, the child ended with its result, and the parent did not end its turn.
 * - no-result: the child did not end its turn, so there was nothing to hand over.
 * - unbound: the child's name matches no single run id the parent launched.
 *
 * Outcome class of one child (AGENTS.md): duplicate when the parent read the
 * child's fixture file itself; clean_yield when the child fulfilled its contract,
 * its result reached the parent by its own run id and the parent's terminal reply
 * contains it; auxiliary otherwise.
 */
import {
	containsToken,
	resolveReadPath,
	resultTokens,
	textOf,
} from "./record.mjs";

const RESULT_MESSAGE = "subagent_result";
// Tool result states that announce a run but carry no result yet.
const NOT_A_RESULT = new Set(["started", "running", "pending", "pinged"]);

/** Run entries a details object names: one run, or a batch with a children list. */
function runsOf(details) {
	const list = Array.isArray(details?.children) ? details.children : [details];
	return list.filter((run) => typeof run?.id === "string");
}

/** Run ids the parent launched, with their names, from successful launch tool results. */
export function launchedRuns(events, launchTool) {
	const runs = new Map();
	for (const e of events) {
		const m = e?.type === "message" ? e.message : null;
		if (m?.role !== "toolResult" || m.toolName !== launchTool || m.isError)
			continue;
		for (const run of runsOf(m.details))
			runs.set(run.id, { runId: run.id, name: run.name ?? null });
	}
	return [...runs.values()];
}

/**
 * Entries of the parent that hold child output, in order: result messages and
 * results of allowed tools, one row per finished run an entry names. runId is
 * null when the entry names no finished run.
 * @returns {Array<{index: number, runId: string | null, text: string}>}
 */
export function carriers(events, parentToolAllowlist) {
	const found = [];
	events.forEach((e, index) => {
		if (e?.type === "custom_message" && e.customType === RESULT_MESSAGE) {
			const runId = typeof e.details?.id === "string" ? e.details.id : null;
			found.push({ index, runId, text: textOf(e.content) });
			return;
		}
		const m = e?.type === "message" ? e.message : null;
		if (
			m?.role !== "toolResult" ||
			m.isError ||
			!parentToolAllowlist.includes(m.toolName)
		)
			return;
		const runs = runsOf(m.details).filter(
			(run) => !NOT_A_RESULT.has(run.status ?? m.details?.status),
		);
		const text = textOf(m.content);
		// An entry without a run is a digest candidate. A single run owns the entry's
		// text; a batch result binds each run to its own summary, not the joined text.
		if (runs.length === 0) found.push({ index, runId: null, text });
		for (const run of runs) {
			const own =
				runs.length === 1 && !Array.isArray(m.details?.children)
					? text
					: typeof run.summary === "string"
						? run.summary
						: "";
			found.push({ index, runId: run.id, text: own });
		}
	});
	return found;
}

function terminalIndex(events) {
	let last = -1;
	events.forEach((e, index) => {
		if (e?.type === "message" && e.message?.role === "assistant") last = index;
	});
	return last;
}

/**
 * Handover class of one run (see the module header).
 * @param {{runId: string | null, tokens: string[], ended: boolean, carried: object[], parentIdle: boolean}} input
 */
export function handover({ runId, tokens, ended, carried, parentIdle }) {
	const holds = (c) =>
		tokens.length > 0 && tokens.every((token) => containsToken(c.text, token));
	if (!runId) return { handover: "unbound", transfers: 0, correct: false };
	const own = carried.filter((c) => c.runId === runId);
	const correct = own.some(holds);
	if (own.length > 1)
		return { handover: "duplicate-carrier", transfers: own.length, correct };
	if (own.length === 1) return { handover: "delivered", transfers: 1, correct };
	if (carried.some(holds))
		return { handover: "digest", transfers: 0, correct: false };
	if (!ended) return { handover: "no-result", transfers: 0, correct: false };
	return {
		handover: parentIdle ? "parked" : "lost",
		transfers: 0,
		correct: false,
	};
}

/**
 * Delivery accounting of one attempt. Carriers count up to the parent's terminal
 * reply when it has one, else over the whole session (a timeout).
 * @param {object} input
 * @param {object[]} input.parentEvents
 * @param {Array<{name: string | null, role: string | null, contract: object | undefined,
 *   ended: boolean, fulfils: {read: boolean, returned: boolean}}>} input.children
 * @param {{terminal: boolean}} input.parentReply
 * @param {{parentToolAllowlist: string[], parentLoadTool: string}} input.scenario
 * @param {string} input.workDir
 */
export function deliveryAccounting({
	parentEvents,
	children,
	parentReply,
	scenario,
	workDir,
}) {
	const runs = launchedRuns(parentEvents, scenario.parentLoadTool);
	const end = parentReply.terminal
		? terminalIndex(parentEvents)
		: parentEvents.length;
	const carried = carriers(parentEvents, scenario.parentToolAllowlist).filter(
		(c) => c.index < end,
	);
	const finalText = parentReply.terminal
		? textOf(parentEvents[terminalIndex(parentEvents)].message.content)
		: "";
	const parentReads = parentEvents.flatMap((e) =>
		e?.type === "message" && e.message?.role === "assistant"
			? (e.message.content ?? [])
					.filter((part) => part.type === "toolCall" && part.name === "read")
					.map((part) => resolveReadPath(part.arguments?.path, workDir))
			: [],
	);
	const rows = children.map((child) => {
		const named = runs.filter((run) => run.name && run.name === child.name);
		const runId = named.length === 1 ? named[0].runId : null;
		const tokens = child.contract ? resultTokens(child.contract) : [];
		const { correct, ...result } = handover({
			runId,
			tokens,
			ended: child.ended,
			carried,
			parentIdle: parentReply.terminal,
		});
		const readByParent = (child.contract?.reads ?? []).some((file) =>
			parentReads.includes(resolveReadPath(file, workDir)),
		);
		// Delivered for the verdict: an own carrier holds the expected result.
		const byOwnRun = correct;
		const surfaced =
			tokens.length > 0 &&
			tokens.every((token) => containsToken(finalText, token));
		const outcome = readByParent
			? "duplicate"
			: child.fulfils.read && child.fulfils.returned && byOwnRun && surfaced
				? "clean_yield"
				: "auxiliary";
		return { runId, role: child.role, ...result, delivered: byOwnRun, outcome };
	});
	const count = (key, value) => rows.filter((row) => row[key] === value).length;
	return {
		runs: rows,
		transfers: rows.reduce((sum, row) => sum + row.transfers, 0),
		duplicated: rows.reduce(
			(sum, row) =>
				sum + (row.handover === "duplicate-carrier" ? row.transfers - 1 : 0),
			0,
		),
		lost: count("handover", "lost"),
		parked: count("handover", "parked"),
		digests: count("handover", "digest"),
		unbound: count("handover", "unbound"),
		outcomeClasses: {
			clean_yield: count("outcome", "clean_yield"),
			duplicate: count("outcome", "duplicate"),
			auxiliary: count("outcome", "auxiliary"),
		},
		cleanYieldShare: rows.length
			? count("outcome", "clean_yield") / rows.length
			: null,
	};
}
