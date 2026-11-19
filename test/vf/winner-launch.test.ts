import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadAgentDefaults } from "../../src/agents/definitions.ts";
import { resolveSubagentCwd } from "../../src/launch/runtime-paths.ts";
import { resetSpawnWidthForTest } from "../../src/runtime/spawn-width.ts";
import {
	getLaunchedSubagentResultForTest,
	resetSubagentStateForTest,
	wireSubagentSteerBack,
} from "../../src/runtime/wiring.ts";
import { registerSubagentCoreTools, type SubagentToolRuntime } from "../../src/tools/subagent-tools.ts";
import { verifiedRunFilePaths } from "../../src/vf/run/types.ts";
import { dropInheritedSubagentEnv } from "../support/env.ts";
import { assert, createTestDir, ORIGINAL_ENV } from "../support/index.ts";
import { gitRun as run, setupVerifiedRunFixture } from "../support/verified-runs.ts";

/**
 * D22 with D14 and D18: a waited verified launch whose agent ignores the call's model settings says
 * so inside the bounded result text, as every other launch does.
 */

const dirs: string[] = [];
const ENV_KEYS = ["PI_SUBAGENT_PI_COMMAND", "PI_SUBAGENT_VF_MOCK_VERIFIER", "TEST_CAPTURE_DIR", "TEST_MARKER_MAP"];

afterEach(() => {
	resetSubagentStateForTest();
	resetSpawnWidthForTest();
	for (const key of ENV_KEYS) delete process.env[key];
	// Back to test support's temporary root: deleting it would send later suites to ~/.pi/history.
	process.env.PI_ARTIFACT_PROJECT_ROOT = ORIGINAL_ENV.PI_ARTIFACT_PROJECT_ROOT;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Starts one waited verified fan-out launch of an agent that ignores the call's thinking setting. */
async function launchWaitedVerifiedRun(): Promise<{ text: string; artifactRoot: string }> {
	const { repo, parent, fakePi, captureDir } = setupVerifiedRunFixture();
	dirs.push(parent);
	mkdirSync(join(repo, ".pi", "agents", "verifiers"), { recursive: true });
	writeFileSync(
		join(repo, ".pi", "agents", "vf-worker.md"),
		"---\ndescription: vf test agent\nllm-as-a-verifier: true\nallow-model-override: false\n---\nAgent body.\n",
	);
	// The verifier profile names a placeholder; the mock verifier backend never calls it.
	writeFileSync(
		join(repo, ".pi", "agents", "verifiers", "default.md"),
		"---\nmodel: placeholder/verifier\nenv: |\n  OPENAI_BASE_URL=http://127.0.0.1:9\n---\n",
	);
	run(repo, "add", "-A");
	run(repo, "commit", "-q", "-m", "agent definition");
	const artifactRoot = createTestDir();
	dirs.push(artifactRoot);
	process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
	process.env.PI_SUBAGENT_PI_COMMAND = fakePi;
	process.env.PI_SUBAGENT_VF_MOCK_VERIFIER = JSON.stringify({ goodMarker: "VF-GOOD", midMarker: "VF-MID" });
	process.env.TEST_CAPTURE_DIR = captureDir;
	process.env.TEST_MARKER_MAP = JSON.stringify({ "1": "VF-GOOD", "2": "VF-MID", "3": "" });
	const ctx = {
		// The parent's real working directory, as Pi reports it, so the report locator is relative.
		cwd: realpathSync(repo),
		hasUI: false,
		sessionManager: {
			getSessionFile: () => join(parent, "parent-session.jsonl"),
			getSessionId: () => "parent-session",
			getLeafId: () => null,
		},
	};
	const tools = new Map<string, any>();
	const pi = {
		registerTool: (def: any) => tools.set(def.name, def),
		getThinkingLevel: () => "low",
		sendMessage() {},
	};
	const runtime = {
		loadAgentDefaults: (agent: string, cwd: string) => loadAgentDefaults(agent, undefined, cwd, resolveSubagentCwd),
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		startWidgetRefresh: () => {},
		getLaunchedSubagentResult: getLaunchedSubagentResultForTest,
		wireSubagentSteerBack,
	} as unknown as SubagentToolRuntime;
	registerSubagentCoreTools(pi as never, () => true, runtime);
	const params = {
		children: [{ name: "vf-run", title: "VF run", task: "do it", agent: "vf-worker", thinking: "high", async: false }],
	};
	const result = await tools.get("subagent").execute("c1", params, undefined, undefined, ctx);
	return { text: (result.content[0] as { text: string }).text, artifactRoot };
}

describe("verified fan-out launch reply", () => {
	it("keeps the ignored-override warning in a waited launch's capped text", async () => {
		const { text } = await launchWaitedVerifiedRun();
		assert.match(text, /verifier: winner/, "the waited reply carries the winner");
		assert.match(
			text,
			/warning: agent 'vf-worker' sets allow-model-override: false; thinking 'high' from the call ignored/,
		);
		assert.match(text, /verifier: winner (staged|not applied)/, "the winner fact stays beside the warning");
	});

	it("keeps a name that PI_SUBAGENT_ENV_DENY protects out of the manifest after the root-session reset", async () => {
		// The reset runs on the shared test process: restore every variable afterwards, and keep the
		// test-owned capsule folder (test/support/capsule-root.ts) during the launch.
		const saved = { ...process.env };
		// The parent shell as a Pi child exports it: a deny list and the value that it protects.
		process.env.PI_SUBAGENT_ENV_DENY = "B1_DENIED_MARKER";
		process.env.B1_DENIED_MARKER = "denied";
		process.env.B1_ALLOWED_MARKER = "allowed";
		try {
			dropInheritedSubagentEnv(process.env);
			process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = saved.PI_SUBAGENT_ENV_CAPSULE_DIR;
			const { artifactRoot } = await launchWaitedVerifiedRun();
			const manifestName = basename(verifiedRunFilePaths(artifactRoot).manifest);
			const manifests = readdirSync(artifactRoot, { recursive: true })
				.map(String)
				.filter((path) => basename(path) === manifestName);
			assert.equal(manifests.length, 1, "one verified run manifest");
			const manifest = JSON.parse(readFileSync(join(artifactRoot, manifests[0]), "utf8"));
			const env = manifest.request.env as Record<string, string>;
			assert.deepEqual(
				{ denied: "B1_DENIED_MARKER" in env, allowed: "B1_ALLOWED_MARKER" in env },
				{ denied: false, allowed: true },
			);
		} finally {
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
			Object.assign(process.env, saved);
		}
	});
});
