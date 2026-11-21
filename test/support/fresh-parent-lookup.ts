import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const srcUrl = (path: string) => new URL(`../../${path}`, import.meta.url).href;

export interface FreshLookupReply {
	text: string;
	details: { status: string; missing: { runId: string; error: string }[] };
	running: number;
}

/**
 * A restarted parent (T25): a fresh Node process, so no module state of the first parent survives,
 * registers subagent_wait and looks up run ids from `cwd` (the new parent's working directory).
 * `processCwd` is the directory the new process starts in.
 */
export function lookUpInFreshParent(options: {
	scriptDir: string;
	cwd: string;
	processCwd?: string;
	sessionId: string;
	ids: readonly string[];
	artifactRoot: string;
}): FreshLookupReply {
	const script = join(options.scriptDir, `restart-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
	writeFileSync(
		script,
		`import { registerSubagentWaitTool } from ${JSON.stringify(srcUrl("src/tools/wait-tool.ts"))};
import { runningSubagents } from ${JSON.stringify(srcUrl("src/runtime/state.ts"))};
let tool;
registerSubagentWaitTool({ registerTool: (definition) => (tool = definition) }, () => true, { mayLaunch: () => true });
const ctx = { cwd: ${JSON.stringify(options.cwd)}, sessionManager: { getSessionId: () => ${JSON.stringify(options.sessionId)} } };
const reply = await tool.execute("c1", { runIds: ${JSON.stringify(options.ids)} }, undefined, undefined, ctx);
process.stdout.write(JSON.stringify({ text: reply.content[0].text, details: reply.details, running: runningSubagents.size }));
`,
	);
	const child = spawnSync(process.execPath, [script], {
		encoding: "utf8",
		cwd: options.processCwd ?? options.cwd,
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PI_ARTIFACT_PROJECT_ROOT: options.artifactRoot },
	});
	if (child.status !== 0) throw new Error(`fresh parent failed: ${child.stderr}`);
	return JSON.parse(child.stdout) as FreshLookupReply;
}
