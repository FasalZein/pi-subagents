import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { waitForVerifiedRunResult } from "../../src/vf/run/client.ts";
import { verifiedRunsBaseDir } from "../../src/vf/run/launch.ts";
import { assert, createTestDir, existsSync } from "../support/index.ts";
import { buildSupervisedRun, setupVerifiedRunFixture } from "../support/verified-runs.ts";

// Review b2 g12 P1: a verified fan-out test starts the real supervisor, and the supervisor resolves
// the verifier runtime from the operator's Pi config unless PI_SUBAGENT_LLM_VERIFIER_VENV names
// another root. A cold or stale run there removes an unmarked venv before it installs. The test
// support gives every test process one test-owned verifier root, so the operator's stays untouched.

const dirs: string[] = [];

describe("verified fan-out tests and the operator's verifier runtime", () => {
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("a supervised run leaves an unmarked verifier folder in the Pi config untouched", async () => {
		// A disposable stand-in for the operator's Pi config, with an unmarked verifier venv.
		const operatorConfig = createTestDir();
		dirs.push(operatorConfig);
		const sentinel = join(operatorConfig, "llm-verifier-venv", "venv", "sentinel");
		mkdirSync(join(sentinel, ".."), { recursive: true });
		writeFileSync(sentinel, "operator-owned\n");
		process.env.PI_CODING_AGENT_DIR = operatorConfig;

		const { repo, fakePi, captureDir, parent } = setupVerifiedRunFixture();
		dirs.push(parent);
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [{ marker: "VF-GOOD", change: "good change" }], {
			baseDir: verifiedRunsBaseDir(repo),
		});
		// Any end will do: the check is what the run did to the operator's folder on the way.
		await waitForVerifiedRunResult(runDir, { timeoutMs: 300_000 });
		assert.ok(existsSync(sentinel), "the operator's verifier folder survives the test");
	});
});
