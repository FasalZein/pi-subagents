/**
 * Sample record of the orchestration benchmark: pure functions only.
 *
 * A sample is identified by its key (checkout, fixture, harness, model and
 * thinking, settings, scenario, repetition). The record is sealed with a
 * checksum so that a rerun can tell a finished sample from a damaged file.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";

// 3: final.delivery (outcome classes, transfers by run id), keyed answers.
export const RECORD_SCHEMA = 3;

/**
 * Verdicts of a completed sample. A completed sample keeps its verdict on rerun.
 * wrong-delegation: the answer came, but not through the expected children.
 */
const VERDICTS = Object.freeze([
	"pass",
	"wrong-answer",
	"wrong-delegation",
	"timeout",
]);

export function sha256(text) {
	return createHash("sha256").update(text).digest("hex");
}

/** JSON with sorted object keys, so equal values always hash equal. */
export function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const keys = Object.keys(value)
			.filter((key) => value[key] !== undefined)
			.sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * @param {{checkoutRevision: string, fixtureHash: string, harnessHash: string, model: string,
 *   thinking: string, settingsHash: string, scenario: string, rep: number}} parts
 */
export function sampleKey(parts) {
	const key = {
		checkoutRevision: parts.checkoutRevision,
		fixtureHash: parts.fixtureHash,
		harnessHash: parts.harnessHash,
		model: parts.model,
		thinking: parts.thinking,
		settingsHash: parts.settingsHash,
		scenario: parts.scenario,
		rep: parts.rep,
	};
	for (const [name, value] of Object.entries(key)) {
		if (value === undefined || value === "")
			throw new Error(`sample key is missing ${name}`);
	}
	return key;
}

export function sampleKeyId(key) {
	return sha256(canonicalJson(key));
}

/** File name of a sample: readable prefix plus the key hash, which already contains scenario and rep. */
export function sampleFileName(key) {
	return `${key.scenario}-rep${key.rep}-${sampleKeyId(key).slice(0, 16)}.json`;
}

export function sealRecord(record) {
	const { checksum: _drop, ...body } = record;
	return { ...body, checksum: sha256(canonicalJson(body)) };
}

function hasValidChecksum(record) {
	if (
		!record ||
		typeof record !== "object" ||
		typeof record.checksum !== "string"
	)
		return false;
	const { checksum, ...body } = record;
	return checksum === sha256(canonicalJson(body));
}

/**
 * What a rerun does with an existing sample file.
 * @param {string | null} existingText - file content, or null when no file exists
 * @param {object} key - the key of the sample the command asks for
 * @returns {{action: "run" | "skip", reason: string}}
 */
export function rerunDecision(existingText, key) {
	if (existingText === null) return { action: "run", reason: "no sample file" };
	let record;
	try {
		record = JSON.parse(existingText);
	} catch {
		return { action: "run", reason: "sample file is not JSON" };
	}
	if (!hasValidChecksum(record))
		return { action: "run", reason: "checksum does not match" };
	if (sampleKeyId(record.key) !== sampleKeyId(key))
		return { action: "run", reason: "sample file has another key" };
	if (record.outcome === "verdict" && VERDICTS.includes(record.verdict)) {
		return {
			action: "skip",
			reason: `completed with verdict ${record.verdict}`,
		};
	}
	return {
		action: "run",
		reason: `ended without a verdict: ${record.infraReason ?? "unknown"}`,
	};
}

// ---- Usage ledger -------------------------------------------------------------

const LAUNCH_METADATA = "pi-subagents_launch_metadata";

/**
 * Every usage-bearing entry of one session, in order. Shapes of the Pi 1.5.2
 * session format (docs/session-format.md, docs/message-types.md):
 * - message entries: `message.usage`, required on assistant messages, optional on
 *   others (a tool result carries the nested model work of its tool);
 * - other entries: top-level `usage` (usage, compaction, branch_summary).
 * An assistant message without usage counts as missing evidence.
 * @returns {{ledger: Array<object>, missingUsage: number}}
 */
