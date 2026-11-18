/**
 * Isolated temporary home of one sample attempt: Pi agent dir, session dir and
 * a fresh copy of the scenario workspace. Nothing of the owner's Pi config is
 * read except the login files that authentication needs.
 */
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { canonicalJson, sha256 } from "./record.mjs";

/** The only files taken from the owner's Pi agent dir: the login and the provider list. */
export const AUTH_FILES = Object.freeze(["auth.json", "models.json"]);

/**
 * Pi settings of every sample. Pi's own retry is off so that the harness makes
 * and counts the one retry on a provider error. Generated, never copied.
 */
export const SAMPLE_SETTINGS = Object.freeze({
	retry: { enabled: false },
	packages: [],
	extensions: [],
});

export function settingsHash(settings) {
	return sha256(canonicalJson(settings));
}

function listFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listFiles(path));
		else if (entry.isFile()) files.push(path);
	}
	return files;
}

/** Hash of every file below the given roots, by relative path and content. */
export function hashFiles(roots, base) {
	const entries = roots
		.flatMap((root) =>
			statSync(root).isDirectory() ? listFiles(root) : [root],
		)
		.map((path) => [relative(base, path), sha256(readFileSync(path))])
		.sort((a, b) => a[0].localeCompare(b[0]));
	return sha256(canonicalJson(entries));
}

function sourceAgentDir() {
	return join(homedir(), ".pi", "agent");
}

/**
 * Refuse an OAuth login that could expire during the run: a refresh in the
 * temporary copy could rotate the token and leave the owner's login stale.
 */
export function checkLoginLifetime(provider, minimumMs) {
	const authPath = join(sourceAgentDir(), "auth.json");
	if (!existsSync(authPath)) throw new Error("no Pi login file found");
	const entry = JSON.parse(readFileSync(authPath, "utf8"))[provider];
	if (!entry)
		throw new Error(`the Pi login file has no entry for provider ${provider}`);
	if (
		typeof entry.expires === "number" &&
		entry.expires < Date.now() + minimumMs
	) {
		throw new Error(
			`the ${provider} login expires within ${Math.round(minimumMs / 60000)} minutes; log in with Pi first`,
		);
	}
}

/**
 * @param {{scenario: {dir: string, agentsDir: string, workspaceDir: string}, model: string, thinking: string,
 *   probePath: string}} input
 */
export function prepareSampleHome({ scenario, model, thinking, probePath }) {
	const root = mkdtempSync(join(tmpdir(), "pi-orch-bench-"));
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	const sessionDir = join(root, "sessions");
	const workDir = join(root, "workspace");
	const probeDir = join(root, "probe");
	const artifactsDir = join(root, "artifacts");
	for (const dir of [
		agentDir,
		sessionDir,
		probeDir,
		artifactsDir,
		join(agentDir, "agents"),
		join(agentDir, "extensions"),
	]) {
		mkdirSync(dir, { recursive: true });
	}
	for (const name of AUTH_FILES) {
		const source = join(sourceAgentDir(), name);
		if (existsSync(source)) copyFileSync(source, join(agentDir, name));
	}
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify(SAMPLE_SETTINGS, null, 2)}\n`,
	);
	cpSync(scenario.workspaceDir, workDir, { recursive: true });
	for (const name of readdirSync(scenario.agentsDir)) {
		const text = readFileSync(join(scenario.agentsDir, name), "utf8")
			.replaceAll("{{MODEL}}", model)
			.replaceAll("{{THINKING}}", thinking);
		writeFileSync(join(agentDir, "agents", name), text);
	}
	// Discovered by every child; the parent gets it with -e.
	copyFileSync(probePath, join(agentDir, "extensions", "bench-load-probe.ts"));
	return { root, home, agentDir, sessionDir, workDir, probeDir, artifactsDir };
}
