import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { MuxBackendAdapter, SurfaceSplitDirection } from "./backend.ts";
import { defaultMuxRuntimeProbe } from "./runtime-probe.ts";

const execFileAsync = promisify(execFile);

const DEFAULT_INTERACTIVE_MIN_COLUMNS = 50;
const DEFAULT_INTERACTIVE_MIN_ROWS = 10;

function positiveNumber(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) && number > 0 ? number : undefined;
}

type TmuxPlacementGeometry = {
	paneColumns: number;
	paneRows: number;
	windowColumns: number;
	windowRows: number;
	windowPanes: number;
};

type TmuxSplitPlan = {
	layout: "even-horizontal" | "even-vertical" | "tiled";
};

function readTmuxPlacementGeometry(pane: string | undefined): TmuxPlacementGeometry | null {
	if (!pane) return null;
	try {
		const output = execFileSync(
			"tmux",
			[
				"display-message",
				"-p",
				"-t",
				pane,
				"#{pane_width} #{pane_height} #{window_width} #{window_height} #{window_panes}",
			],
			{ encoding: "utf8" },
		).trim();
		const [paneColumnsRaw, paneRowsRaw, windowColumnsRaw, windowRowsRaw, windowPanesRaw] = output.split(/\s+/, 5);
		const paneColumns = positiveNumber(paneColumnsRaw);
		const paneRows = positiveNumber(paneRowsRaw);
		const windowColumns = positiveNumber(windowColumnsRaw);
		const windowRows = positiveNumber(windowRowsRaw);
		const windowPanes = positiveNumber(windowPanesRaw);
		return paneColumns && paneRows && windowColumns && windowRows && windowPanes
			? { paneColumns, paneRows, windowColumns, windowRows, windowPanes }
			: null;
	} catch {
		return null;
	}
}

function canFitTmuxTiledLayout(geometry: TmuxPlacementGeometry): boolean {
	const nextPaneCount = geometry.windowPanes + 1;
	for (let rows = 1; rows <= nextPaneCount; rows++) {
		const columns = Math.ceil(nextPaneCount / rows);
		if (
			Math.floor(geometry.windowColumns / columns) >= DEFAULT_INTERACTIVE_MIN_COLUMNS &&
			Math.floor(geometry.windowRows / rows) >= DEFAULT_INTERACTIVE_MIN_ROWS
		) {
			return true;
		}
	}
	return false;
}

function isTmuxPaneUsable(geometry: TmuxPlacementGeometry | null): boolean {
	return (
		!!geometry &&
		geometry.paneColumns >= DEFAULT_INTERACTIVE_MIN_COLUMNS &&
		geometry.paneRows >= DEFAULT_INTERACTIVE_MIN_ROWS
	);
}

function getTmuxSplitPlan(geometry: TmuxPlacementGeometry | null): TmuxSplitPlan | null {
	if (!geometry) return null;
	const nextPaneCount = geometry.windowPanes + 1;
	if (nextPaneCount === 2) {
		if (
			Math.floor(geometry.windowColumns / 2) >= DEFAULT_INTERACTIVE_MIN_COLUMNS &&
			geometry.windowRows >= DEFAULT_INTERACTIVE_MIN_ROWS
		) {
			return { layout: "even-horizontal" };
		}
		if (
			geometry.windowColumns >= DEFAULT_INTERACTIVE_MIN_COLUMNS &&
			Math.floor(geometry.windowRows / 2) >= DEFAULT_INTERACTIVE_MIN_ROWS
		) {
			return { layout: "even-vertical" };
		}
		return null;
	}
	return canFitTmuxTiledLayout(geometry) ? { layout: "tiled" } : null;
}

function createTmuxWindow(name: string): string {
	const args = ["new-window", "-d", "-P", "-F", "#{pane_id}", "-n", name];
	args.push("-c", process.cwd());

	const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
	if (!pane.startsWith("%")) {
		throw new Error(`Unexpected tmux new-window output: ${pane}`);
	}

	return pane;
}

