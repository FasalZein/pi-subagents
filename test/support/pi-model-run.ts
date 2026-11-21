import { strict as assert } from "node:assert";
import { join } from "node:path";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { resolveCliModel } from "@earendil-works/pi-coding-agent";
import type { AgentDefaults } from "../../src/agents/definitions.ts";
import { buildChildLaunchPlan, type ModelRegistryLike } from "../../src/launch/child-launch-plan.ts";

/**
 * The reference for what a child runs on (T86): the launch plan gives Pi
 * `--model <model>[:<level>]` (prep.ts getPreparedModel), and Pi resolves it with
 * resolveCliModel and clamps the level (Pi 1.5.2 model-resolver.js, sdk.js
 * clampThinkingLevel). Synthetic refs only.
 */
export type Model = { provider: string; id: string; reasoning: boolean; thinkingLevelMap?: Record<string, string> };
export const registryOf = (models: Model[]): ModelRegistryLike => ({ getAvailable: () => models });
export const NON_REASONING_BASE = registryOf([
	{ provider: "a", id: "base", reasoning: false },
	{ provider: "other", id: "x", reasoning: true },
]);
export const TWO_BASES = registryOf([
	{ provider: "a", id: "base", reasoning: true },
	{ provider: "b", id: "base", reasoning: true },
	{ provider: "other", id: "x", reasoning: true },
]);
// A reasoning model without an xhigh mapping supports off to high (pi-ai getSupportedThinkingLevels).
export const HIGH_AT_MOST = registryOf([{ provider: "a", id: "think", reasoning: true }]);

export interface Parent {
	ref: string;
	thinking?: string;
}

/** What Pi runs for a `--model` argument: the model and its level, or Pi's refusal. */
export type PiRun = { ref: string; level: string | undefined } | { error: string };

export function piRun(arg: string, registry: ModelRegistryLike): PiRun {
	const result = resolveCliModel({
		cliModel: arg,
		modelRuntime: { getModels: () => registry.getAvailable(), hasConfiguredAuth: () => true },
	} as unknown as Parameters<typeof resolveCliModel>[0]);
	if (!result.model) return { error: result.error ?? "no model" };
	const model = result.model as unknown as Parameters<typeof clampThinkingLevel>[0];
	// Without a level Pi takes the settings default, unknown here; a non-reasoning model clamps any level to off.
	const level = result.thinkingLevel
		? clampThinkingLevel(model, result.thinkingLevel as never)
		: model.reasoning
			? undefined
			: "off";
	return { ref: `${result.model.provider}/${result.model.id}`, level };
}

export type Launch = { run: PiRun } | { refused: string };

/** A launch of the agent with or without a model: Pi's run, or the launch refusal. */
export async function launch(
	definition: AgentDefaults | null,
	dir: string,
	registry: ModelRegistryLike,
	parent: Parent,
	model?: string,
): Promise<Launch> {
	try {
		const plan = await buildChildLaunchPlan({
			params: { name: "n", title: "N", task: "t", agent: "picker", ...(model ? { model } : {}) },
			agentDefs: definition,
			parentCwd: dir,
			parentSessionDir: join(dir, "parent-sessions"),
			modelRegistry: registry,
			parentModelRef: parent.ref,
			parentThinking: parent.thinking,
		});
		const arg = plan.effectiveThinking ? `${plan.effectiveModel}:${plan.effectiveThinking}` : plan.effectiveModel;
		assert.ok(arg, "every case has a model");
		return { run: piRun(arg, registry) };
	} catch (error) {
		return { refused: (error as Error).message };
	}
}
