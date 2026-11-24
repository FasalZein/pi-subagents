import { getLaunchReturnLine } from "../runtime/state.ts";
import type { RunningSubagent } from "../types.ts";

type LaunchedChild = Pick<RunningSubagent, "agent" | "name" | "id" | "modelRef" | "mode">;

/**
 * One child's part of the reply: its delivered report, the error of a wait that ended without a
 * report (an interrupted wait stops the child, so no report follows), or null when it reports later.
 */
export type ChildDelivery = { report: string } | { waitError: string } | null;

/** The return line of a reply whose every child delivered its report; the settle fold keys on it. */
export const WAITED_RETURN_LINE = "This call waited for its children; each report follows below.";
const PARTLY_WAITED_RETURN_LINE = "Each report of a finished child follows below.";

/** One line per started child: agent, name, run id, the model ref that runs, pane or headless (D23). */
function renderLaunchChildLine(child: LaunchedChild): string {
	const where = child.mode === "interactive" ? "pane" : "headless";
	return `- ${child.name} (agent ${child.agent ?? "unknown"}): run ${child.id}, model ${child.modelRef ?? "not set"}, ${where}`;
}

/** A quoted absolute path, spaces included, up to its closing quote. */
const QUOTED_PATH = /(['"])\/[^'"\n]*\1/g;

/**
 * An unquoted absolute path at the start of a word; a URL's path follows ":" and is kept. A path
 * goes on past a space while the next word holds a "/" or ends in a file extension, so a folder
 * or file name with spaces does not leak. Limit: a later word such as "node.js" is taken as well.
 */
const ABSOLUTE_PATH = /(^|[\s(=])\/[^\s'"()]+(?: (?:[^\s'"()]*\/[^\s'"()]*|[^\s'"()]+\.[A-Za-z0-9]+))*/g;

/**
 * A launch error without file paths: a file-system error names the child's session file (the
 * reply text never shows one, D16), and the reason stays.
 */
export function launchErrorReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/^Error:\s*/, "")
		.replace(QUOTED_PATH, "$1<path>$1")
		.replace(ABSOLUTE_PATH, "$1<path>");
}

/**
 * The reply to a batch whose later child failed to launch (D16, D23): the failed child, one line
 * per child that started, by run id, then the started children's warnings.
 */
export function renderLaunchFailure(
	failed: { position: number; name: string; agent: string; error: string },
	total: number,
	started: readonly LaunchedChild[],
	notes: readonly string[],
): string {
	return [
		`Error: child ${failed.position} of ${total}, ${failed.name} (agent ${failed.agent}), failed to launch: ${failed.error}`,
		"These children started; each result arrives as a message when its run ends. Stop one that still runs with subagent_kill, by run id:",
		...started.map(renderLaunchChildLine),
		...notes.filter(Boolean),
	].join("\n");
}

/**
 * The reply to every launch (D23): child lines, the line on how this call's reports return,
 * the warnings of children that report later, then each delivered report unchanged.
 */
export function renderLaunchReply(
	children: readonly LaunchedChild[],
	deliveries: readonly ChildDelivery[],
	laterWarnings: readonly string[],
): string {
	const reports = deliveries.flatMap((delivery) => (delivery && "report" in delivery ? [delivery.report] : []));
	const waitErrors = deliveries.flatMap((delivery) =>
		delivery && "waitError" in delivery ? [delivery.waitError] : [],
	);
	const later = deliveries.some((delivery) => delivery === null);
	const returnLines =
		reports.length === 0
			? later
				? [getLaunchReturnLine()]
				: []
			: later
				? [PARTLY_WAITED_RETURN_LINE, getLaunchReturnLine()]
				: waitErrors.length === 0
					? [WAITED_RETURN_LINE]
					: [PARTLY_WAITED_RETURN_LINE];
	const head = [
		...children.map(renderLaunchChildLine),
		...returnLines,
		...waitErrors,
		...laterWarnings.filter(Boolean),
	].join("\n");
	return [head, ...reports].join("\n\n");
}