export function usageLedger(events) {
	const ledger = [];
	let missingUsage = 0;
	for (const event of events) {
		const isMessage = event?.type === "message";
		const isAssistant = isMessage && event.message?.role === "assistant";
		const usage = isMessage ? event.message?.usage : event?.usage;
		if (!usage || typeof usage !== "object") {
			if (isAssistant) missingUsage += 1;
			continue;
		}
		const fields = ["input", "cacheRead", "cacheWrite", "output"];
		if (
			fields.some((field) => typeof usage[field] !== "number") ||
			typeof usage.cost?.total !== "number"
		) {
			missingUsage += 1;
			continue;
		}
		ledger.push({
			id: event.id ?? null,
			type: isMessage ? (event.message.role ?? "message") : event.type,
			kind: event.kind ?? null,
			tool: isMessage ? (event.message.toolName ?? null) : null,
			stopReason: isAssistant ? (event.message.stopReason ?? null) : null,
			input: usage.input,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			output: usage.output,
			cost: usage.cost.total,
		});
	}
	return { ledger, missingUsage };
}

const isToolUsage = (row) => row.type === "toolResult";

/**
 * Totals of ledger rows. Every row adds its tokens and cost. requests counts
 * the session's own model requests (every row except a tool result);
 * toolUsageEntries counts tool-result rows, each of which may stand for
 * several nested calls of the tool and is no request of this session.
 */
export function totals(rows) {
	const toolUsageEntries = rows.filter(isToolUsage).length;
	const sum = {
		requests: rows.length - toolUsageEntries,
		toolUsageEntries,
		input: 0,
		cacheRead: 0,
		cacheWrite: 0,
		output: 0,
		cost: 0,
	};
	for (const row of rows) {
		for (const field of ["input", "cacheRead", "cacheWrite", "output", "cost"])
			sum[field] += row[field];
	}
	return {
		...sum,
		cumulativeInput: sum.input + sum.cacheRead + sum.cacheWrite,
	};
}

const toolAttributed = (ledger) => totals(ledger.filter(isToolUsage));

/**
 * Parent cost: all model-attributed entries; the conversational subtotal
 * (assistant messages only) and the tool-attributed subtotal (tool results) apart.
 */
export function summarizeParent(events) {
	const { ledger, missingUsage } = usageLedger(events);
	return {
		all: totals(ledger),
		conversation: totals(ledger.filter((row) => row.type === "assistant")),
		toolAttributed: toolAttributed(ledger),
		errorRequests: ledger.filter((row) => row.stopReason === "error").length,
		missingUsage,
		ledger,
	};
}

/**
 * Index after the child's own launch boundary: the LAST launch marker, because a
 * nested fork copies its ancestors' markers before its own.
 */
function launchBoundary(events) {
	for (let i = events.length - 1; i >= 0; i--) {
		if (
			events[i]?.type === "custom" &&
			events[i].customType === LAUNCH_METADATA
		)
			return i;
	}
	return -1;
}

export function summarizeChild(events) {
	const boundary = launchBoundary(events);
	if (boundary < 0) return null;
	const metadata = events[boundary].data ?? {};
	const { ledger, missingUsage } = usageLedger(events.slice(boundary));
	return {
		role: metadata.agent ?? null,
		name: metadata.name ?? null,
		launchedAt: events[boundary].timestamp ?? null,
		launchEntryId: events[boundary].id ?? null,
		...totals(ledger),
		toolAttributed: toolAttributed(ledger),
		errorRequests: ledger.filter((row) => row.stopReason === "error").length,
		missingUsage,
		ledger,
	};
}

/** Children in launch order (launch marker time, then entry id for a tie). */
export function summarizeChildren(childEventLists) {
	const children = childEventLists
		.map(summarizeChild)
		.filter(Boolean)
		.sort(
			(a, b) =>
				String(a.launchedAt).localeCompare(String(b.launchedAt)) ||
				String(a.launchEntryId).localeCompare(String(b.launchEntryId)),
		);
	return {
		roles: children.map((child) => child.role),
		children: children.map((child, index) => ({ order: index + 1, ...child })),
		cost: children.reduce((sum, child) => sum + child.cost, 0),
		errorRequests: children.reduce(
			(sum, child) => sum + child.errorRequests,
			0,
		),
		missingUsage: children.reduce((sum, child) => sum + child.missingUsage, 0),
	};
}

// ---- Scoring ------------------------------------------------------------------

function assistantMessages(events) {
	return events
		.filter(
			(event) =>
				event?.type === "message" && event.message?.role === "assistant",
		)
		.map((e) => e.message);
}

