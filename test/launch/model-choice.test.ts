import type { AgentDefaults } from "../../src/agents/definitions.ts";
import { buildChildLaunchPlan } from "../../src/launch/child-launch-plan.ts";
import { enforceAgentFrontmatter } from "../../src/launch/policy.ts";
import { resolveResumeLaunchMetadataForInvocation } from "../../src/runtime/resume-service.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import { getChildLaunchWarning, getIgnoredModelOverrideWarning } from "../../src/tools/policy.ts";
import { assert, createTestDir, describe, it, join } from "../support/index.ts";

/**
 * D22: a short model name in a launch or resume call resolves inside the
 * agent's accepted list. Synthetic refs only: no real provider or model names.
 */
function registry(refs: string[]) {
	return {
		getAvailable: () =>
			refs.map((ref) => {
				const [provider, id] = ref.split("/") as [string, string];
				return { provider, id, reasoning: true };
			}),
	};
}

async function launchModel(
	model: string | undefined,
	agentDefs: AgentDefaults | null,
	known: string[],
	extra: { thinking?: string; parentModelRef?: string } = {},
) {
	const cwd = createTestDir();
	const plan = await buildChildLaunchPlan({
		params: {
			name: "model-pick",
			task: "t",
			title: "Model pick",
			agent: "picker",
			model,
			thinking: extra.thinking,
		},
		agentDefs,
		parentCwd: cwd,
		parentSessionDir: join(cwd, "parent-sessions"),
		parentModelRef: extra.parentModelRef,
		modelRegistry: registry(known),
	});
	return plan.effectiveModelRef;
}

const KNOWN = [
	"synthetic-a/alpha-mini",
	"synthetic-a/alpha-max",
	"synthetic-b/alpha-pro",
	"synthetic-b/beta",
	"synthetic-c/gamma",
];

