import { execFileSync } from "node:child_process";
import type { MuxBackendAdapter, SurfaceSplitDirection } from "./backend.ts";
import { execFileAsync, tailLines } from "./core.ts";
import { defaultMuxRuntimeProbe } from "./runtime-probe.ts";
import { createZellijCommandSurface, createZellijSurface } from "./zellij-placement.ts";
import {
	closeZellijSurface,
	getZellijShellCommand,
	isZellijSurfaceLive,
	resolveZellijTarget,
} from "./zellij-runtime.ts";

function zellijPaneId(surface: string): string {
	return surface.startsWith("pane:") ? surface.slice("pane:".length) : surface;
}

function zellijEnv(surface?: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (surface) env.ZELLIJ_PANE_ID = zellijPaneId(surface);
	return env;
}

const ZELLIJ_PANE_SCOPED_ACTIONS = new Set([
	"close-pane",
	"dump-screen",
	"move-pane",
	"rename-pane",
	"write",
	"write-chars",
]);

function zellijActionArgs(args: string[], surface?: string): string[] {
	if (!surface || args.includes("--pane-id")) return args;
	const [action] = args;
	if (!action || !ZELLIJ_PANE_SCOPED_ACTIONS.has(action)) return args;
	return [action, "--pane-id", zellijPaneId(surface), ...args.slice(1)];
}

function zellijActionSync(args: string[], surface?: string): string {
	return execFileSync("zellij", ["action", ...zellijActionArgs(args, surface)], {
		encoding: "utf8",
		env: zellijEnv(surface),
	});
}

function createZellijSplit(name: string, direction: SurfaceSplitDirection, fromSurface?: string): string {
	const directionArg = direction === "left" || direction === "right" ? "right" : "down";
	const args = ["new-pane", "--direction", directionArg, "--name", name, "--cwd", process.cwd()];

	let paneOut = "";
	try {
		paneOut = zellijActionSync(args, fromSurface);
	} catch {
		if (!fromSurface) throw new Error("Failed to create zellij pane");
		paneOut = zellijActionSync(args);
	}

	const paneId = paneOut.match(/(?:terminal_)?(\d+)/)?.[1] ?? "";
	if (!paneId || !/^\d+$/.test(paneId)) {
		throw new Error(`Unexpected zellij pane id: ${paneOut.trim() || "(empty)"}`);
	}

	const surface = `pane:${paneId}`;
	if (direction === "left" || direction === "up") {
		try {
			zellijActionSync(["move-pane", direction], surface);
		} catch {}
	}
	try {
		zellijActionSync(["rename-pane", name], surface);
	} catch {}
	return surface;
}

export const zellijBackend: MuxBackendAdapter = {
	id: "zellij",
	isAvailable: () =>
		!!(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) && defaultMuxRuntimeProbe.hasCommand("zellij"),
	setupHint: () => "Start pi inside zellij (`zellij --session pi`, then run `pi`).",
	createSurface: (name, options) => createZellijSurface(name, options?.zellij),
	createSplit: createZellijSplit,
	sendCommand: (surface, command) => {
		zellijActionSync(["write-chars", command], surface);
		zellijActionSync(["write", "13"], surface);
	},
	readScreen: (surface, lines) => {
		const raw = execFileSync("zellij", ["action", "dump-screen", "--pane-id", zellijPaneId(surface)], {
			encoding: "utf8",
		});
		return tailLines(raw, lines);
	},
	readScreenAsync: async (surface, lines) => {
		const { stdout } = await execFileAsync("zellij", ["action", "dump-screen", "--pane-id", zellijPaneId(surface)], {
			encoding: "utf8",
		});
		return tailLines(stdout, lines);
	},
	closeSurface: (surface, target) => closeZellijSurface(surface, target),
	renameCurrentTab: (title) => {
		const paneId = process.env.ZELLIJ_PANE_ID;
		if (paneId) zellijActionSync(["rename-pane", title], `pane:${paneId}`);
		else zellijActionSync(["rename-tab", title]);
	},
	// zellij has no workspace to rename.
	renameWorkspace: () => {},
	openProgramSession: async () => {
		const target = await resolveZellijTarget();
		return {
			target,
			childEnv: { ZELLIJ_SESSION_NAME: target.sessionName },
			start: (name, command, options) =>
				createZellijCommandSurface(name, target, getZellijShellCommand(command), options?.zellij),
		};
	},
	checkExit: async (surface, target) =>
		(await isZellijSurfaceLive(target, surface))
			? null
			: { reason: "error", exitCode: 1, errorMessage: "Zellij child pane exited without a completion signal." },
};
