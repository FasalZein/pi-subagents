import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { MuxBackendAdapter } from "../../src/mux/backend.ts";
import { closeSurface, createSurface, getMuxBackend, readScreen, sendCommand } from "../../src/mux.ts";

/**
 * One backend plus its fake CLI. The contract suite knows nothing about the
 * backend beyond this shape, so every backend (tmux, cmux, wezterm, zellij,
 * herdr, herdr-core, Rex) can reuse it.
 */
export interface MuxBackendContractFixture {
	adapter: MuxBackendAdapter;
	/**
	 * Writes the fake CLI into binDir. The fake keeps its surfaces in stateDir.
	 * Returns the env that makes the backend available, enables both renames,
	 * and points the fake at stateDir.
	 */
	installFake(binDir: string, stateDir: string): Record<string, string>;
	/** Env keys of the runtime check: without any one of them the backend is unavailable. */
	runtimeEnvKeys: readonly string[];
	/** Titles that the fake recorded from renameCurrentTab and renameWorkspace, in call order. */
	recordedTitles(stateDir: string): string[];
}

const SCREEN_LINES = 50;

export function runMuxBackendContract(fixture: MuxBackendContractFixture): void {
	const { adapter } = fixture;

	describe(`mux backend contract: ${adapter.id}`, () => {
		let root = "";
		let binDir = "";
		let stateDir = "";
		let savedEnv: Map<string, string | undefined> = new Map();

		function setEnv(key: string, value: string | undefined): void {
			if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}

		beforeEach(() => {
			savedEnv = new Map();
			root = mkdtempSync(join(tmpdir(), `mux-contract-${adapter.id}-`));
			binDir = join(root, "bin");
			stateDir = join(root, "state");
			mkdirSync(binDir);
			mkdirSync(stateDir);
			for (const [key, value] of Object.entries(fixture.installFake(binDir, stateDir))) setEnv(key, value);
			setEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
			setEnv("PI_SUBAGENT_MUX", adapter.id);
		});

		afterEach(() => {
			for (const [key, value] of savedEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		});

		it("is available with its runtime env and its CLI, and the shared detection selects it", () => {
			assert.equal(adapter.isAvailable(), true);
			assert.equal(getMuxBackend(), adapter.id);
		});

		it("is unavailable without any one of its runtime env keys", () => {
			assert.ok(fixture.runtimeEnvKeys.length > 0);
			for (const key of fixture.runtimeEnvKeys) {
				const value = process.env[key];
				setEnv(key, undefined);
				assert.equal(adapter.isAvailable(), false, `available without ${key}`);
				assert.equal(getMuxBackend(), null);
				setEnv(key, value);
			}
		});

		it("is unavailable when its CLI is not on PATH", () => {
			const emptyDir = join(root, "empty-path");
			mkdirSync(emptyDir);
			setEnv("PATH", emptyDir);
			assert.equal(adapter.isAvailable(), false);
		});

		it("gives a setup hint", () => {
			assert.ok(adapter.setupHint().trim().length > 0);
		});

		it("opens surfaces with distinct ids", async () => {
			const first = await adapter.createSurface("Contract One");
			const second = await adapter.createSurface("Contract Two");
			assert.ok(first.length > 0);
			assert.ok(second.length > 0);
			assert.notEqual(first, second);
		});

		it("splits a new surface from an existing one", async () => {
			const parent = await adapter.createSurface("Contract Parent");
			const child = adapter.createSplit("Contract Split", "right", parent);
			assert.ok(child.length > 0);
			assert.notEqual(child, parent);
			adapter.sendCommand(child, "echo split-ready");
			assert.match(adapter.readScreen(child, SCREEN_LINES), /echo split-ready/);
		});

		it("sends a command that the sync and async screen reads show", async () => {
			const surface = await adapter.createSurface("Contract IO");
			adapter.sendCommand(surface, "echo first-line");
			adapter.sendCommand(surface, "echo last-line");
			const screen = adapter.readScreen(surface, SCREEN_LINES);
			assert.match(screen, /echo first-line/);
			assert.match(screen, /echo last-line/);
			assert.match(await adapter.readScreenAsync(surface, SCREEN_LINES), /echo last-line/);
		});

		it("accepts an empty command as Enter only", async () => {
			const surface = await adapter.createSurface("Contract Enter");
			adapter.sendCommand(surface, "echo before-enter");
			adapter.sendCommand(surface, "");
			assert.match(adapter.readScreen(surface, SCREEN_LINES), /echo before-enter/);
		});

		it("closes a surface, so that a later read fails", async () => {
			const surface = await adapter.createSurface("Contract Close");
			adapter.closeSurface(surface);
			assert.throws(() => adapter.readScreen(surface, SCREEN_LINES));
			await assert.rejects(adapter.readScreenAsync(surface, SCREEN_LINES));
		});

		it("renames the current tab and the workspace", () => {
			adapter.renameCurrentTab("Contract Tab");
			adapter.renameWorkspace("Contract Workspace");
			assert.deepEqual(fixture.recordedTitles(stateDir), ["Contract Tab", "Contract Workspace"]);
		});

		it("is reached through the shared mux functions", async () => {
			const surface = await createSurface("Contract Shared");
			sendCommand(surface, "echo via-shared");
			assert.match(adapter.readScreen(surface, SCREEN_LINES), /echo via-shared/);
			assert.match(readScreen(surface, SCREEN_LINES), /echo via-shared/);
			closeSurface(surface);
			assert.throws(() => adapter.readScreen(surface, SCREEN_LINES));
		});
	});
}
