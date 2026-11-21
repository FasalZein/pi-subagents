import { validateToolArguments } from "@earendil-works/pi-ai";
import { registerSubagentKillTool } from "../../src/tools/kill-tool.ts";
import { registerSubagentResumeTool } from "../../src/tools/resume-tool.ts";
import { registerSubagentWaitTool } from "../../src/tools/wait-tool.ts";
import { assert, describe, it } from "../support/index.ts";

/**
 * T88: a parent passes the run id under the key the launch reply showed (children[].runId); kill,
 * resume and wait accept it, through Pi's own argument validation. A key from before T88 is refused,
 * not ignored, so a wait never falls back to every run by accident.
 */
describe("T88 one run-id key", () => {
	const tools = new Map<string, { name: string; parameters: unknown }>();
	const pi = { registerTool: (tool: { name: string; parameters: unknown }) => tools.set(tool.name, tool) };
	registerSubagentKillTool(
		pi as never,
		() => true,
		async () => {},
	);
	registerSubagentResumeTool(pi as never, () => true, {} as never);
	registerSubagentWaitTool(pi as never, () => true, { mayLaunch: () => true });
	const validate = (name: string, args: Record<string, unknown>) =>
		validateToolArguments(tools.get(name) as never, { type: "toolCall", id: "c", name, arguments: args } as never);

	it("kill and resume accept runId, wait accepts runIds", () => {
		assert.deepEqual(validate("subagent_kill", { runId: "0123abcd" }), { runId: "0123abcd" });
		assert.deepEqual(validate("subagent_resume", { runId: "0123abcd" }), { runId: "0123abcd" });
		assert.deepEqual(validate("subagent_wait", { runIds: ["0123abcd"] }), { runIds: ["0123abcd"] });
	});

	it("kill refuses id and wait refuses ids", () => {
		assert.throws(() => validate("subagent_kill", { id: "0123abcd" }), /runId|additional/);
		assert.throws(() => validate("subagent_wait", { ids: ["0123abcd"] }), /ids|additional/);
	});
});
