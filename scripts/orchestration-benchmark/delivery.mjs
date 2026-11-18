/**
 * Delivery accounting of the orchestration benchmark (G2.1): pure functions only.
 *
 * A transfer counts by run id: an entry of the parent session that the extension
 * bound to one finished run (its details carry the run id), whether or not its
 * text holds the expected fact. Transport is counted apart from correctness.
 * Text that a later request repeats is no transfer, so only carrier entries count.
 *
 * Handover of one child run, by run id:
 * - delivered: exactly one own carrier handed the run over inside the sample.
 * - duplicate-carrier: more than one own carrier did (duplicates are reported, not gated).
 * Transport counts to the sample boundary (the parent session as read when
 * observation ended), not to the last assistant stop. availableToAnswer is
 * separate: an own carrier holding the expected result came before the scored
 * reply. The row field delivered, which the verdict uses, is availableToAnswer.
 * - digest: no own carrier, but the result of a digest-producing operation that
 *   the scenario declares (scenario.digestOperations: tool name and the launch
 *   names it covers) holds the result. A scenario without that declaration has
 *   no digest class, so a sibling's quote never hides a missing handover.
 * - undelivered: no carrier, but the child ended its turn. This is the gate class:
 *   the spec gates on zero lost AND zero parked, so their sum is the gate.
 *   Its subClass comes only from positive evidence, never from stopReason:
 *   - parked needs a parent session entry that records the result as queued for a
 *     later turn (for example a nextTurn queue entry naming the run id);
 *   - lost needs a parent session entry that records the result as dropped or
 *     failed to send for that run id;
 *   - unknown otherwise. Pi 1.5.2 queues nextTurn messages in memory only
 *     (agent-session.js), and v2.9.2 writes no queue or drop entry, so its
 *     session files hold neither kind of evidence: the subClass is unknown there.
 * - no-result: the child did not end its turn, so there was nothing to hand over.
 * - unbound: the child's name matches no single run id the parent launched.
 *
 * Outcome class of one child (AGENTS.md): duplicate when the parent read the
 * child's fixture file itself; clean_yield when the child fulfilled its contract,
 * its result reached the parent by its own run id and the parent's terminal reply
 * contains it; auxiliary otherwise.
 */
import { holdsResult, resolveReadPath, textOf } from "./record.mjs";

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
 * @returns {Array<{kind: "result-message" | "tool-result", index: number,
 *   runId: string | null, tool: string | null, text: string}>}
 */
