import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

// Pi's loader aliases pi-ai, pi-tui, pi-agent-core, pi-coding-agent and typebox to single files, so a subpath
// import of an aliased package fails only under Pi's loader, not under node --test.
// scripts/managed-install-load.mjs covers the same load after a real managed install.
describe("extension entry under Pi's extension loader", () => {
	it("loads src/index.ts with Pi's aliases", () => {
		const home = mkdtempSync(join(tmpdir(), "pi-loader-load-"));
		try {
			// A clean env: no inherited Pi or test-runner state.
			const run = spawnSync(process.execPath, ["scripts/pi-extension-load.mjs", join(REPO, "src/index.ts"), home], {
				cwd: REPO,
				encoding: "utf8",
				timeout: 60_000,
				env: { PATH: process.env.PATH ?? "", HOME: home },
			});
			assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
			assert.match(run.stdout, /extensions loaded: 1/);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