function createTmuxSurface(name: string): string {
	const parentPane = process.env.TMUX_PANE;
	const splitPlan = getTmuxSplitPlan(readTmuxPlacementGeometry(parentPane));
	if (splitPlan) {
		const pane = createTmuxSplit(name, "right", parentPane);
		rebalanceTmuxWindow(parentPane, splitPlan.layout);
		if (!isTmuxPaneUsable(readTmuxPlacementGeometry(pane))) {
			moveTmuxPaneToWindow(pane, name);
		}
		return pane;
	}
	return createTmuxWindow(name);
}

function rebalanceTmuxWindow(pane: string | undefined, layout: "even-horizontal" | "even-vertical" | "tiled"): void {
	if (!pane) return;
	try {
		execFileSync("tmux", ["select-layout", "-t", pane, layout], {
			encoding: "utf8",
		});
	} catch {}
}

function moveTmuxPaneToWindow(pane: string, name: string): void {
	try {
		execFileSync("tmux", ["break-pane", "-d", "-t", pane, "-n", name], {
			encoding: "utf8",
		});
	} catch {}
}

/** -h splits side by side, -v stacks; -b puts the new pane before (left of or above) the target. */
const TMUX_SPLIT_FLAGS: Record<SurfaceSplitDirection, string[]> = {
	left: ["-h", "-b"],
	right: ["-h"],
	up: ["-v", "-b"],
	down: ["-v"],
};

function createTmuxSplit(_name: string, direction: SurfaceSplitDirection, fromSurface?: string): string {
	const args = ["split-window", "-d", ...TMUX_SPLIT_FLAGS[direction]];
	if (fromSurface) args.push("-t", fromSurface);
	args.push("-P", "-F", "#{pane_id}");

	const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
	if (!pane.startsWith("%")) {
		throw new Error(`Unexpected tmux split-window output: ${pane}`);
	}

	return pane;
}

function sendTmuxCommand(surface: string, command: string): void {
	if (command.length > 0) {
		execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], {
			encoding: "utf8",
		});
		execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], {
			encoding: "utf8",
		});
		return;
	}
	execFileSync("tmux", ["send-keys", "-t", surface, "C-m"], {
		encoding: "utf8",
	});
	execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], {
		encoding: "utf8",
	});
}

function readTmuxScreen(surface: string, lines: number): string {
	return execFileSync("tmux", ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`], {
		encoding: "utf8",
	});
}

async function readTmuxScreenAsync(surface: string, lines: number): Promise<string> {
	const { stdout } = await execFileAsync(
		"tmux",
		["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
		{ encoding: "utf8" },
	);
	return stdout;
}

function renameTmuxCurrentWindow(title: string): void {
	if (process.env.PI_SUBAGENT_RENAME_TMUX_WINDOW !== "1") return;
	const paneId = process.env.TMUX_PANE;
	if (!paneId) throw new Error("TMUX_PANE not set");
	const windowId = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"], {
		encoding: "utf8",
	}).trim();
	execFileSync("tmux", ["rename-window", "-t", windowId, title], {
		encoding: "utf8",
	});
}

function renameTmuxCurrentSession(title: string): void {
	if (process.env.PI_SUBAGENT_RENAME_TMUX_SESSION !== "1") return;
	const paneId = process.env.TMUX_PANE;
	if (!paneId) throw new Error("TMUX_PANE not set");
	const sessionId = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{session_id}"], {
		encoding: "utf8",
	}).trim();
	execFileSync("tmux", ["rename-session", "-t", sessionId, title], {
		encoding: "utf8",
	});
}

export const tmuxBackend: MuxBackendAdapter = {
	id: "tmux",
	isAvailable: () => !!process.env.TMUX && defaultMuxRuntimeProbe.hasCommand("tmux"),
	setupHint: () => "Start pi inside tmux (`tmux new -A -s pi 'pi'`).",
	createSurface: async (name) => createTmuxSurface(name),
	createSplit: createTmuxSplit,
	sendCommand: sendTmuxCommand,
	readScreen: readTmuxScreen,
	readScreenAsync: readTmuxScreenAsync,
	closeSurface: (surface) => {
		execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
	},
	renameCurrentTab: renameTmuxCurrentWindow,
	renameWorkspace: renameTmuxCurrentSession,
};
