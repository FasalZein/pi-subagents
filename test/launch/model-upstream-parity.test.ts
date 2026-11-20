import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AgentDefaults } from "../../src/agents/definitions.ts";
import { buildChildLaunchPlan } from "../../src/launch/child-launch-plan.ts";
import {
	buildPersistedSubagentLaunchMetadata,
	getPersistedSessionParityArgs,
	prepareSubagentLaunch,
} from "../../src/launch/prep.ts";
import { resolveResumeLaunchMetadataForInvocation } from "../../src/runtime/resume-service.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import { assert, createTestDir, mkdirSync, writeFileSync } from "../support/index.ts";

/**
 * D08: exact model ids, the bare-id provider tie-break and level precedence
 * behave as v2.9.2 (cf6dbf4). Every expected value below is the output of
 * cf6dbf4's buildChildLaunchPlan or resolveResumeLaunchMetadataForInvocation for
 * the same input (git archive cf6dbf4, same scenario table). Synthetic refs only.
 */
const KNOWN = ["a/base", "b/base", "a/target", "b/mini", "b/mini-v3", "c/advanced:rev1"];
const modelRegistry = {
	getAvailable: () =>
		KNOWN.map((ref) => ({
			provider: ref.slice(0, ref.indexOf("/")),
			id: ref.slice(ref.indexOf("/") + 1),
			reasoning: true,
		})),
};
const REFUSED = "refused";

async function launchRef(
	params: { model: string; thinking?: string },
	agentDefs: AgentDefaults | null,
	parentModelRef: string,
	parentThinking: string,
): Promise<string | undefined> {
	const dir = createTestDir();
	try {
		const plan = await buildChildLaunchPlan({
			params: { name: "n", title: "N", task: "t", agent: "picker", ...params },
			agentDefs,
			parentCwd: dir,
			parentSessionDir: join(dir, "parent-sessions"),
			modelRegistry,
			parentModelRef,
			parentThinking,
		});
		return plan.effectiveModelRef;
	} catch {
		return REFUSED;
	}
}

function resumeMetadata(fields: Partial<PersistedSubagentLaunchMetadata>): PersistedSubagentLaunchMetadata {
	return {
		version: 1,
		timestamp: new Date().toISOString(),
		name: "n",
		agent: "picker",
		mode: "background",
		sessionMode: "lineage-only",
		async: true,
		parentClosePolicy: "terminate",
		denyTools: [],
		noContextFiles: false,
		noSession: false,
		agentConfigDir: "/tmp",
		cwd: "/tmp",
		boundarySystemPrompt: true,
		...fields,
	};
}

function resumeRef(
	fields: Partial<PersistedSubagentLaunchMetadata>,
	model: string | undefined,
	thinking?: string,
): string | undefined {
	try {
		return resolveResumeLaunchMetadataForInvocation(resumeMetadata(fields), model, thinking, modelRegistry)?.modelRef;
	} catch {
		return REFUSED;
	}
}

