import { execFileSync } from "node:child_process";
import type { MuxBackendAdapter, SurfaceSplitDirection } from "./backend.ts";
import { execFileAsync, tailLines } from "./core.ts";
import { defaultMuxRuntimeProbe } from "./runtime-probe.ts";

function createWezTermSurface(name: string): string {
	const paneId = execFileSync("wezterm", ["cli", "spawn", "--cwd", process.cwd()], { encoding: "utf8" }).trim();
	if (!paneId || !/^\d+$/.test(paneId)) {
		throw new Error(`Unexpected wezterm spawn output: ${paneId || "(empty)"}`);
	}
	try {
		execFileSync("wezterm", ["cli", "set-tab-title", "--pane-id", paneId, name], { encoding: "utf8" });
	} catch {}
	return paneId;
}

function createWezTermSplit(name: string, direction: SurfaceSplitDirection, fromSurface?: string): string {
	const args = ["cli", "split-pane"];
	if (direction === "left") args.push("--left");
	else if (direction === "right") args.push("--right");
	else if (direction === "up") args.push("--top");
	else args.push("--bottom");
	args.push("--cwd", process.cwd());
	if (fromSurface) args.push("--pane-id", fromSurface);
	const paneId = execFileSync("wezterm", args, { encoding: "utf8" }).trim();
	if (!paneId || !/^\d+$/.test(paneId)) {
		throw new Error(`Unexpected wezterm split-pane output: ${paneId || "(empty)"}`);
	}
	try {
		execFileSync("wezterm", ["cli", "set-tab-title", "--pane-id", paneId, name], { encoding: "utf8" });
	} catch {}
	return paneId;
}

/** Runs `wezterm cli <subcommand>` on the pane of WEZTERM_PANE, or on the focused pane when it is unset. */
function setCurrentWezTermTitle(subcommand: "set-tab-title" | "set-window-title", title: string): void {
	const paneId = process.env.WEZTERM_PANE;
	const args = ["cli", subcommand];
	if (paneId) args.push("--pane-id", paneId);
	args.push(title);
	execFileSync("wezterm", args, { encoding: "utf8" });
}

export const weztermBackend: MuxBackendAdapter = {
	id: "wezterm",
	isAvailable: () => !!process.env.WEZTERM_UNIX_SOCKET && defaultMuxRuntimeProbe.hasCommand("wezterm"),
	setupHint: () => "Start pi inside WezTerm.",
	createSurface: async (name) => createWezTermSurface(name),
	createSplit: createWezTermSplit,
	sendCommand: (surface, command) => {
		execFileSync("wezterm", ["cli", "send-text", "--pane-id", surface, "--no-paste", `${command}\n`], {
			encoding: "utf8",
		});
	},
	readScreen: (surface, lines) => {
		const raw = execFileSync("wezterm", ["cli", "get-text", "--pane-id", surface], {
			encoding: "utf8",
		});
		return tailLines(raw, lines);
	},
	readScreenAsync: async (surface, lines) => {
		const { stdout } = await execFileAsync("wezterm", ["cli", "get-text", "--pane-id", surface], { encoding: "utf8" });
		return tailLines(stdout, lines);
	},
	closeSurface: (surface) => {
		execFileSync("wezterm", ["cli", "kill-pane", "--pane-id", surface], {
			encoding: "utf8",
		});
	},
	renameCurrentTab: (title) => setCurrentWezTermTitle("set-tab-title", title),
	renameWorkspace: (title) => {
		try {
			setCurrentWezTermTitle("set-window-title", title);
		} catch {}
	},
};
