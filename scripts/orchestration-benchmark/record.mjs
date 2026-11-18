/**
 * Sample record of the orchestration benchmark: pure functions only.
 *
 * A sample is identified by its key (checkout, fixture, harness, model and
 * thinking, settings, scenario, repetition). The record is sealed with a
 * checksum so that a rerun can tell a finished sample from a damaged file.
 */
import { createHash } from "node:crypto";

export const RECORD_SCHEMA = 1;

/** Verdicts of a completed sample. A completed sample keeps its verdict on rerun. */
const VERDICTS = Object.freeze(["pass", "wrong-answer", "timeout"]);

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

function assistantMessages(events) {
	return events
		.filter(
			(event) =>
				event?.type === "message" && event.message?.role === "assistant",
		)
		.map((e) => e.message);
}

function addUsage(total, usage) {
	total.input += usage?.input ?? 0;
	total.cacheRead += usage?.cacheRead ?? 0;
	total.cacheWrite += usage?.cacheWrite ?? 0;
	total.output += usage?.output ?? 0;
	total.cost += usage?.cost?.total ?? 0;
	return total;
}

function emptyUsage() {
	return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 };
}

/**
 * Parent cost from its session events. One assistant message is one provider request.
 * Usage entries outside messages (for example cache warming) are counted apart, by kind.
 */
export function summarizeParent(events) {
	const requests = assistantMessages(events);
	const usage = requests.reduce(
		(total, message) => addUsage(total, message.usage),
		emptyUsage(),
	);
	const otherUsage = {};
	for (const event of events) {
		if (event?.type !== "usage") continue;
		const kind = event.kind ?? "unknown";
		otherUsage[kind] = addUsage(
			otherUsage[kind] ?? { ...emptyUsage(), requests: 0 },
			event.usage,
		);
		otherUsage[kind].requests += 1;
	}
	return {
		requests: requests.length,
		errorRequests: requests.filter((message) => message.stopReason === "error")
			.length,
		cumulativeInput: {
			input: usage.input,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			total: usage.input + usage.cacheRead + usage.cacheWrite,
		},
		output: usage.output,
		cost: usage.cost,
		otherUsage,
	};
}

const LAUNCH_METADATA = "pi-subagents_launch_metadata";

/** Child usage counts only after the launch marker; earlier entries can be a seeded parent copy. */
function summarizeChild(events) {
	const markerIndex = events.findIndex(
		(e) => e?.type === "custom" && e.customType === LAUNCH_METADATA,
	);
	if (markerIndex < 0) return null;
	const metadata = events[markerIndex].data ?? {};
	const header = events.find((e) => e?.type === "session");
	const usage = assistantMessages(events.slice(markerIndex)).reduce(
		(t, m) => addUsage(t, m.usage),
		emptyUsage(),
	);
	return {
		role: metadata.agent ?? null,
		name: metadata.name ?? null,
		startedAt: header?.timestamp ?? events[markerIndex].timestamp ?? null,
		requests: assistantMessages(events.slice(markerIndex)).length,
		cost: usage.cost,
		input: usage.input + usage.cacheRead + usage.cacheWrite,
		output: usage.output,
	};
}

/** Children in launch order. */
export function summarizeChildren(childEventLists) {
	const children = childEventLists
		.map(summarizeChild)
		.filter(Boolean)
		.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
	return {
		roles: children.map((child) => child.role),
		children: children.map((child, index) => ({ order: index + 1, ...child })),
		cost: children.reduce((sum, child) => sum + child.cost, 0),
	};
}

/** Final answer of the parent: the last `ANSWER: <value>` in an assistant text that ended normally. */
export function findParentAnswer(events) {
	let answer = null;
	for (const message of assistantMessages(events)) {
		if (message.stopReason !== "stop") continue;
		for (const part of message.content ?? []) {
			if (part.type !== "text") continue;
			for (const match of part.text.matchAll(/ANSWER:\s*(\S+)/g))
				answer = match[1].replace(/^[`*]+|[`*.]+$/g, "");
		}
	}
	return answer;
}

/** True when the last parent request ended with a provider error. */
export function endsWithProviderError(events) {
	return assistantMessages(events).at(-1)?.stopReason === "error";
}
