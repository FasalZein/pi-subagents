import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { WorkReporter, WorkReporterSession } from "../runtime/work-reporting.ts";
import type { MuxBackendAdapter } from "./backend.ts";
import { cmuxBackend } from "./cmux.ts";
import { herdrBackend } from "./herdr-backend.ts";
import { herdrCoreBackend } from "./herdr-core.ts";
import { rexBackend } from "./rex.ts";
import { tmuxBackend } from "./tmux.ts";
import { weztermBackend } from "./wezterm.ts";
import { zellijBackend } from "./zellij.ts";

export const execFileAsync = promisify(execFile);

export type MuxBackend = "cmux" | "tmux" | "zellij" | "wezterm" | "herdr" | "herdr-core" | "rex";

/** Every backend, in detection order without a forced backend (spec D29). */
const DETECTION_ORDER: readonly MuxBackend[] = ["herdr-core", "rex", "herdr", "cmux", "tmux", "zellij", "wezterm"];

function muxPreference(): MuxBackend | null {
	const pref = (process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
	return DETECTION_ORDER.find((backend) => backend === pref) ?? null;
}

export function isCmuxAvailable(): boolean {
	return cmuxBackend.isAvailable();
}

export function isTmuxAvailable(): boolean {
	return tmuxBackend.isAvailable();
}

export function isZellijAvailable(): boolean {
	return zellijBackend.isAvailable();
}

export function isHerdrAvailable(): boolean {
	return herdrBackend.isAvailable();
}

// The result of the latest detection, so the index can state pane flags
// without a probe of its own at prompt start (D06). Undefined until a launch,
// resume or other caller has detected once in this process.
let lastDetectedBackend: MuxBackend | null | undefined;

/** PI_SUBAGENT_MUX forces a backend, also when markers of several backends are present (spec D29). */
export function getMuxBackend(): MuxBackend | null {
	const pref = muxPreference();
	lastDetectedBackend = pref
		? muxBackendAdapter(pref).isAvailable()
			? pref
			: null
		: (DETECTION_ORDER.find((backend) => muxBackendAdapter(backend).isAvailable()) ?? null);
	return lastDetectedBackend;
}

/** Whether the latest detection found a backend; "unknown" before the first one. Runs no probe. */
export function lastMuxDetection(): boolean | "unknown" {
	return lastDetectedBackend === undefined ? "unknown" : lastDetectedBackend !== null;
}

export function forgetMuxDetectionForTest(): void {
	lastDetectedBackend = undefined;
}

/**
 * The adapter of a backend.
 * A switch, not a module-level map: the adapter modules import this one, so a map would read them before they exist.
 */
export function muxBackendAdapter(backend: MuxBackend): MuxBackendAdapter {
	switch (backend) {
		case "cmux":
			return cmuxBackend;
		case "tmux":
			return tmuxBackend;
		case "wezterm":
			return weztermBackend;
		case "zellij":
			return zellijBackend;
		case "herdr":
			return herdrBackend;
		case "herdr-core":
			return herdrCoreBackend;
		case "rex":
			return rexBackend;
	}
}

/** The adapter of the current backend; undefined when no backend runs. */
export function currentMuxAdapter(): MuxBackendAdapter | undefined {
	const backend = getMuxBackend();
	return backend ? muxBackendAdapter(backend) : undefined;
}

/**
 * The first status ability that accepts the session, without launch detection.
 * Each reporter checks its own eligibility with bounded asynchronous probes, so session start
 * never blocks, and its binary choice does not depend on pane-launch availability (spec D29).
 */
export async function connectMuxWorkReporter(session: WorkReporterSession): Promise<WorkReporter | undefined> {
	for (const backend of DETECTION_ORDER) {
		const reporter = await muxBackendAdapter(backend).connectWorkReporter?.(session);
		if (reporter) return reporter;
	}
	return undefined;
}

export function isMuxAvailable(): boolean {
	return getMuxBackend() !== null;
}

export function muxSetupHint(): string {
	const pref = muxPreference();
	if (pref) return muxBackendAdapter(pref).setupHint();
	// In a Rex block the Rex hint names why Rex was not selected, for example an untested API revision (D28).
	if (process.env.REX_SESSION && process.env.REX_BLOCK) return rexBackend.setupHint();
	return "Start pi inside Herdr (`herdr`, then run `pi`), a Rex block, cmux (`cmux pi`), tmux (`tmux new -A -s pi 'pi'`), zellij (`zellij --session pi`, then run `pi`), or WezTerm.";
}

export function requireMuxBackend(): MuxBackend {
	const backend = getMuxBackend();
	if (!backend) {
		throw new Error(`No supported terminal multiplexer found. ${muxSetupHint()}`);
	}
	return backend;
}

export function isFishShell(): boolean {
	const shell = process.env.SHELL ?? "";
	return basename(shell) === "fish";
}

export function exitStatusVar(): string {
	return isFishShell() ? "$status" : "$?";
}

export function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

export function tailLines(text: string, lines: number): string {
	const split = text.split("\n");
	if (split.length <= lines) return text;
	return split.slice(-lines).join("\n");
}
