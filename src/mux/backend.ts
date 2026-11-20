import type { PaneIdentityPolicy } from "../launch/child-env.ts";
import type { WorkReporter, WorkReporterSession } from "../runtime/work-reporting.ts";
import type { MuxBackend } from "./core.ts";
import type { HerdrPlacementContext, HerdrPlacementPolicy } from "./herdr-surfaces.ts";
import type { PollResult } from "./poll.ts";
import type { RexPlacementContext, RexPlacementPolicy } from "./rex.ts";
import type { ZellijPlacementContext } from "./zellij-placement.ts";

export type SurfaceSplitDirection = "left" | "right" | "up" | "down";

/** Placement requests that a backend reads when it opens a surface; other backends ignore them. */
export interface SurfaceCreationOptions {
	herdr?: HerdrPlacementContext;
	rex?: RexPlacementContext;
	zellij?: ZellijPlacementContext;
	/** A backend reports here when a started surface runs with degraded placement; the launch goes on. */
	onPlacementWarning?: (warning: string) => void;
}

/**
 * The live session that owns the surfaces of a direct-program start. The caller stores it
 * (RunningSubagent.zellijTarget) and passes it back to close and to the exit check.
 */
export interface MuxSessionTarget {
	sessionName: string;
	parentPaneId: number;
}

/** One child launch in its two forms; a direct-program backend starts the form it supports. */
export interface ProgramLaunch {
	/** The shell command line: sentinel trap, cd prefix, launcher and capsule. */
	readonly shellCommand: string;
	/** The launcher with its capsule as argv, for a backend that starts a program without a shell. */
	readonly launcherArgv: readonly string[];
	/** Working directory of the child; the launcher also applies it from the capsule. */
	readonly cwd?: string;
}

/** The surface env name from which the launcher derives PI_SUBAGENT_SURFACE, as prefix + value. */
export interface SurfaceFromEnv {
	readonly name: string;
	readonly prefix: string;
}

/** A session resolved for direct-program starts. */
export interface DirectProgramSession {
	readonly target: MuxSessionTarget;
	/** Env that the child needs to reach this session. */
	readonly childEnv: Record<string, string>;
	/** How the child names its own surface: the launcher reads this name from the surface env. */
	readonly surfaceFromEnv: SurfaceFromEnv;
	/** Opens a surface whose own process runs the launch; nothing is typed into a shell. */
	start(name: string, launch: ProgramLaunch, options?: SurfaceCreationOptions): Promise<string>;
}

/**
 * One terminal multiplexer behind the shared functions of src/mux/ (spec decision D26).
 * Holds only the operations that the shared functions call today.
 * tmux, cmux, wezterm, zellij, old herdr and herdr-core implement it.
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
	/** Optional ability: rename the tab or pane of the caller. Absent means set_tab_title reports unavailable (D10). */
	renameCurrentTab?(title: string): void;
	/** Optional ability: rename the workspace or session of the caller. */
	renameWorkspace?(title: string): void;
	/**
	 * True when a shell command line goes to the surface through a staged script file,
	 * because the backend cannot take a long or multi-line command as typed input.
	 */
	readonly stagesShellCommands?: true;
	/** Identity names that the child launcher takes from the surface (D34); absent means the v2.9.2 prefixes. */
	readonly paneIdentity?: PaneIdentityPolicy;
	/** Optional ability: the backend places surfaces by a herdr placement policy, which a launch stores. */
	resolveHerdrPlacementPolicy?(value: string | undefined): HerdrPlacementPolicy;
	/** Optional ability: the backend places surfaces by a Rex placement policy, which a launch stores. */
	resolveRexPlacementPolicy?(value: string | undefined): RexPlacementPolicy;
	/** Optional status ability: publish the count of outstanding children for the session. */
	connectWorkReporter?(session: WorkReporterSession): Promise<WorkReporter | undefined>;
	/** Optional ability: resolve the live session for direct-program starts. */
	openProgramSession?(): Promise<DirectProgramSession>;
	/** Optional ability: report the exit of the surface's own process; null while it runs. */
	checkExit?(surface: string, target: MuxSessionTarget): Promise<PollResult | null>;
}