/** Tool names the parent called, in order. */
export function parentToolCalls(events) {
	return assistantMessages(events).flatMap((message) =>
		(message.content ?? [])
			.filter((part) => part.type === "toolCall")
			.map((part) => part.name),
	);
}

const lines = (text) =>
	text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

/** Single answer: the last non-empty line when it is `ANSWER: <value>`, else null. */
export function singleAnswer(text) {
	const match = lines(text)
		.at(-1)
		?.match(/^ANSWER:\s*`?([^\s`]+?)`?\.?$/);
	return match ? match[1] : null;
}

/**
 * Keyed answer: one `<KEY>: <value>` line per key, values by key; null when no key line exists.
 * A repeated key keeps its last line.
 * @param {string[]} keys
 */
export function keyedAnswer(keys) {
	return (text) => {
		const found = {};
		for (const line of lines(text)) {
			const match = line.match(/^`?([\w-]+)`?:\s*`?([^\s`]+?)`?\.?$/);
			if (match && keys.includes(match[1])) found[match[1]] = match[2];
		}
		return Object.keys(found).length ? found : null;
	};
}

/** The answer parser a scenario declares: keyed by expectedFacts, else a single answer. */
export function answerParser(scenario) {
	return scenario.expectedFacts
		? keyedAnswer(Object.keys(scenario.expectedFacts))
		: singleAnswer;
}

/**
 * The parent's terminal reply: the last assistant message, when it ended normally,
 * and the answer that parse finds in its text.
 * @returns {{terminal: boolean, answer: string | object | null}}
 */
export function terminalAnswer(events, parse = singleAnswer) {
	const last = assistantMessages(events).at(-1);
	if (last?.stopReason !== "stop") return { terminal: false, answer: null };
	return { terminal: true, answer: parse(textOf(last.content)) };
}

export function textOf(content) {
	if (typeof content === "string") return content;
	return (content ?? [])
		.map((part) => (part?.type === "text" ? part.text : ""))
		.join("\n");
}

/**
 * True when text contains token as a whole word: no letter, digit, underscore or
 * hyphen directly before or after it, so "lantern-41270" does not contain "lantern-4127".
 */
