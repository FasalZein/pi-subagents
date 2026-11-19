import { getLaunchReturnLine } from "../runtime/state.ts";
import type { RunningSubagent } from "../types.ts";

type LaunchedChild = Pick<RunningSubagent, "agent" | "name" | "id" | "modelRef" | "mode">;

/**
 * One child's part of the reply: its delivered report, the error of a wait that ended without a
 * report (an interrupted wait stops the child, so no report follows), or null when it reports later.
 */
export type ChildDelivery = { report: string } | { waitError: string } | null;

const WAITED_RETURN_LINE = "This call waited for its children; each report follows below.";
const PARTLY_WAITED_RETURN_LINE = "Each report of a finished child follows below.";

/** One line per started child: agent, name, run id, the model ref that runs, pane or headless (D23). */
export function renderLaunchChildLine(child: LaunchedChild): string {
	const where = child.mode === "interactive" ? "pane" : "headless";
	return `- ${child.name} (agent ${child.agent ?? "unknown"}): run ${child.id}, model ${child.modelRef ?? "not set"}, ${where}`;
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
