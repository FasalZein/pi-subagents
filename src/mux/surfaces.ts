import { cmuxBackend } from "./cmux.ts";
import { getMuxBackend, requireMuxBackend, zellijActionSync } from "./core.ts";
import {
	createHerdrSplit,
	createHerdrSurface,
	type HerdrPlacementContext,
	renameHerdrCurrentTab,
	renameHerdrCurrentWorkspace,
} from "./herdr-surfaces.ts";
import { tmuxBackend } from "./tmux.ts";
import { weztermBackend } from "./wezterm.ts";
import { createZellijSurface, type ZellijPlacementContext } from "./zellij-placement.ts";

// ── Surface creation ───────────────────────────────────────────────────────

export interface SurfaceCreationOptions {
	herdr?: HerdrPlacementContext;
	zellij?: ZellijPlacementContext;
}

export async function createSurface(name: string, options?: SurfaceCreationOptions): Promise<string> {
	const backend = getMuxBackend();

	if (backend === "cmux") {
		return cmuxBackend.createSurface(name);
	}

	if (backend === "tmux") {
		return tmuxBackend.createSurface(name);
	}

	if (backend === "wezterm") {
		return weztermBackend.createSurface(name);
	}

	if (backend === "zellij") {
		return createZellijSurface(name, options?.zellij);
	}

	if (backend === "herdr") {
		return createHerdrSurface(name, options?.herdr);
	}

	return createSurfaceSplit(name, "right");
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
	if (backend === "cmux") return cmuxBackend.createSplit(name, direction, fromSurface);
	if (backend === "tmux") return tmuxBackend.createSplit(name, direction, fromSurface);
	if (backend === "wezterm") return weztermBackend.createSplit(name, direction, fromSurface);
	if (backend === "zellij") return createZellijSplit(name, direction, fromSurface);
	return createHerdrSplit(name, direction, fromSurface);
}

export function renameCurrentTab(title: string): void {
	const backend = requireMuxBackend();
	if (backend === "cmux") {
		cmuxBackend.renameCurrentTab(title);
		return;
	}
	if (backend === "tmux") {
		tmuxBackend.renameCurrentTab(title);
		return;
	}
	if (backend === "wezterm") {
		weztermBackend.renameCurrentTab(title);
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
		cmuxBackend.renameWorkspace(title);
		return;
	}
	if (backend === "tmux") {
		tmuxBackend.renameWorkspace(title);
		return;
	}
	if (backend === "wezterm") {
		weztermBackend.renameWorkspace(title);
		return;
	}
	if (backend === "zellij") return;
	if (backend === "herdr") {
		renameHerdrCurrentWorkspace(title);
		return;
	}
	throw new Error("Unsupported mux backend");
}