describe("model resolution as cf6dbf4 (D08)", () => {
	const LAUNCHES: Array<[string, { model: string; thinking?: string }, AgentDefaults | null, string, string, string]> =
		[
			["an exact qualified id", { model: "a/target" }, null, "a/base", "medium", "a/target:medium"],
			["an exact bare id at one provider", { model: "target" }, null, "b/mini", "medium", "a/target:medium"],
			[
				"a bare id at two providers takes the parent's provider a",
				{ model: "base" },
				null,
				"a/target",
				"low",
				"a/base:low",
			],
			[
				"a bare id at two providers takes the parent's provider b",
				{ model: "base" },
				null,
				"b/mini",
				"low",
				"b/base:low",
			],
			[
				"a bare id at two providers outside the parent's provider",
				{ model: "base" },
				null,
				"c/advanced:rev1",
				"low",
				REFUSED,
			],
			[
				"an exact bare id that is also a fragment of another id",
				{ model: "mini" },
				null,
				"a/base",
				"low",
				"b/mini:low",
			],
			[
				"an exact bare id that is also a fragment, restricted",
				{ model: "mini" },
				{ allowedModels: "b/mini, b/mini-v3" },
				"a/base",
				"low",
				"b/mini:low",
			],
			[
				"a bare id at two providers, restricted, parent b",
				{ model: "base:low" },
				{ allowedModels: "a/base, b/base" },
				"b/mini",
				"low",
				"b/base:low",
			],
			[
				"the model suffix wins over the thinking parameter",
				{ model: "a/target:high", thinking: "low" },
				{ thinking: "medium" },
				"a/base",
				"minimal",
				"a/target:high",
			],
			[
				"the thinking parameter wins over the agent level",
				{ model: "a/target", thinking: "low" },
				{ thinking: "high" },
				"a/base",
				"minimal",
				"a/target:low",
			],
			[
				"the agent level wins over the parent level",
				{ model: "a/target" },
				{ thinking: "high" },
				"a/base",
				"minimal",
				"a/target:high",
			],
			["the parent level is the last fallback", { model: "a/target" }, null, "a/base", "minimal", "a/target:minimal"],
			[
				"a restricted model refuses an inherited level the list does not name",
				{ model: "a/target" },
				{ thinking: "medium", allowedModels: "a/target:low, a/target:high" },
				"a/base",
				"minimal",
				REFUSED,
			],
			[
				"a restricted model keeps an inherited level the list names",
				{ model: "a/target" },
				{ thinking: "high", allowedModels: "a/target:low, a/target:high" },
				"a/base",
				"minimal",
				"a/target:high",
			],
			[
				"a restricted model takes the thinking parameter",
				{ model: "a/target", thinking: "low" },
				{ thinking: "high", allowedModels: "a/target:low, a/target:high" },
				"a/base",
				"minimal",
				"a/target:low",
			],
			["an unknown qualified id", { model: "a/nope" }, null, "a/base", "low", REFUSED],
		];
	for (const [title, params, agentDefs, parentModelRef, parentThinking, expected] of LAUNCHES) {
		it(`launch: ${title}`, async () => {
			assert.equal(await launchRef(params, agentDefs, parentModelRef, parentThinking), expected);
		});
	}

	it("resume: a model without a level keeps the prior run's level", () => {
		const fields = {
			modelRef: "a/target:low",
			model: "a/target",
			thinking: "low",
			definitionThinking: "high",
			allowedModels: "a/target:low, a/target:high",
		};
		assert.equal(resumeRef(fields, "a/target"), "a/target:low");
	});

	it("resume: a bare id at two providers takes the prior run's provider", () => {
		assert.equal(resumeRef({ modelRef: "b/mini:low", model: "b/mini", thinking: "low" }, "base"), "b/base:low");
	});

	it("resume: a thinking-only resume keeps the persisted model and its level", () => {
		assert.equal(
			resumeRef({ modelRef: "a/target:low", model: "a/target", thinking: "low" }, undefined, "high"),
			"a/target:low",
		);
	});
});

describe("model fragments only as fallback (D08)", () => {
	it("launch: a fragment with no exact id resolves", async () => {
		assert.equal(await launchRef({ model: "targ" }, null, "a/base", "low"), "a/target:low");
		assert.equal(await launchRef({ model: "b/mi" }, { allowedModels: "b/mini" }, "a/base", "low"), "b/mini:low");
	});

	it("resume: a fragment with no exact id resolves", () => {
		assert.equal(resumeRef({ modelRef: "a/base:low", model: "a/base", thinking: "low" }, "targ"), "a/target:low");
	});

	it("launch: a literal id with a non-level colon stays whole", async () => {
		assert.equal(await launchRef({ model: "c/advanced:rev1" }, null, "a/base", "low"), "c/advanced:rev1:low");
	});
});

describe("resume replays the invocation ref (D08)", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	afterEach(() => {
		if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	});

	it("passes Pi the bare default the first launch passed, not the qualified display ref", async () => {
		const dir = createTestDir();
		mkdirSync(join(dir, "agents"), { recursive: true });
		writeFileSync(join(dir, "agents", "picker.md"), "---\nname: picker\nmodel: target\n---\n\nPicker.");
		process.env.PI_CODING_AGENT_DIR = dir;
		const params = { name: "n", title: "N", task: "t", agent: "picker" };
		const prepared = await prepareSubagentLaunch(params, {
			cwd: dir,
			modelRegistry,
			parentModelRef: "b/mini",
			parentThinking: "low",
			sessionManager: { getSessionFile: () => join(dir, "parent.jsonl"), getSessionId: () => "parent" },
		});
		const metadata = buildPersistedSubagentLaunchMetadata(prepared, params, "background", "lineage-only", false);
		const args = await getPersistedSessionParityArgs(metadata);
		// cf6dbf4 persisted and replayed the ref it passed to Pi: `target:low`.
		assert.equal(args[args.indexOf("--model") + 1], "target:low");
	});
});
