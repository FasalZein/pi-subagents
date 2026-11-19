/**
 * Evidence of the candidate release (T59a) in a parent session: calls nested in
 * codemode scripts, what each script launched and joined, the workflow-script gate
 * of a scenario that declares one, and parent reads of a run's report locator.
 * v2.9.2 (cf6dbf4) has no codemode parent, no run folders and no wait tool, so
 * none of these shapes occur in its sessions and the baseline scoring is unchanged.
 *
 * Known limit: Pi records a nested call's name, status and raw arguments, not its
 * result. A wait counts as joining a run by its arguments (ids or names, or no ids
 * for the runs the same script launched; mode "any" and recent lookups join none).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveReadPath, textOf } from "./record.mjs";

// The candidate's wait and lookup tool (D15). v2.9.2 (cf6dbf4) registers no such tool.
const WAIT_TOOL = "subagent_wait";

/**
 * Release capabilities of the measured checkout: the candidate declares the wait
 * tool name in src/tools/tool-names.ts; v2.9.2 does not.
 * @returns {{candidate: boolean}}
 */
export function releaseCapabilities(checkout) {
	const names = join(checkout, "src", "tools", "tool-names.ts");
	return {
		candidate:
			existsSync(names) &&
			readFileSync(names, "utf8").includes(`"${WAIT_TOOL}"`),
	};
}

/**
 * The scenario as the harness scores it on one release: on the candidate, a
 * scenario that allows the launch tool also allows the wait tool (joining a run is
 * part of the launch contract there). On v2.9.2 the allowlist stays as T04 froze
 * it, so a refused wait call still fails the sample. The scenario files and their
 * fixture hashes do not change.
 * @param {{candidate: boolean}} release
 */
export function forRelease(scenario, release) {
	const list = scenario.parentToolAllowlist;
	const addWait =
		release.candidate &&
		list.includes(scenario.parentLoadTool) &&
		!list.includes(WAIT_TOOL);
	return {
		...scenario,
		release,
		...(addWait ? { parentToolAllowlist: [...list, WAIT_TOOL] } : {}),
	};
}

/**
 * T64: a model may send an object or array argument as a JSON string, and the
 * candidate parses it before the tool runs (src/tools/json-string-args.ts). Pi
 * records the raw argument, so the scorer parses it the same way.
 */
