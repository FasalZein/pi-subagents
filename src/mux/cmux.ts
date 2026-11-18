import { execSync } from "node:child_process";
import type { MuxBackendAdapter } from "./backend.ts";
import { createCmuxSplit, createCmuxSurface } from "./cmux-surfaces.ts";
import { execFileAsync, shellEscape } from "./core.ts";
import { defaultMuxRuntimeProbe } from "./runtime-probe.ts";

export const cmuxBackend: MuxBackendAdapter = {
	id: "cmux",
	isAvailable: () => !!process.env.CMUX_SOCKET_PATH && defaultMuxRuntimeProbe.hasCommand("cmux"),
	setupHint: () => "Start pi inside cmux (`cmux pi`).",
	createSurface: async (name) => createCmuxSurface(name),
	createSplit: createCmuxSplit,
	sendCommand: (surface, command) => {
		execSync(`cmux send --surface ${shellEscape(surface)} ${shellEscape(`${command}\n`)}`, { encoding: "utf8" });
	},
	readScreen: (surface, lines) =>
		execSync(`cmux read-screen --surface ${shellEscape(surface)} --lines ${lines}`, { encoding: "utf8" }),
	readScreenAsync: async (surface, lines) => {
		const { stdout } = await execFileAsync("cmux", ["read-screen", "--surface", surface, "--lines", String(lines)], {
			encoding: "utf8",
		});
		return stdout;
	},
	closeSurface: (surface) => {
		execSync(`cmux close-surface --surface ${shellEscape(surface)}`, {
			encoding: "utf8",
		});
	},
	renameCurrentTab: (title) => {
		const surfaceId = process.env.CMUX_SURFACE_ID;
		if (!surfaceId) throw new Error("CMUX_SURFACE_ID not set");
		execSync(`cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`, {
			encoding: "utf8",
		});
	},
	renameWorkspace: (title) => {
		execSync(`cmux workspace-action --action rename --title ${shellEscape(title)}`, { encoding: "utf8" });
	},
	stagesShellCommands: true,
};