export function containsToken(text, token) {
	const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`,
		"u",
	).test(text);
}

/** True when the child's own last reply ended its turn normally. */
export function childEnded(events) {
	const own = events.slice(Math.max(0, launchBoundary(events)) + 1);
	return assistantMessages(own).at(-1)?.stopReason === "stop";
}

// macOS names a temporary folder with or without its /private prefix.
const withoutPrivate = (path) =>
	path.replace(/^\/private(?=\/(var|tmp)\/)/, "");

/** A read path resolved against the child's working folder. */
export function resolveReadPath(path, cwd) {
	return withoutPrivate(posix.resolve(withoutPrivate(cwd), String(path ?? "")));
}

/** The result tokens a contract declares: one string or a list. */
export const resultTokens = (contract) =>
	Array.isArray(contract.returns) ? contract.returns : [contract.returns];

/**
 * Whether a child met the contract its scenario declares for its role: it read
 * every named fixture file with a successful read call, and its final reply
 * contains every result token it must return as a whole token. Only entries after its own launch marker count.
 * A read counts by its path inside the fixture copy (workDir), resolved against
 * the child's session cwd, so a file of the same name elsewhere does not count.
 * @param {object[]} events - the child's session
 * @param {{returns: string | string[], reads: string[]}} contract
 * @param {string} workDir - the fixture copy the attempt runs in
 * @returns {{read: boolean, returned: boolean}}
 */
export function childFulfils(events, contract, workDir) {
	const cwd = events.find((e) => e?.type === "session")?.cwd ?? workDir;
	const own = events.slice(Math.max(0, launchBoundary(events)));
	const okResults = new Set(
		own
			.filter(
				(e) =>
					e?.type === "message" &&
					e.message?.role === "toolResult" &&
					!e.message.isError,
			)
			.map((e) => e.message.toolCallId),
	);
	const readFiles = assistantMessages(own).flatMap((message) =>
		(message.content ?? [])
			.filter(
				(part) =>
					part.type === "toolCall" &&
					part.name === "read" &&
					okResults.has(part.id),
			)
			.map((part) => resolveReadPath(part.arguments?.path, cwd)),
	);
	const last = assistantMessages(own).at(-1);
	return {
		read: contract.reads.every((file) =>
			readFiles.includes(resolveReadPath(file, workDir)),
		),
		returned:
			last?.stopReason === "stop" &&
			resultTokens(contract).every((token) =>
				containsToken(textOf(last.content), token),
			),
	};
}

/**
 * Verdict of a finished attempt. The answer must be right AND the work must have
 * gone through exactly the expected children, with the parent calling only the
 * tools the scenario allows, AND every child must have produced the result its
 * role declares (scenario.childResults) and that result must have reached the parent.
 * @param {{answer: string | null, childRoles: string[], parentTools: string[],
 *   childOutcomes: Array<{read: boolean, returned: boolean, delivered: boolean}>,
 *   scenario: {expectedAnswer: string, expectedChildRoles: string[], parentToolAllowlist: string[]}}} input
 */
export function scoreAttempt({
	answer,
	childRoles,
	parentTools,
	childOutcomes,
	scenario,
}) {
	if (!answerMatches(answer, scenario)) return "wrong-answer";
	// A batch launch has no fixed order; scenario.childOrder "any" compares the sorted roles.
	const order = (roles) =>
		scenario.childOrder === "any" ? [...roles].sort() : roles;
	const sameChildren =
		canonicalJson(order(childRoles)) ===
		canonicalJson(order(scenario.expectedChildRoles));
	const allowed = parentTools.every((name) =>
		scenario.parentToolAllowlist.includes(name),
	);
	const childrenDelivered = childOutcomes.every(
		(child) => child.read && child.returned && child.delivered,
	);
	return sameChildren && allowed && childrenDelivered
		? "pass"
		: "wrong-delegation";
}

/** The oracle: a keyed answer matches when every expected key has its value. */
export function answerMatches(answer, scenario) {
	if (!scenario.expectedFacts) return answer === scenario.expectedAnswer;
	return Object.entries(scenario.expectedFacts).every(
		([key, value]) => answer?.[key] === value,
	);
}

/** True when the last parent request ended with a provider error. */
export function endsWithProviderError(events) {
	return assistantMessages(events).at(-1)?.stopReason === "error";
}

// ---- Load evidence ------------------------------------------------------------

/**
 * Proof that each process loaded the extension from the checkout: a probe per
 * session lists the registered tools and the file each came from (Pi sourceInfo).
 * @param {Array<{sessionFile: string, agent: string | null, tools: Array<{name: string, path: string}>}>} probes
 * otherFiles are the remaining session files of the attempt (no parent, no
 * launch marker): each needs a probe too, or it counts as a missing probe. Its
 * probe is still unmatched, because the file is no parent or child session.
 * @param {{parentFile: string, childFiles: string[], otherFiles: string[], checkout: string, parentTool: string, childTool: string}} input
 */
export function loadEvidence(
	probes,
	{ parentFile, childFiles, otherFiles, checkout, parentTool, childTool },
) {
	const bySession = new Map(probes.map((probe) => [probe.sessionFile, probe]));
	const fromCheckout = (probe, tool) =>
		Boolean(
			probe?.tools.some(
				(t) => t.name === tool && t.path.startsWith(`${checkout}/`),
			),
		);
	const parent = bySession.get(parentFile);
	const children = childFiles.map((file) => ({
		file,
		probe: bySession.get(file),
	}));
	const missing = [
		parent ? null : "parent",
		...children.filter((c) => !c.probe).map(() => "child"),
		...otherFiles.filter((file) => !bySession.has(file)).map(() => "other"),
	].filter(Boolean);
	// The reverse join: every probe needs its own session file of this attempt.
	const sessionFiles = new Set([parentFile, ...childFiles]);
	const unmatchedProbes =
		probes.filter((probe) => !sessionFiles.has(probe.sessionFile)).length +
		(probes.length - bySession.size);
	return {
		checkout,
		missingProbes: missing.length,
		unmatchedProbes,
		parentLoadedCheckout: fromCheckout(parent, parentTool),
		childrenLoadedCheckout: children.every((child) =>
			fromCheckout(child.probe, childTool),
		),
		parentModel: parent?.model ?? null,
		parentThinking: parent?.thinking ?? null,
		children: children.map((child) => ({
			agent: child.probe?.agent ?? null,
			loadedCheckout: fromCheckout(child.probe, childTool),
			model: child.probe?.model ?? null,
			thinking: child.probe?.thinking ?? null,
		})),
	};
}
