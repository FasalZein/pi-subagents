import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach } from "node:test";

export const TRACKED_ENV_KEYS = [
	"CMUX_SOCKET_PATH",
	"CMUX_SURFACE_ID",
	"DEEPSEEK_API_KEY",
	"FAKE_CMUX_LOG",
	"FAKE_CMUX_SCREEN",
	"HC_SCOPE",
	"HC_TERMINAL_ID",
	"HC_TERMINAL_SOCKET",
	"FAKE_HERDR_LOG",
	"FAKE_HERDR_MODE",
	"FAKE_HERDR_SCREEN",
	"FAKE_TMUX_GEOMETRY",
	"FAKE_TMUX_LOG",
	"FAKE_WEZTERM_LOG",
	"FAKE_WEZTERM_SCREEN",
	"FAKE_ZELLIJ_LOG",
	"FAKE_ZELLIJ_PANE_ID",
	"FAKE_ZELLIJ_SCREEN",
	"HERDR_ENV",
	"HERDR_PANE_ID",
	"HERDR_TAB_ID",
	"HERDR_WORKSPACE_ID",
	"PATH",
	"PI_ARTIFACT_PROJECT_ROOT",
	"PI_CODING_AGENT_DIR",
	"PI_PACKAGE_DIR",
	"PI_SUBAGENT_MUX",
	"PI_SUBAGENT_AGENT",
	"PI_SUBAGENT_NAME",
	"PI_SUBAGENT_SPAWN_BUDGET",
	"PI_SUBAGENT_SPAWN_DEPTH",
	"PI_SUBAGENT_SPAWN_WIDTH",
	"PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE",
	"PI_SUBAGENT_SPAWNABLE",
	"PI_SUBAGENT_HERDR_MIN_COLUMNS",
	"PI_SUBAGENT_HERDR_MIN_ROWS",
	"PI_SUBAGENT_HERDR_PLACEMENT",
	"PI_SUBAGENT_LLM_VERIFIER_CANDIDATES",
	"PI_SUBAGENT_LLM_VERIFIER_VENV",
	"PI_SUBAGENT_PI_COMMAND",
	"PI_SUBAGENT_SUPERVISOR_RUNTIME",
	"PI_SUBAGENT_VF_MOCK_VERIFIER",
	"PI_SUBAGENT_VF_RUN_DIR",
	"PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN",
	"PI_SUBAGENT_RENAME_TMUX_SESSION",
	"PI_SUBAGENT_RENAME_TMUX_WINDOW",
	"PI_SUBAGENT_ZELLIJ_MIN_COLUMNS",
	"PI_SUBAGENT_ZELLIJ_MIN_ROWS",
	"PI_SUBAGENT_ZELLIJ_PLACEMENT",
	"REX_BIN_DIR",
	"REX_BLOCK",
	"REX_SESSION",
	"SHELL",
	"TMUX",
	"TMUX_PANE",
	"WEZTERM_PANE",
	"WEZTERM_UNIX_SOCKET",
	"ZELLIJ",
	"ZELLIJ_PANE_ID",
	"ZELLIJ_SESSION_NAME",
] as const;

// A test run started from inside a Pi child inherits that child's PI_SUBAGENT_*
// and PI_DENY_TOOLS values (agent, spawn grants, session), and the code under test
// would then treat the test process as that child. Drop them once, before the
// snapshot that restoreTrackedEnv() returns to. Live-test settings (PI_SUBAGENT_LIVE_*) stay.
export function dropInheritedSubagentEnv(env: NodeJS.ProcessEnv): void {
	for (const key of Object.keys(env)) {
		if ((key.startsWith("PI_SUBAGENT_") && !key.startsWith("PI_SUBAGENT_LIVE_")) || key === "PI_DENY_TOOLS") delete env[key];
	}
}
dropInheritedSubagentEnv(process.env);

// Launch and resume reserve run folders under the artifact storage root, which defaults to the home
// folder (~/.pi/history), and a Pi child exports that default to its tests. Point it at one temporary
// folder before the snapshot, so restoreTrackedEnv() returns to it and no test writes under ~/.pi.
const testArtifactRoot = mkdtempSync(join(tmpdir(), "pi-test-artifacts-"));
process.env.PI_ARTIFACT_PROJECT_ROOT = testArtifactRoot;
process.once("exit", () => rmSync(testArtifactRoot, { recursive: true, force: true }));

export const ORIGINAL_ENV = Object.fromEntries(TRACKED_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
	(typeof TRACKED_ENV_KEYS)[number],
	string | undefined
>;

export const ISOLATED_SUBAGENT_ENV_KEYS = [
	"PI_DENY_TOOLS",
	"PI_SUBAGENT_AUTO_EXIT",
	"PI_SUBAGENT_PARENT_SESSION",
	"PI_SUBAGENT_NAME",
	"PI_SUBAGENT_SESSION",
	"PI_SUBAGENT_SURFACE",
] as const;

export function clearIsolatedSubagentEnv(): void {
	for (const key of ISOLATED_SUBAGENT_ENV_KEYS) delete process.env[key];
}

export function restoreTrackedEnv(): void {
	for (const key of TRACKED_ENV_KEYS) {
		const value = ORIGINAL_ENV[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

beforeEach(() => {
	clearIsolatedSubagentEnv();
});

/**
 * Call inside a describe whose tests provision the managed verifier venv:
 * sets UV_NO_CONFIG=1 so the uv calls of ensureVerifierRuntime() ignore the
 * user's uv.toml. Why: a user uv config can require hashes, and the managed
 * install of llm-verifier has no hash lock, so uv refuses it.
 * Limit: a real verified fan-out launch under require-hashes still fails;
 * revisit (hash-lock the install) if the owner starts using llm-verifier.
 */
export function ignoreUserUvConfig(): void {
	const saved = process.env.UV_NO_CONFIG;
	before(() => {
		process.env.UV_NO_CONFIG = "1";
	});
	after(() => {
		if (saved === undefined) delete process.env.UV_NO_CONFIG;
		else process.env.UV_NO_CONFIG = saved;
	});
}

afterEach(() => {
	restoreTrackedEnv();
});
