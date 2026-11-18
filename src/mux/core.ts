import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { MuxBackendAdapter } from "./backend.ts";
import { cmuxBackend } from "./cmux.ts";
import { isHerdrRuntimeAvailable } from "./herdr.ts";
import { defaultMuxRuntimeProbe } from "./runtime-probe.ts";
import { tmuxBackend } from "./tmux.ts";
import { weztermBackend } from "./wezterm.ts";
import { zellijBackend } from "./zellij.ts";

export const execFileAsync = promisify(execFile);

export type MuxBackend = "cmux" | "tmux" | "zellij" | "wezterm" | "herdr";

function hasCommand(command: string): boolean {
	return defaultMuxRuntimeProbe.hasCommand(command);
}

function muxPreference(): MuxBackend | null {
	const pref = (process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
	if (pref === "cmux" || pref === "tmux" || pref === "zellij" || pref === "wezterm" || pref === "herdr") {
		return pref;
	}
	return null;
}

function isHerdrMuxRuntimeAvailable(): boolean {
	return isHerdrRuntimeAvailable(hasCommand);
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
	return isHerdrMuxRuntimeAvailable();
}

export function getMuxBackend(): MuxBackend | null {
	const pref = muxPreference();
	if (pref === "cmux") return isCmuxAvailable() ? "cmux" : null;
	if (pref === "tmux") return isTmuxAvailable() ? "tmux" : null;
	if (pref === "zellij") return isZellijAvailable() ? "zellij" : null;
	if (pref === "wezterm") return weztermBackend.isAvailable() ? "wezterm" : null;
	if (pref === "herdr") return isHerdrMuxRuntimeAvailable() ? "herdr" : null;

	if (isHerdrMuxRuntimeAvailable()) return "herdr";
	if (isCmuxAvailable()) return "cmux";
	if (isTmuxAvailable()) return "tmux";
	if (isZellijAvailable()) return "zellij";
	if (weztermBackend.isAvailable()) return "wezterm";
	return null;
}

/**
 * The adapter of a backend; undefined for herdr, which keeps its branches until a later ticket.
 * A switch, not a module-level map: the adapter modules import this one, so a map would read them before they exist.
 */
export function muxBackendAdapter(backend: MuxBackend): MuxBackendAdapter | undefined {
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
			return undefined;
	}
}

/** The adapter of the current backend; undefined when no backend runs or the backend is herdr. */
export function currentMuxAdapter(): MuxBackendAdapter | undefined {
	const backend = getMuxBackend();
	return backend ? muxBackendAdapter(backend) : undefined;
}

export function isMuxAvailable(): boolean {
	return getMuxBackend() !== null;
}

export function muxSetupHint(): string {
	const pref = muxPreference();
	if (pref === "cmux") return cmuxBackend.setupHint();
	if (pref === "tmux") return tmuxBackend.setupHint();
	if (pref === "zellij") return zellijBackend.setupHint();
	if (pref === "wezterm") return weztermBackend.setupHint();
	if (pref === "herdr") return "Start pi inside Herdr (`herdr`, then run `pi`).";
	return "Start pi inside Herdr (`herdr`, then run `pi`), cmux (`cmux pi`), tmux (`tmux new -A -s pi 'pi'`), zellij (`zellij --session pi`, then run `pi`), or WezTerm.";
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
