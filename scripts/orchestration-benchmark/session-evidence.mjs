/**
 * Reads the evidence of one attempt: every session file below the attempt root
 * (a child may keep its sessions in another config folder) and the load probes.
 * Malformed lines are counted, never dropped silently.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const LAUNCH_METADATA = "pi-subagents_launch_metadata";

/**
 * Entries of a folder of the live sample tree, or none when the folder vanished
 * between listing and reading (Pi and the candidate remove temporary folders while
 * the observer polls: the T59a smoke ended on such an ENOENT).
 */
export function liveEntries(dir) {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
}

function listFiles(dir, suffix) {
	if (!existsSync(dir)) return [];
	const files = [];
	for (const entry of liveEntries(dir)) {
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
 * (files with a launch marker), unattributed files that hold usage, and
 * others: every remaining file, also an empty or header-only one, so that the
 * probe join sees every session file.
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
		others: sessions
			.filter((session) => session !== parent && !children.includes(session))
			.map((session) => session.file),
		parentProbes: parentProbes.length,
	};
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Run folders the candidate writes (results/<runId>/ with launch.json at launch and
 * record.json at the end): run id and launch name. The name comes from record.json,
 * else from the launch metadata of the session file that launch.json names.
 * v2.9.2 writes no run folder, so its list is empty.
 * @param {Array<{file: string, events: object[]}>} sessions
 * @returns {Array<{runId: string, name: string | null}>}
 */
export function readRunFolders(root, sessions) {
	const folders = new Set(
		[...listFiles(root, "/launch.json"), ...listFiles(root, "/record.json")]
			.map((file) => dirname(file))
			.filter((dir) => basename(dirname(dir)) === "results"),
	);
	return [...folders].sort().map((dir) => {
		const record = readJson(join(dir, "record.json"));
		const launch = readJson(join(dir, "launch.json"));
		const session = sessions.find(
			(s) => typeof launch?.sessionFile === "string" && sameFile(s.file, launch.sessionFile),
		);
		const marker = session?.events.find(
			(e) => e?.type === "custom" && e.customType === LAUNCH_METADATA,
		);
		const name = record?.name ?? marker?.data?.name ?? null;
		const report = record?.report?.saved ? record.report.path : null;
		return {
			runId: basename(dir),
			name: typeof name === "string" ? name : null,
			report: typeof report === "string" ? report : null,
		};
	});
}

/**
 * T72: session files whose published record (results/<runId>/record.json) has the outcome blocked,
 * the durable evidence of a caller_ping end: an autonomous ping ends at a tool-use stop and writes
 * no session entry. Paths are the session list's own, so a caller compares them directly.
 * @param {Array<{file: string, events: object[]}>} sessions
 * @returns {Set<string>}
 */
export function readBlockedSessions(root, sessions) {
	const blocked = new Set();
	for (const file of listFiles(root, "/record.json")) {
		const dir = dirname(file);
		if (basename(dirname(dir)) !== "results") continue;
		if (readJson(file)?.outcome !== "blocked") continue;
		const launch = readJson(join(dir, "launch.json"));
		const session = sessions.find(
			(s) => typeof launch?.sessionFile === "string" && sameFile(s.file, launch.sessionFile),
		);
		if (session) blocked.add(session.file);
	}
	return blocked;
}

function sameFile(a, b) {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return a === b;
	}
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
	return {
		...classifySessions(sessions, probes),
		probes,
		malformed,
		runFolders: readRunFolders(root, sessions),
		blockedSessions: readBlockedSessions(root, sessions),
	};
}