describe("short model names (D22)", () => {
	it("resolves a provider plus a fragment to the one accepted ref of that provider", async () => {
		const ref = await launchModel(
			"synthetic-b/pro",
			{
				model: "synthetic-c/gamma",
				allowedModels: "synthetic-a/alpha-mini,synthetic-b/alpha-pro",
			},
			KNOWN,
		);
		assert.equal(ref, "synthetic-b/alpha-pro");
	});

	it("settles a fragment under two providers by the provider of the agent default", async () => {
		const defs = {
			model: "synthetic-b/beta",
			allowedModels: "synthetic-a/alpha-mini,synthetic-b/alpha-pro",
		};
		assert.equal(await launchModel("alpha", defs, KNOWN), "synthetic-b/alpha-pro");
	});

	it("refuses a fragment under two providers when the default provider does not match", async () => {
		await assert.rejects(
			() =>
				launchModel(
					"alpha",
					{
						model: "synthetic-c/gamma",
						allowedModels: "synthetic-a/alpha-mini,synthetic-b/alpha-pro",
					},
					KNOWN,
				),
			(error: Error) => {
				assert.match(error.message, /Model 'alpha' is not allowed for agent 'picker'/);
				assert.match(error.message, /default provider 'synthetic-c' is not among them/);
				assert.match(error.message, /Candidates: synthetic-a: alpha-mini; synthetic-b: alpha-pro\./);
				return true;
			},
		);
	});

	it("refuses a fragment that matches two models of one provider and names both", async () => {
		await assert.rejects(
			() =>
				launchModel(
					"synthetic-a/alpha",
					{
						model: "synthetic-c/gamma",
						allowedModels: "synthetic-a/alpha-mini,synthetic-a/alpha-max",
					},
					KNOWN,
				),
			/several models of one provider\. Candidates: synthetic-a: alpha-mini, alpha-max\./,
		);
	});

	it("lets the thinking parameter pick among listed levels", async () => {
		const defs = {
			model: "synthetic-c/gamma:low",
			allowedModels: "synthetic-a/alpha-mini:medium,synthetic-a/alpha-mini:high",
		};
		assert.equal(await launchModel("alpha-mini", defs, KNOWN, { thinking: "high" }), "synthetic-a/alpha-mini:high");
		assert.equal(await launchModel("alpha-mini:medium", defs, KNOWN), "synthetic-a/alpha-mini:medium");
		await assert.rejects(
			() => launchModel("alpha-mini", defs, KNOWN, { thinking: "minimal" }),
			/thinking level 'minimal' is not accepted for 'synthetic-a\/alpha-mini'\. Candidates: synthetic-a: alpha-mini:medium, alpha-mini:high\./,
		);
	});

	it("takes the default level when the list accepts it, else the first listed level", async () => {
		const list = "synthetic-a/alpha-mini:medium,synthetic-a/alpha-mini:high";
		assert.equal(
			await launchModel("alpha-mini", { model: "synthetic-c/gamma", thinking: "high", allowedModels: list }, KNOWN),
			"synthetic-a/alpha-mini:high",
		);
		assert.equal(
			await launchModel("alpha-mini", { model: "synthetic-c/gamma", thinking: "low", allowedModels: list }, KNOWN),
			"synthetic-a/alpha-mini:medium",
		);
	});

	it("names at most 8 candidates grouped by provider and points to subagent_agents", async () => {
		const accepted = [
			...Array.from({ length: 6 }, (_, i) => `synthetic-a/model-${i}`),
			...Array.from({ length: 5 }, (_, i) => `synthetic-b/model-${i}`),
		];
		await assert.rejects(
			() => launchModel("nothing", { model: "synthetic-a/model-0", allowedModels: accepted.join(",") }, accepted),
			(error: Error) => {
				assert.match(
					error.message,
					/Candidates: synthetic-a: model-0, model-1, model-2, model-3, model-4, model-5; synthetic-b: model-0, model-1 \(\+3 more\)\./,
				);
				assert.match(error.message, /Call subagent_agents with name 'picker' for its accepted models\./);
				return true;
			},
		);
	});

	it("names only matching candidates when the agent has no accepted list", async () => {
		await assert.rejects(
			() => launchModel("synthetic-a/nothing", null, KNOWN),
			(error: Error) => {
				assert.match(
					error.message,
					/^Unknown model override 'synthetic-a\/nothing': no known model matches\. Call subagent_agents/,
				);
				assert.doesNotMatch(error.message, /Candidates/);
				return true;
			},
		);
		await assert.rejects(
			() =>
				launchModel("alpha", null, KNOWN, {
					parentModelRef: "synthetic-c/gamma",
				}),
			/Candidates: synthetic-a: alpha-mini, alpha-max; synthetic-b: alpha-pro\./,
		);
		assert.equal(await launchModel("synthetic-b/pro", null, KNOWN), "synthetic-b/alpha-pro");
	});

	it("runs an agent with no accepted list and no default on the parent's model", async () => {
		assert.equal(
			await launchModel(undefined, {}, KNOWN, {
				parentModelRef: "synthetic-c/gamma",
			}),
			"synthetic-c/gamma",
		);
	});

	it("ignores a call model when the override switch is off and says so in the reply", () => {
		const defs = { model: "synthetic-c/gamma", allowModelOverride: false };
		const params = {
			name: "model-pick",
			task: "t",
			title: "Model pick",
			agent: "picker",
			model: "alpha",
			thinking: "high",
		};
		const enforced = enforceAgentFrontmatter(params, defs);
		assert.equal(enforced.model, undefined);
		assert.equal(enforced.thinking, undefined);
		const warning = getChildLaunchWarning(params, defs, false);
		assert.match(
			warning,
			/agent 'picker' sets allow-model-override: false; model 'alpha' and thinking 'high' from the call ignored/,
		);
		assert.equal(getChildLaunchWarning(params, { model: "synthetic-c/gamma" }, false), "");
	});

	it("applies the same rules to a resume with a model", () => {
		const metadata: PersistedSubagentLaunchMetadata = {
			version: 1,
			timestamp: "2026-11-18T00:00:00.000Z",
			name: "model-pick",
			agent: "picker",
			mode: "background",
			sessionMode: "lineage-only",
			parentClosePolicy: "terminate",
			async: true,
			model: "synthetic-b/beta",
			modelRef: "synthetic-b/beta",
			definitionModel: "synthetic-b/beta",
			allowedModels: "synthetic-a/alpha-mini,synthetic-b/alpha-pro",
			allowModelOverride: true,
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: "/tmp",
			cwd: "/tmp",
			boundarySystemPrompt: true,
		};
		const known = registry(KNOWN);
		assert.equal(
			resolveResumeLaunchMetadataForInvocation(metadata, "alpha", undefined, known)?.modelRef,
			"synthetic-b/alpha-pro",
		);
		assert.equal(
			resolveResumeLaunchMetadataForInvocation(metadata, "synthetic-a/mini", undefined, known)?.modelRef,
			"synthetic-a/alpha-mini",
		);
		assert.throws(
			() => resolveResumeLaunchMetadataForInvocation(metadata, "gamma", undefined, known),
			/Model 'gamma' is not allowed for agent 'picker': no accepted model matches\./,
		);
		const ignored = resolveResumeLaunchMetadataForInvocation(
			{ ...metadata, allowModelOverride: false },
			"alpha",
			undefined,
			known,
		);
		assert.equal(ignored?.modelRef, "synthetic-b/beta");
		assert.equal(ignored?.ignoredModelOverride, "alpha");
		assert.match(
			getIgnoredModelOverrideWarning("picker", false, { model: "alpha" }) ?? "",
			/model 'alpha' from the call ignored/,
		);
	});
});
