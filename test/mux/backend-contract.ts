import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { MuxBackendAdapter } from "../../src/mux/backend.ts";
import { closeSurfaceAsync } from "../../src/mux/io.ts";
import { createSurface, getMuxBackend, readScreen, sendCommand } from "../../src/mux.ts";

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
	/** Env keys of the runtime check. */
	runtimeEnvKeys: readonly string[];
	/**
	 * "each-required" (default): without any one key the backend is unavailable.
	 * "any-suffices": one key alone makes it available; without all of them it is unavailable.
	 */
	runtimeEnvKeysRule?: "each-required" | "any-suffices";
	/** False when the backend has no workspace to rename, so renameWorkspace records nothing. Default true. */
	renamesWorkspace?: boolean;
	/** Titles that the fake recorded from renameCurrentTab and renameWorkspace, in call order. */
	recordedTitles(stateDir: string): string[];
	/**
	 * Required when the adapter has the direct-program ability: the argv that the fake started
	 * as the surface's own process, or undefined when the surface has none.
	 */
	startedProgram?(stateDir: string, surface: string): string[] | undefined;
	/**
	 * Commands that the fake saw SUBMITTED (typed, then Enter) on one surface, in order.
	 * Typed text without Enter must not appear. A bare Enter appears as "".
	 */
	submittedCommands(stateDir: string, surface: string): string[];
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

		if (fixture.runtimeEnvKeysRule === "any-suffices") {
			it("is available with any one of its runtime env keys and unavailable without all of them", () => {
				assert.ok(fixture.runtimeEnvKeys.length > 0);
				const values = new Map(fixture.runtimeEnvKeys.map((key) => [key, process.env[key]]));
				for (const key of fixture.runtimeEnvKeys) setEnv(key, undefined);
				assert.equal(adapter.isAvailable(), false, "available without any runtime env key");
				assert.equal(getMuxBackend(), null);
				for (const key of fixture.runtimeEnvKeys) {
					setEnv(key, values.get(key));
					assert.equal(adapter.isAvailable(), true, `unavailable with only ${key}`);
					setEnv(key, undefined);
				}
			});
		} else {
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
		}

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
			assert.deepEqual(fixture.submittedCommands(stateDir, child), ["echo split-ready"]);
			assert.match(adapter.readScreen(child, SCREEN_LINES), /echo split-ready/);
		});

		it("sends a command that the sync and async screen reads show", async () => {
			const surface = await adapter.createSurface("Contract IO");
			adapter.sendCommand(surface, "echo first-line");
			adapter.sendCommand(surface, "echo last-line");
			assert.deepEqual(fixture.submittedCommands(stateDir, surface), ["echo first-line", "echo last-line"]);
			const screen = adapter.readScreen(surface, SCREEN_LINES);
			assert.match(screen, /echo first-line/);
			assert.match(screen, /echo last-line/);
			assert.match(await adapter.readScreenAsync(surface, SCREEN_LINES), /echo last-line/);
		});

		it("accepts an empty command as Enter only", async () => {
			const surface = await adapter.createSurface("Contract Enter");
			adapter.sendCommand(surface, "echo before-enter");
			const before = fixture.submittedCommands(stateDir, surface);
			assert.deepEqual(before, ["echo before-enter"]);
			adapter.sendCommand(surface, "");
			const after = fixture.submittedCommands(stateDir, surface);
			assert.ok(after.length > before.length, "an empty command submits nothing");
			assert.deepEqual(after.slice(0, before.length), before);
			assert.ok(
				after.slice(before.length).every((line) => line === ""),
				"an empty command must submit Enter only",
			);
		});

		it("submits a command only to its target surface", async () => {
			const target = await adapter.createSurface("Contract Target");
			const other = await adapter.createSurface("Contract Other");
			adapter.sendCommand(target, "echo only-target");
			assert.deepEqual(fixture.submittedCommands(stateDir, target), ["echo only-target"]);
			assert.deepEqual(fixture.submittedCommands(stateDir, other), []);
		});

		it("closes a surface, so that a later read fails", async () => {
			const surface = await adapter.createSurface("Contract Close");
			await adapter.closeSurface(surface);
			assert.throws(() => adapter.readScreen(surface, SCREEN_LINES));
			await assert.rejects(adapter.readScreenAsync(surface, SCREEN_LINES));
		});

		it("renames the current tab and the workspace", () => {
			adapter.renameCurrentTab("Contract Tab");
			adapter.renameWorkspace("Contract Workspace");
			const expected = fixture.renamesWorkspace === false ? ["Contract Tab"] : ["Contract Tab", "Contract Workspace"];
			assert.deepEqual(fixture.recordedTitles(stateDir), expected);
		});

		const openProgramSession = adapter.openProgramSession?.bind(adapter);
		const checkExit = adapter.checkExit?.bind(adapter);

		if (openProgramSession) {
			it("starts a program as the surface's own process, with no typed input", async () => {
				assert.ok(fixture.startedProgram, "a direct-program backend needs startedProgram in its fixture");
				const session = await openProgramSession();
				const surface = await session.start("Contract Program", "echo direct-start");
				const program = fixture.startedProgram(stateDir, surface);
				assert.ok(program, "the surface has no program of its own");
				assert.ok(program.includes("echo direct-start"), `program does not run the command: ${program}`);
				assert.deepEqual(fixture.submittedCommands(stateDir, surface), []);
			});
		}

		if (checkExit) {
			it("reports no exit while the surface runs and an exit after the awaited close", async () => {
				assert.ok(openProgramSession, "the exit check needs the session target of a direct-program start");
				const session = await openProgramSession();
				const surface = await session.start("Contract Exit", "echo exit-check");
				assert.equal(await checkExit(surface, session.target), null);
				await adapter.closeSurface(surface, session.target);
				const exit = await checkExit(surface, session.target);
				assert.ok(exit, "no exit after close");
				assert.ok(Number.isInteger(exit.exitCode));
				assert.ok(exit.reason.length > 0);
			});
		}

		it("is reached through the shared mux functions", async () => {
			const surface = await createSurface("Contract Shared");
			sendCommand(surface, "echo via-shared");
			assert.deepEqual(fixture.submittedCommands(stateDir, surface), ["echo via-shared"]);
			assert.match(adapter.readScreen(surface, SCREEN_LINES), /echo via-shared/);
			assert.match(readScreen(surface, SCREEN_LINES), /echo via-shared/);
			await closeSurfaceAsync(surface);
			assert.throws(() => adapter.readScreen(surface, SCREEN_LINES));
		});
	});
}
