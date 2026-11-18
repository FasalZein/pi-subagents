/**
 * Isolated temporary home of one sample attempt, under a private base folder that
 * only this tool writes. An attempt root is registered (owner file) before any
 * credential is copied in, so every root can be found and removed later.
 */
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { canonicalJson, sha256 } from "./record.mjs";
import { BenchError } from "./run-state.mjs";

const OWNER_FILE = "bench-owner.json";
const OWNER_TAG = "pi-orchestration-benchmark";

/** Private base folder of all attempt roots. */
export function benchBase() {
	const base = join(realpathSync(tmpdir()), "pi-orch-bench");
	mkdirSync(base, { recursive: true, mode: 0o700 });
	const stat = lstatSync(base);
	if (!stat.isDirectory() || stat.uid !== process.getuid())
		throw new BenchError("benchmark temp base is not owned by this user");
	chmodSync(base, 0o700);
	return base;
}

/**
 * Pi settings of every sample. Pi's own retry is off so that the harness makes
 * and counts the one retry on a provider error. Generated, never copied.
 */
export const SAMPLE_SETTINGS = Object.freeze({
	retry: { enabled: false },
	packages: [],
	extensions: [],
});

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

function ownerAgentDir() {
	return join(homedir(), ".pi", "agent");
}

function readJsonIfExists(path) {
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

/**
 * The login of one provider, with its refresh token blanked: Pi refreshes only an
 * expired token, and a blank refresh fails instead of rotating the owner's login.
 * Pi validates that `refresh` is a string, so it stays as an empty string.
 */
export function selectProviderAuth(auth, provider, now, minimumMs) {
	const entry = auth[provider];
	if (!entry)
		throw new BenchError(
			`the Pi login file has no entry for provider ${provider}`,
		);
	if (entry.type === "oauth") {
		if (typeof entry.expires !== "number" || entry.expires < now + minimumMs) {
			throw new BenchError(
				`the ${provider} login expires within ${Math.round(minimumMs / 60000)} minutes; log in with Pi first`,
			);
		}
		return { [provider]: { ...entry, refresh: "" } };
	}
	return { [provider]: entry };
}

/** models.json reduced to the selected provider; other providers never enter a sample. */
export function selectProviderModels(models, provider) {
	const entry = models?.providers?.[provider];
	return entry ? { providers: { [provider]: entry } } : { providers: {} };
}

const SECRET_FIELD = /key|token|secret|authorization|header/i;

/** Fingerprint of non-secret provider settings: secret-named fields are left out. */
export function settingsFingerprint(value) {
	if (Array.isArray(value)) return value.map(settingsFingerprint);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([name]) => !SECRET_FIELD.test(name))
				.map(([name, inner]) => [name, settingsFingerprint(inner)]),
		);
	}
	return value;
}

/** The selected provider's models.json entry, as the sample will see it. */
export function readProviderModels(provider) {
	return selectProviderModels(
		readJsonIfExists(join(ownerAgentDir(), "models.json")),
		provider,
	);
}

function processStart(pid) {
	try {
		return (
			execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
				encoding: "utf8",
			}).trim() || null
		);
	} catch {
		return null;
	}
}

/** Identity of a live process: pid plus start time, so a reused pid does not match. */
export function processIdentity(pid = process.pid) {
	return { pid, start: processStart(pid) };
}

export function identityAlive(identity) {
	return (
		Boolean(identity?.start) && processStart(identity.pid) === identity.start
	);
}

/**
 * Register a new attempt root. Nothing secret is in it yet.
 * @param {string} [base] private base folder; tests pass their own.
 */
export function createAttemptRoot(base = benchBase()) {
	const root = mkdtempSync(join(base, "a-"));
	writeFileSync(
		join(root, OWNER_FILE),
		JSON.stringify({ tag: OWNER_TAG, owner: processIdentity() }),
		{ mode: 0o600 },
	);
	return root;
}

export function socketPath(root) {
	return join(root, "tmux.sock");
}

/**
 * Remove abandoned attempt roots: direct children of the private base whose owner
 * file carries this tool's tag and names a process that is gone. Targets come
 * from the base folder, never from data outside it.
 * @param {(socket: string) => void} stopServer
 * @param {string} [base] private base folder; tests pass their own.
 */
export function recoverAbandonedRoots(stopServer, base = benchBase()) {
	const removed = [];
	for (const name of readdirSync(base)) {
		const root = join(base, name);
		const stat = lstatSync(root);
		if (
			!stat.isDirectory() ||
			stat.uid !== process.getuid() ||
			dirname(root) !== base
		)
			continue;
		let owner;
		try {
			owner = JSON.parse(readFileSync(join(root, OWNER_FILE), "utf8"));
		} catch {
			continue;
		}
		if (owner?.tag !== OWNER_TAG || identityAlive(owner.owner)) continue;
		stopServer(socketPath(root));
		rmSync(root, { recursive: true, force: true });
		removed.push(name);
	}
	return removed;
}

/**
 * Fill a registered attempt root.
 * @param {string} root
 * @param {{scenario: {agentsDir: string, workspaceDir: string}, model: string, thinking: string,
 *   probePath: string, provider: string, loginMarginMs: number}} input
 */
export function prepareSampleHome(
	root,
	{ scenario, model, thinking, probePath, provider, loginMarginMs },
) {
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	const paths = {
		root,
		home,
		agentDir,
		sessionDir: join(root, "sessions"),
		workDir: join(root, "workspace"),
		probeDir: join(root, "probe"),
		artifactsDir: join(root, "artifacts"),
		tmpDir: join(root, "tmp"),
	};
	for (const dir of [
		agentDir,
		paths.sessionDir,
		paths.probeDir,
		paths.artifactsDir,
		paths.tmpDir,
	]) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify(SAMPLE_SETTINGS, null, 2)}\n`,
	);
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(readProviderModels(provider)),
		{ mode: 0o600 },
	);
	const auth = readJsonIfExists(join(ownerAgentDir(), "auth.json"));
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify(
			selectProviderAuth(auth, provider, Date.now(), loginMarginMs),
		),
		{
			mode: 0o600,
		},
	);
	cpSync(scenario.workspaceDir, paths.workDir, { recursive: true });
	for (const name of readdirSync(scenario.agentsDir)) {
		const text = readFileSync(join(scenario.agentsDir, name), "utf8")
			.replaceAll("{{MODEL}}", model)
			.replaceAll("{{THINKING}}", thinking);
		writeFileSync(join(agentDir, "agents", name), text);
	}
	// Discovered by every child; the parent gets it with -e.
	cpSync(probePath, join(agentDir, "extensions", "bench-load-probe.ts"));
	return paths;
}
