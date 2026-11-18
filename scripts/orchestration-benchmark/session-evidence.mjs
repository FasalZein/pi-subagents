/**
 * Reads the evidence of one attempt: every session file below the attempt root
 * (a child may keep its sessions in another config folder) and the load probes.
 * Malformed lines are counted, never dropped silently.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LAUNCH_METADATA = "pi-subagents_launch_metadata";

function listFiles(dir, suffix) {
	if (!existsSync(dir)) return [];
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listFiles(path, suffix));
		else if (entry.isFile() && path.endsWith(suffix)) files.push(path);
	}
	return files;
}

/** @returns {{events: object[], malformed: number}} */
export function parseJsonlStrict(text) {
	const events = [];
	let malformed = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			malformed += 1;
		}
	}
	return { events, malformed };
}

export function readProbes(probeDir) {
	return listFiles(probeDir, ".json").map((file) =>
		JSON.parse(readFileSync(file, "utf8")),
	);
}

function hasLaunchMarker(events) {
	return events.some(
		(e) => e?.type === "custom" && e.customType === LAUNCH_METADATA,
	);
}

function hasUsage(events) {
	return events.some(
		(e) =>
			(e?.type === "message" &&
				(e.message?.role === "assistant" || e.message?.usage)) ||
			e?.usage,
	);
}

/**
 * Sort session files into the parent (named by the parent's probe), children
 * (files with a launch marker) and unattributed files that hold usage.
 * @param {Array<{file: string, events: object[]}>} sessions
 * @param {Array<{sessionFile: string | null, agent: string | null}>} probes
 */
export function classifySessions(sessions, probes) {
	const parentProbes = probes.filter((probe) => !probe.agent);
	const parentFile =
		parentProbes.length === 1 ? parentProbes[0].sessionFile : null;
	const parent =
		sessions.find((session) => session.file === parentFile) ?? null;
	const children = sessions.filter(
		(session) => session !== parent && hasLaunchMarker(session.events),
	);
	const unattributed = sessions.filter(
		(session) =>
			session !== parent &&
			!children.includes(session) &&
			hasUsage(session.events),
	);
	return {
		parent,
		children,
		unattributed: unattributed.map((session) => session.file),
		parentProbes: parentProbes.length,
	};
}

/** Everything one attempt left below its root. */
export function collectEvidence(root, probeDir) {
	let malformed = 0;
	const sessions = listFiles(root, ".jsonl").map((file) => {
		const parsed = parseJsonlStrict(readFileSync(file, "utf8"));
		malformed += parsed.malformed;
		return { file, events: parsed.events };
	});
	const probes = readProbes(probeDir);
	return { ...classifySessions(sessions, probes), probes, malformed };
}
