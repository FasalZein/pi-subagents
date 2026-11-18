import { execFileSync, execSync } from "node:child_process";
import { createCmuxSplit, createCmuxSurface } from "./cmux-surfaces.ts";
import { getMuxBackend, requireMuxBackend, shellEscape, zellijActionSync } from "./core.ts";
import {
	createHerdrSplit,
	createHerdrSurface,
	type HerdrPlacementContext,
	renameHerdrCurrentTab,
	renameHerdrCurrentWorkspace,
} from "./herdr-surfaces.ts";
import { tmuxBackend } from "./tmux.ts";
import { createZellijSurface, type ZellijPlacementContext } from "./zellij-placement.ts";

// ── Surface creation ───────────────────────────────────────────────────────

export interface SurfaceCreationOptions {
	herdr?: HerdrPlacementContext;
	zellij?: ZellijPlacementContext;
}

export async function createSurface(name: string, options?: SurfaceCreationOptions): Promise<string> {
	const backend = getMuxBackend();

	if (backend === "cmux") {
		return createCmuxSurface(name);
	}

	if (backend === "tmux") {
		return tmuxBackend.createSurface(name);
	}

	if (backend === "wezterm") {
		return createWezTermSurface(name);
	}

	if (backend === "zellij") {
		return createZellijSurface(name, options?.zellij);
	}

	if (backend === "herdr") {
		return createHerdrSurface(name, options?.herdr);
	}

	return createSurfaceSplit(name, "right");
}

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

function createWezTermSplit(name: string, direction: "left" | "right" | "up" | "down", fromSurface?: string): string {
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

function createZellijSplit(name: string, direction: "left" | "right" | "up" | "down", fromSurface?: string): string {
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

export function createSurfaceSplit(
	name: string,
	direction: "left" | "right" | "up" | "down",
	fromSurface?: string,
): string {
	const backend = requireMuxBackend();
	if (backend === "cmux") return createCmuxSplit(name, direction, fromSurface);
	if (backend === "tmux") return tmuxBackend.createSplit(name, direction, fromSurface);
	if (backend === "wezterm") return createWezTermSplit(name, direction, fromSurface);
	if (backend === "zellij") return createZellijSplit(name, direction, fromSurface);
	return createHerdrSplit(name, direction, fromSurface);
}

export function renameCurrentTab(title: string): void {
	const backend = requireMuxBackend();
	if (backend === "cmux") {
		const surfaceId = process.env.CMUX_SURFACE_ID;
		if (!surfaceId) throw new Error("CMUX_SURFACE_ID not set");
		execSync(`cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`, {
			encoding: "utf8",
		});
		return;
	}
	if (backend === "tmux") {
		tmuxBackend.renameCurrentTab(title);
		return;
	}
	if (backend === "wezterm") {
		const paneId = process.env.WEZTERM_PANE;
		const args = ["cli", "set-tab-title"];
		if (paneId) args.push("--pane-id", paneId);
		args.push(title);
		execFileSync("wezterm", args, { encoding: "utf8" });
		return;
	}
	if (backend === "zellij") {
		const paneId = process.env.ZELLIJ_PANE_ID;
		if (paneId) zellijActionSync(["rename-pane", title], `pane:${paneId}`);
		else zellijActionSync(["rename-tab", title]);
		return;
	}
	if (backend === "herdr") {
		renameHerdrCurrentTab(title);
		return;
	}
	throw new Error("Unsupported mux backend");
}

export function renameWorkspace(title: string): void {
	const backend = requireMuxBackend();
	if (backend === "cmux") {
		execSync(`cmux workspace-action --action rename --title ${shellEscape(title)}`, { encoding: "utf8" });
		return;
	}
	if (backend === "tmux") {
		tmuxBackend.renameWorkspace(title);
		return;
	}
	if (backend === "wezterm") {
		const paneId = process.env.WEZTERM_PANE;
		const args = ["cli", "set-window-title"];
		if (paneId) args.push("--pane-id", paneId);
		args.push(title);
		try {
			execFileSync("wezterm", args, { encoding: "utf8" });
		} catch {}
		return;
	}
	if (backend === "zellij") return;
	if (backend === "herdr") {
		renameHerdrCurrentWorkspace(title);
		return;
	}
	throw new Error("Unsupported mux backend");
}
