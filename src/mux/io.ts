import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MuxSessionTarget } from "./backend.ts";
import { isFishShell, muxBackendAdapter, requireMuxBackend, shellEscape } from "./core.ts";

export function sendCommand(surface: string, command: string): void {
	muxBackendAdapter(requireMuxBackend()).sendCommand(surface, command);
}

function stageShellCommand(command: string): string {
	const shell = (process.env.SHELL ?? "/bin/sh").trim() || "/bin/sh";
	const ext = isFishShell() ? ".fish" : ".sh";
	const scriptPath = join(tmpdir(), `pi-subagent-shell-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
	writeFileSync(scriptPath, `#!${shell}\n${command}\n`, "utf8");
	chmodSync(scriptPath, 0o700);
	return scriptPath;
}

function buildStagedShellCommand(scriptPath: string): string {
	return `${shellEscape(scriptPath)}; rm -f ${shellEscape(scriptPath)}`;
}

export function sendShellCommand(surface: string, command: string): void {
	if (!muxBackendAdapter(requireMuxBackend()).stagesShellCommands) {
		sendCommand(surface, command);
		return;
	}
	const scriptPath = stageShellCommand(command);
	try {
		sendCommand(surface, buildStagedShellCommand(scriptPath));
	} catch (error) {
		try {
			rmSync(scriptPath, { force: true });
		} catch {}
		throw error;
	}
}

export function readScreen(surface: string, lines = 50): string {
	return muxBackendAdapter(requireMuxBackend()).readScreen(surface, lines);
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
	return muxBackendAdapter(requireMuxBackend()).readScreenAsync(surface, lines);
}

/** Closes the surface and settles when the backend has closed it. */
export async function closeSurfaceAsync(surface: string, target?: MuxSessionTarget): Promise<void> {
	await muxBackendAdapter(requireMuxBackend()).closeSurface(surface, target);
}

/** Starts the close and does not wait for an asynchronous close, which can then fail unseen. */
export function closeSurface(surface: string): void {
	const closing = muxBackendAdapter(requireMuxBackend()).closeSurface(surface);
	if (closing) void closing.catch(() => {});
}
