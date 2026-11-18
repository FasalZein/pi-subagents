import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "launch", "run-child.mjs");

/**
 * A child program that records, for each name, only whether it is set ("yes"/"no")
 * and, for each expected pair, whether the value is equal ("yes"/"no"). It never
 * records a value, so no test output carries an environment (T44).
 */
export function presenceProbeCommand(
	outFile: string,
	names: readonly string[],
	expected: Record<string, string> = {},
): { command: string; args: string[] } {
	const script = [
		"const [out, names, expected] = process.argv.slice(1);",
		"const flags = {};",
		"for (const n of JSON.parse(names)) flags[n] = typeof process.env[n] === 'string' ? 'yes' : 'no';",
		"for (const [n, v] of Object.entries(JSON.parse(expected))) flags['equal:' + n] = process.env[n] === v ? 'yes' : 'no';",
		"require('node:fs').writeFileSync(out, JSON.stringify(flags));",
	].join("\n");
	return { command: process.execPath, args: ["-e", script, outFile, JSON.stringify(names), JSON.stringify(expected)] };
}

export interface LauncherRun {
	status: number | null;
	stderr: string;
	/** Presence flags written by the probe; undefined when the child did not start. */
	flags?: Record<string, "yes" | "no">;
}

/** Run the launcher on a capsule inside a synthetic surface env (the pane or daemon env). */
export function runLauncherInSurface(capsulePath: string, surfaceEnv: Record<string, string>, outFile: string): LauncherRun {
	const result = spawnSync(process.execPath, [LAUNCHER_PATH, capsulePath], {
		env: { PATH: process.env.PATH ?? "/usr/bin", ...surfaceEnv },
		encoding: "utf8",
		timeout: 30_000,
	});
	const flags = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : undefined;
	return { status: result.status, stderr: result.stderr, flags };
}

export function makeProbeDir(): { dir: string; outFile: string; dispose: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagent-presence-"));
	return { dir, outFile: join(dir, "flags.json"), dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
