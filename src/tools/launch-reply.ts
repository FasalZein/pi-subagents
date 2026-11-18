import { getLaunchReturnLine } from "../runtime/state.ts";
import type { RunningSubagent } from "../types.ts";

type LaunchedChild = Pick<RunningSubagent, "agent" | "name" | "id" | "modelRef" | "mode">;

/** One line per started child: agent, name, run id, the model ref that runs, pane or headless (D23). */
export function renderLaunchChildLine(child: LaunchedChild): string {
	const where = child.mode === "interactive" ? "pane" : "headless";
	return `- ${child.name} (agent ${child.agent ?? "unknown"}): run ${child.id}, model ${child.modelRef ?? "not set"}, ${where}`;
}

/** The reply to a launch whose children report later: child lines, one return line, then warnings (D23). */
export function renderLaunchReply(children: readonly LaunchedChild[], warnings: readonly string[]): string {
	return [...children.map(renderLaunchChildLine), getLaunchReturnLine(), ...warnings.filter(Boolean)].join("\n");
}
