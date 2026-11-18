/**
 * Hosts the interactive parent in a private tmux server: its own socket, its
 * own clean environment. The benchmark never sends input to a pane it did not
 * create, and it never touches the owner's Herdr, Rex or tmux sessions.
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

const TMUX_TIMEOUT_MS = 10_000;
// macOS limits a Unix socket path to 104 bytes.
const MAX_SOCKET_PATH = 100;
const TERMINAL_COLUMNS = "200";
const TERMINAL_ROWS = "50";

export function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Errors name the tmux subcommand and exit status only: the command line carries the model ref. */
function tmux(socket, args, env) {
	try {
		return execFileSync("tmux", ["-S", socket, ...args], {
			encoding: "utf8",
			timeout: TMUX_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
			...(env ? { env } : {}),
		});
	} catch (error) {
		throw new Error(
			`tmux ${args[0]} failed (status ${error.status ?? error.code ?? "unknown"})`,
		);
	}
}

/**
 * Start the parent command in a new private tmux server.
 * @param {{socket: string, workDir: string, command: string, env: Record<string, string>}} input
 * @returns {{socket: string, paneId: string}}
 */
export function startParent({ socket, workDir, command, env }) {
	if (socket.length > MAX_SOCKET_PATH)
		throw new Error(`tmux socket path is too long: ${socket}`);
	const paneId = tmux(
		socket,
		[
			"new-session",
			"-d",
			"-P",
			"-F",
			"#{pane_id}",
			"-s",
			"bench",
			"-x",
			TERMINAL_COLUMNS,
			"-y",
			TERMINAL_ROWS,
			"-c",
			workDir,
			command,
		],
		env,
	).trim();
	return { socket, paneId };
}

export function isAlive(parent) {
	try {
		tmux(parent.socket, ["has-session", "-t", "bench"]);
		return true;
	} catch {
		return false;
	}
}

export function typeText(parent, text) {
	tmux(parent.socket, ["send-keys", "-t", parent.paneId, "-l", "--", text]);
}

export function pressEnter(parent) {
	tmux(parent.socket, ["send-keys", "-t", parent.paneId, "Enter"]);
}

/** Stop the private server and everything in it. Safe to call twice, or for a server that is gone. */
export function stopServer(socket) {
	try {
		execFileSync("tmux", ["-S", socket, "kill-server"], {
			stdio: "ignore",
			timeout: TMUX_TIMEOUT_MS,
		});
	} catch {}
	rmSync(socket, { force: true });
}
