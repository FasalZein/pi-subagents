/** Process-wide state of one launcher run: safe errors, cleanup registry, checkout identity. */
import { execFileSync } from "node:child_process";

/** An error whose message is safe to print: it holds no pane text, command line or secret. */
export class BenchError extends Error {}

/** Cleanup steps that must run on every exit path, including a signal. Each runs once. */
export const cleanups = {
	steps: new Set(),
	add(step) {
		this.steps.add(step);
		return () => this.steps.delete(step);
	},
	runAll() {
		for (const step of [...this.steps].reverse()) {
			this.steps.delete(step);
			try {
				step();
			} catch {}
		}
	},
};

function git(dir, args) {
	return execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

/**
 * The checkout must be clean, untracked files included (ignored files such as
 * node_modules aside): then its commit names all source it can import.
 */
/**
 * The measured checkout must be private: a linked git worktree with a detached
 * HEAD, so no branch work happens in it. Checked once at start; checkoutState
 * still guards cleanliness and the commit around each attempt.
 */
export function assertPrivateCheckout(dir) {
	const gitDir = git(dir, ["rev-parse", "--absolute-git-dir"]);
	const commonDir = git(dir, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	if (gitDir === commonDir)
		throw new BenchError(
			"--checkout must be a linked worktree (git worktree add --detach), not a main checkout",
		);
	let onBranch = true;
	try {
		git(dir, ["symbolic-ref", "-q", "HEAD"]);
	} catch {
		onBranch = false;
	}
	if (onBranch)
		throw new BenchError("--checkout must have a detached HEAD, not a branch");
	return checkoutState(dir);
}

export function checkoutState(dir) {
	const commit = git(dir, ["rev-parse", "HEAD"]);
	const status = git(dir, ["status", "--porcelain", "--untracked-files=all"]);
	if (status)
		throw new BenchError(
			"--checkout has uncommitted or untracked files; benchmark a clean checkout",
		);
	return { commit };
}