function parseJsonContainer(value) {
	if (typeof value !== "string" || !/^\s*[[{]/.test(value)) return value;
	try {
		const parsed = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null ? parsed : value;
	} catch {
		return value;
	}
}

// The fields each candidate tool parses (subagent-tools.ts, wait-tool.ts).
const JSON_FIELDS = { subagent: ["children"], [WAIT_TOOL]: ["ids"] };

function normalizedArguments(name, args) {
	const value = parseJsonContainer(args);
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return {};
	const out = { ...value };
	for (const field of JSON_FIELDS[name] ?? [])
		out[field] = parseJsonContainer(out[field]);
	return out;
}

/**
 * Every call nested in a codemode script, whatever its status, with arguments
 * normalized as the candidate parses them. scriptAt: entry index of the script's
 * tool result; scriptOk: that result is not an error.
 * @returns {Array<{name: string, status: string | null, arguments: object,
 *   scriptAt: number, scriptOk: boolean, calledAt: number | null}>}
 */
export function nestedCalls(events) {
	const callAt = new Map();
	events.forEach((e, index) => {
		if (e?.type !== "message" || e.message?.role !== "assistant") return;
		for (const part of e.message.content ?? [])
			if (part.type === "toolCall") callAt.set(part.id, index);
	});
	return events.flatMap((e, index) => {
		const m = e?.type === "message" ? e.message : null;
		if (m?.role !== "toolResult" || !Array.isArray(m.nestedCalls?.calls))
			return [];
		return m.nestedCalls.calls.map((call) => ({
			name: call?.name,
			status: call?.status ?? null,
			arguments: normalizedArguments(call?.name, call?.arguments),
			scriptAt: index,
			scriptOk: !m.isError,
			calledAt: callAt.get(m.toolCallId) ?? null,
		}));
	});
}

/** Run folders whose launch name a launch argument names. */
function foldersNamed(runFolders, children) {
	const names = new Set(
		(Array.isArray(children) ? children : [])
			.map((child) => child?.name)
			.filter((name) => typeof name === "string"),
	);
	return runFolders.filter((f) => f.name && names.has(f.name));
}

/**
 * What each codemode script launched and joined, by run id, keyed by the entry
 * index of the script's tool result. A launch binds by the run folders whatever its
 * status: a launch that failed partway still started the children before it.
 * @param {Array<{runId: string, name: string | null}>} runFolders
 * @returns {Map<number, {ok: boolean, launched: Set<string>, joined: Set<string>}>}
 */
export function scriptCoverage(events, runFolders = [], launchTool = "subagent") {
	const scripts = new Map();
	const calls = nestedCalls(events);
	for (const call of calls) {
		const script = scripts.get(call.scriptAt) ?? {
			ok: call.scriptOk,
			launched: new Set(),
			joined: new Set(),
		};
		scripts.set(call.scriptAt, script);
		if (call.name === launchTool)
			for (const f of foldersNamed(runFolders, call.arguments.children))
				script.launched.add(f.runId);
	}
	for (const call of calls) {
		if (call.name !== WAIT_TOOL || call.status !== "ok") continue;
		const args = call.arguments;
		if (args.recent === true || args.mode === "any") continue;
		const script = scripts.get(call.scriptAt);
		if (!Array.isArray(args.ids)) {
			for (const id of script.launched) script.joined.add(id);
			continue;
		}
		for (const f of runFolders)
			if (args.ids.includes(f.runId) || (f.name && args.ids.includes(f.name)))
				script.joined.add(f.runId);
	}
	return scripts;
}

/**
 * The workflow gate (G2.1 (b), candidate arm): one successful script launched and
 * joined a run of every declared launch name, and the parent made no direct launch.
 * null for a scenario without a declared workflow.
 * @param {{workflow?: {toolName: string, launches: string[]}, parentLoadTool: string}} scenario
 */
export function workflowScript(events, scenario, runFolders = []) {
	if (!scenario.workflow) return null;
	const directLaunch = events.some(
		(e) =>
			e?.type === "message" &&
			e.message?.role === "assistant" &&
			(e.message.content ?? []).some(
				(part) => part.type === "toolCall" && part.name === scenario.parentLoadTool,
			),
	);
	if (directLaunch) return false;
	const coverage = scriptCoverage(events, runFolders, scenario.parentLoadTool);
	return [...coverage.entries()].some(
		([index, script]) =>
			script.ok &&
			events[index]?.message?.toolName === scenario.workflow.toolName &&
			scenario.workflow.launches.every((name) =>
				runFolders.some(
					(f) =>
						f.name === name &&
						script.launched.has(f.runId) &&
						script.joined.has(f.runId),
				),
			),
	);
}

/**
 * Parent reads of a run's report locator (capped carrier, D12): a read call
 * (direct, or nested in a script) whose path is the report file of a run folder.
 * Only a direct successful read has its result text in the session.
 * @param {Array<{runId: string, report?: string | null}>} runFolders
 * @returns {Array<{runId: string, index: number, ok: boolean, text: string | null, callId: string | null}>}
 */
export function reportReads(events, runFolders = [], workDir = "") {
	const reports = new Map(
		runFolders
			.filter((f) => typeof f.report === "string")
			.map((f) => [resolveReadPath(f.report, workDir), f.runId]),
	);
	if (reports.size === 0) return [];
	const results = new Map();
	events.forEach((e, index) => {
		const m = e?.type === "message" ? e.message : null;
		if (m?.role === "toolResult") results.set(m.toolCallId, { m, index });
	});
	const found = [];
	events.forEach((e, index) => {
		if (e?.type !== "message" || e.message?.role !== "assistant") return;
		for (const part of e.message.content ?? []) {
			if (part.type !== "toolCall" || part.name !== "read") continue;
			const runId = reports.get(resolveReadPath(part.arguments?.path, workDir));
			if (!runId) continue;
			const result = results.get(part.id);
			const ok = Boolean(result) && !result.m.isError;
			found.push({
				runId,
				index: result?.index ?? index,
				ok,
				text: ok ? textOf(result.m.content) : null,
				callId: part.id,
			});
		}
	});
	for (const call of nestedCalls(events)) {
		if (call.name !== "read") continue;
		const runId = reports.get(resolveReadPath(call.arguments.path, workDir));
		if (runId)
			found.push({ runId, index: call.scriptAt, ok: call.status === "ok", text: null, callId: null });
	}
	return found;
}

/**
 * Tool names the parent used, for the allowlist: direct calls and calls nested in
 * scripts. A successful read of a run's report locator is part of receiving that
 * run's result, not a parent tool (D12 capped carrier).
 */
export function parentToolNames(events, runFolders = [], workDir = "") {
	const reads = reportReads(events, runFolders, workDir).filter((r) => r.ok);
	const allowedCalls = new Set(reads.map((r) => r.callId).filter(Boolean));
	const allowedNested = new Set(
		reads.filter((r) => !r.callId).map((r) => r.index),
	);
	const direct = events.flatMap((e) =>
		e?.type === "message" && e.message?.role === "assistant"
			? (e.message.content ?? [])
					.filter((part) => part.type === "toolCall" && !allowedCalls.has(part.id))
					.map((part) => part.name)
			: [],
	);
	const reportPaths = new Set(
		runFolders
			.filter((f) => typeof f.report === "string")
			.map((f) => resolveReadPath(f.report, workDir)),
	);
	const nested = nestedCalls(events)
		.filter(
			(call) =>
				!(
					call.name === "read" &&
					call.status === "ok" &&
					allowedNested.has(call.scriptAt) &&
					reportPaths.has(resolveReadPath(call.arguments.path, workDir))
				),
		)
		.map((call) => call.name);
	return [...direct, ...nested];
}
