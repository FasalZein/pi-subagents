import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { resolveCliModel } from "@earendil-works/pi-coding-agent";
import { type ModelRegistryLike, resolveLaunchModel } from "../launch/child-launch-plan.ts";
import type { AgentListEntry } from "./agent-list.ts";

/** The parent's model at the time of the call, which an agent without a default inherits (D22). */
export interface ParentModel {
	registry?: ModelRegistryLike;
	/** provider/id of the session model, without a level. */
	ref?: string;
	thinking?: string;
}

/** What the detail says about the default: its line, and the default ref when a call can name it. */
export interface DefaultModelView {
	line: string;
	/** The ref that runs like a launch without a model; it counts as accepted (D22). */
	usableRef?: string;
	/** Set when every launch fails while the launch computes the default's grant. */
	grantError?: string;
}

/** The model and level Pi runs for a `--model` argument, or Pi's refusal. */
type PiRun = { ref: string; reasoning: boolean; level: string | undefined } | { error: string };

/**
 * Pi's own resolution of the child's `--model` argument (resolveCliModel) and
 * its level clamp (sdk.js clampThinkingLevel), over the parent's available
 * models, every one counted as authenticated. Without a level Pi takes its
 * settings default, which the parent cannot know, unless the model has no
 * reasoning, where every level clamps to off.
 */
function piRun(arg: string, registry: ModelRegistryLike): PiRun {
	const result = resolveCliModel({
		cliModel: arg,
		modelRuntime: { getModels: () => registry.getAvailable(), hasConfiguredAuth: () => true },
	} as unknown as Parameters<typeof resolveCliModel>[0]);
	if (!result.model) return { error: result.error ?? `Pi resolves no model for "${arg}".` };
	const model = result.model;
	const level = result.thinkingLevel
		? clampThinkingLevel(model, result.thinkingLevel)
		: model.reasoning
			? undefined
			: "off";
	return { ref: `${model.provider}/${model.id}`, reasoning: model.reasoning === true, level };
}

/** What a launch of this agent runs: the launch resolver's `--model` (prep.ts getPreparedModel), then Pi. */
function launchRun(entry: AgentListEntry, parent: ParentModel, registry: ModelRegistryLike, model?: string): PiRun {
	const { effectiveModel, effectiveThinking } = resolveLaunchModel({
		params: { agent: entry.name, ...(model ? { model } : {}) },
		agentDefs: { model: entry.model, thinking: entry.thinking, allowedModels: entry.allowedModels },
		modelRegistry: registry,
		parentModelRef: parent.ref,
		parentThinking: parent.thinking,
	});
	if (!effectiveModel) return { error: "The launch passes no model." };
	return piRun(effectiveThinking ? `${effectiveModel}:${effectiveThinking}` : effectiveModel, registry);
}

const sameRun = (a: PiRun, b: PiRun) => "ref" in a && "ref" in b && a.ref === b.ref && a.level === b.level;

/**
 * The default model of the detail (D20, D22, T86). A ref is shown only when a
 * launch that names it runs on the same model at the same level as a launch
 * without a model; otherwise the line says what a launch without a model
 * does. Without a registry nothing can be checked, and the launch resolver's
 * ref is shown as it is.
 */
export function describeDefaultModel(entry: AgentListEntry, parent: ParentModel): DefaultModelView {
	const registry = parent.registry;
	const plan = () =>
		resolveLaunchModel({
			params: { agent: entry.name },
			agentDefs: { model: entry.model, thinking: entry.thinking, allowedModels: entry.allowedModels },
			modelRegistry: registry,
			parentModelRef: parent.ref,
			parentThinking: parent.thinking,
		});
	let planned: ReturnType<typeof plan>;
	try {
		planned = plan();
	} catch (error) {
		const message = (error as Error).message;
		return { line: `default model: none, a launch without a model fails: ${message}`, grantError: message };
	}
	if (!planned.effectiveModelRef) return { line: "default model: the parent's model" };
	if (!registry || registry.getAvailable().length === 0)
		return { line: `default model: ${planned.effectiveModelRef}`, usableRef: planned.effectiveModelRef };
	const implicit = launchRun(entry, parent, registry);
	if ("error" in implicit)
		return { line: `default model: ${planned.effectiveModelRef} (a launch without a model fails: ${implicit.error})` };
	const { ref, level } = implicit;
	// A non-reasoning model runs at off with or without a level; prefer the ref without one.
	const candidates = implicit.reasoning ? [level ? `${ref}:${level}` : ref] : [ref, `${ref}:off`];
	let otherLevel: string | undefined;
	for (const candidate of candidates) {
		let run: PiRun;
		try {
			run = launchRun(entry, parent, registry, candidate);
		} catch {
			continue; // The launch refuses this ref, for example an accepted list that grants another level.
		}
		if (sameRun(run, implicit)) return { line: `default model: ${candidate}`, usableRef: candidate };
		if ("ref" in run) otherLevel ??= run.level ?? "Pi's default";
	}
	// The refusal text would list the default's grant ref, which no call can use, so it is not quoted.
	const named = otherLevel ? `runs at level ${otherLevel}` : "is refused";
	return {
		line: `default model: ${ref} at level ${level ?? "Pi's default"} (a launch without a model runs on it; a call that names it ${named}, so leave the model out)`,
	};
}
