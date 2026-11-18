import type { MuxBackend } from "./core.ts";
import type { HerdrPlacementContext } from "./herdr-surfaces.ts";
import type { PollResult } from "./poll.ts";
import type { ZellijPlacementContext } from "./zellij-placement.ts";

export type SurfaceSplitDirection = "left" | "right" | "up" | "down";

/** Placement requests that a backend reads when it opens a surface; other backends ignore them. */
export interface SurfaceCreationOptions {
	herdr?: HerdrPlacementContext;
	zellij?: ZellijPlacementContext;
}

/**
 * The live session that owns the surfaces of a direct-program start. The caller stores it
 * (RunningSubagent.zellijTarget) and passes it back to close and to the exit check.
 */
export interface MuxSessionTarget {
	sessionName: string;
	parentPaneId: number;
}

/** A session resolved for direct-program starts. */
export interface DirectProgramSession {
	readonly target: MuxSessionTarget;
	/** Env that the child needs to reach this session. */
	readonly childEnv: Record<string, string>;
	/** Opens a surface whose own process runs the shell command line; nothing is typed into a shell. */
	start(name: string, command: string, options?: SurfaceCreationOptions): Promise<string>;
}

/**
 * One terminal multiplexer behind the shared functions of src/mux/ (spec decision D26).
 * Holds only the operations that the shared functions call today.
 * tmux, cmux, wezterm and zellij implement it; herdr keeps its branches in io.ts and
 * surfaces.ts until a later ticket moves it here.
 */
export interface MuxBackendAdapter {
	readonly id: MuxBackend;
	/** The runtime env of the backend is set and its CLI is on PATH. */
	isAvailable(): boolean;
	setupHint(): string;
	/** Opens a surface for a new child and returns its opaque surface id. */
	createSurface(name: string, options?: SurfaceCreationOptions): Promise<string>;
	createSplit(name: string, direction: SurfaceSplitDirection, fromSurface?: string): string;
	/** Types the command and presses Enter; an empty command presses Enter only. */
	sendCommand(surface: string, command: string): void;
	/** Returns the last lines of the surface. */
	readScreen(surface: string, lines: number): string;
	readScreenAsync(surface: string, lines: number): Promise<string>;
	/**
	 * Closes the surface. A backend that closes asynchronously returns a promise that settles
	 * when the close is done; target is the session stored at a direct-program start.
	 */
	closeSurface(surface: string, target?: MuxSessionTarget): void | Promise<void>;
	renameCurrentTab(title: string): void;
	renameWorkspace(title: string): void;
	/** Optional ability: resolve the live session for direct-program starts. */
	openProgramSession?(): Promise<DirectProgramSession>;
	/** Optional ability: report the exit of the surface's own process; null while it runs. */
	checkExit?(surface: string, target: MuxSessionTarget): Promise<PollResult | null>;
}
