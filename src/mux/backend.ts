import type { MuxBackend } from "./core.ts";

export type SurfaceSplitDirection = "left" | "right" | "up" | "down";

/**
 * One terminal multiplexer behind the shared functions of src/mux/ (spec decision D26).
 * Holds only the operations that the shared functions call today.
 * Expand phase (T39, T40): tmux, cmux and wezterm implement it; zellij and herdr
 * keep their branches in core.ts, io.ts and surfaces.ts until a later ticket moves them here.
 */
export interface MuxBackendAdapter {
	readonly id: MuxBackend;
	/** The runtime env of the backend is set and its CLI is on PATH. */
	isAvailable(): boolean;
	setupHint(): string;
	/** Opens a surface for a new child and returns its opaque surface id. */
	createSurface(name: string): Promise<string>;
	createSplit(name: string, direction: SurfaceSplitDirection, fromSurface?: string): string;
	/** Types the command and presses Enter; an empty command presses Enter only. */
	sendCommand(surface: string, command: string): void;
	/** Returns the last lines of the surface. */
	readScreen(surface: string, lines: number): string;
	readScreenAsync(surface: string, lines: number): Promise<string>;
	closeSurface(surface: string): void;
	renameCurrentTab(title: string): void;
	renameWorkspace(title: string): void;
}