export function carriers(events, parentToolAllowlist) {
	const found = [];
	events.forEach((e, index) => {
		if (e?.type === "custom_message" && e.customType === RESULT_MESSAGE) {
			const runId = typeof e.details?.id === "string" ? e.details.id : null;
			found.push({
				kind: "result-message",
				index,
				runId,
				tool: null,
				text: textOf(e.content),
			});
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
		if (runs.length === 0)
			found.push({
				kind: "tool-result",
				index,
				runId: null,
				tool: m.toolName,
				text,
			});
		for (const run of runs) {
			const own =
				runs.length === 1 && !Array.isArray(m.details?.children)
					? text
					: typeof run.summary === "string"
						? run.summary
						: "";
			found.push({
				kind: "tool-result",
				index,
				runId: run.id,
				tool: m.toolName,
				text: own,
			});
		}
	});
	return found;
}

/**
 * Sub-class of an undelivered run (see the module header for the evidence each
 * needs). The supported release writes neither kind of evidence, so it is
 * unknown; an adapter for a release that records queue or drop entries adds
 * the check here.
 */
function undeliveredSubClass() {
	return "unknown";
}

/**
 * Handover class of one run (see the module header).
 * @param {{runId: string | null, contract: object | undefined, ended: boolean, carried: object[],
 *   digests: object[], answeredAt: number}} input - answeredAt: entry index of the
 *   scored reply; digests: results of declared digest operations that cover this run
 */
export function handover({
	runId,
	contract,
	ended,
	carried,
	digests,
	answeredAt,
}) {
	const holds = (c) => Boolean(contract) && holdsResult(c.text, contract);
	if (!runId) return { handover: "unbound", transfers: 0, correct: false };
	const own = carried.filter((c) => c.runId === runId);
	const correct = own.some((c) => c.index < answeredAt && holds(c));
	if (own.length > 1)
		return { handover: "duplicate-carrier", transfers: own.length, correct };
	if (own.length === 1) return { handover: "delivered", transfers: 1, correct };
	if (digests.some(holds))
		return { handover: "digest", transfers: 0, correct: false };
	if (!ended) return { handover: "no-result", transfers: 0, correct: false };
	return {
		handover: "undelivered",
		subClass: undeliveredSubClass(),
		transfers: 0,
		correct: false,
	};
}

/**
 * Delivery accounting of one attempt. Carriers count over the whole parent
 * session; availability to the answer counts up to the reply the observer scored.
 * @param {object} input
 * @param {object[]} input.parentEvents
 * @param {Array<{name: string | null, role: string | null, contract: object | undefined,
 *   ended: boolean, fulfils: {read: boolean, returned: boolean}}>} input.children
 * @param {number | null} input.answeredAt - entry index of the reply the observer
 *   scored; null when none was scored (a timeout): then no carrier is available.
 * @param {{parentToolAllowlist: string[], parentLoadTool: string,
 *   digestOperations?: Array<{toolName: string, covers: string[]}>}} input.scenario
 * @param {string} input.workDir
 */
export function deliveryAccounting({
	parentEvents,
	children,
	answeredAt = null,
	scenario,
	workDir,
}) {
	const runs = launchedRuns(parentEvents, scenario.parentLoadTool);
	const cutoff = answeredAt ?? -1;
	const carried = carriers(parentEvents, scenario.parentToolAllowlist);
	const finalText =
		answeredAt === null ? "" : textOf(parentEvents[answeredAt].message.content);
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
		const digests = carried.filter((c) =>
			(scenario.digestOperations ?? []).some(
				(op) => op.toolName === c.tool && op.covers.includes(child.name),
			),
		);
		const { correct, ...result } = handover({
			runId,
			contract: child.contract,
			ended: child.ended,
			carried,
			digests,
			answeredAt: cutoff,
		});
		const readByParent = (child.contract?.reads ?? []).some((file) =>
			parentReads.includes(resolveReadPath(file, workDir)),
		);
		// Delivered for the verdict: an own carrier held the expected result before the scored reply.
		const byOwnRun = correct;
		// By key for a keyed contract: a value under another key is not surfaced.
		const surfaced =
			Boolean(child.contract) && holdsResult(finalText, child.contract);
		const outcome = readByParent
			? "duplicate"
			: child.fulfils.read && child.fulfils.returned && byOwnRun && surfaced
				? "clean_yield"
				: "auxiliary";
		return {
			runId,
			role: child.role,
			...result,
			availableToAnswer: correct,
			delivered: byOwnRun,
			outcome,
		};
	});
	const count = (key, value) => rows.filter((row) => row[key] === value).length;
	return {
		runs: rows,
		transfers: rows.reduce((sum, row) => sum + row.transfers, 0),
		// Extra copies: carriers beyond the first of each run (three carriers of one run are two).
		extraCopies: rows.reduce(
			(sum, row) =>
				sum + (row.handover === "duplicate-carrier" ? row.transfers - 1 : 0),
			0,
		),
		undelivered: count("handover", "undelivered"),
		undeliveredBySubClass: {
			parked: count("subClass", "parked"),
			lost: count("subClass", "lost"),
			unknown: count("subClass", "unknown"),
		},
		digests: count("handover", "digest"),
		unbound: count("handover", "unbound"),
		outcomeClasses: {
			clean_yield: count("outcome", "clean_yield"),
			duplicate: count("outcome", "duplicate"),
			auxiliary: count("outcome", "auxiliary"),
		},
		// The carrier stream without text, so the transport classes can be recomputed:
		// entry index and run id of each carrier, and the index of the scored reply.
		carrierEvents: carried
			.filter((c) => c.runId)
			.map(({ kind, index, runId }) => ({ kind, index, runId })),
		answeredAt,
		cleanYieldShare: rows.length
			? count("outcome", "clean_yield") / rows.length
			: null,
	};
}
