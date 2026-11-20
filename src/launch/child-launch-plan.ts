import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { AgentDefaults } from "../agents/definitions.ts";
import {
	assertModelAllowed,
	buildModelRef,
	matchModelFragment,
	parseAllowedModels,
	splitModelRef,
} from "../agents/model-refs.ts";
import { buildSubagentSessionTitle } from "../agents/titles.ts";
import { generateSubagentSessionFile, type ResumeMode } from "../session/session-files.ts";
import { addToolModeDeniedNames, resolveDenyTools } from "../tools/policy.ts";
import type { SubagentParamsInput } from "../types.ts";
import { resolveConfiguredExtensionSources } from "./extensions.ts";
import { resolveSubagentExtensions, resolveSubagentNoSession } from "./policy.ts";
import { type ResolvedSubagentRuntimePaths, resolveSubagentRuntimePaths } from "./runtime-paths.ts";
import { buildSkillLaunchPlan, type SkillLaunchPlan } from "./skills.ts";

export interface ModelRegistryLike {
	getAvailable(): Array<{
		provider: string;
		id: string;
		reasoning?: boolean;
		thinkingLevelMap?: Record<string, string | null | undefined>;
	}>;
}

interface ChildCapabilityPlan {
	tools?: string;
	skills?: string;
	injectSkills?: string;
	extensions?: string[];
	denySet: Set<string>;
	skillLaunchPlan: SkillLaunchPlan;
}

interface ChildLaunchPlan {
	agentDefs: AgentDefaults | null;
	effectiveModel?: string;
	effectiveThinking?: string;
	effectiveModelRef?: string;
	runtimePaths: ResolvedSubagentRuntimePaths;
	subagentSessionFile: string;
	sessionTitle?: string;
	capability: ChildCapabilityPlan;
}

interface ChildLaunchPlanOptions {
	params: SubagentParamsInput;
	agentDefs: AgentDefaults | null;
	parentCwd: string;
	parentSessionDir: string;
	modelRegistry?: ModelRegistryLike;
	parentModelRef?: string;
	parentThinking?: string;
	mode?: ResumeMode;
}

export function splitModelRefThinking(
	model: string | undefined,
	fallbackThinking: string | undefined,
): {
	model: string | undefined;
	thinking: string | undefined;
	explicitThinking: boolean;
} {
	if (!model) return { model, thinking: fallbackThinking, explicitThinking: false };
	const split = splitModelRef(model);
	return split.thinking === undefined
		? { model, thinking: fallbackThinking, explicitThinking: false }
		: { model: split.model, thinking: split.thinking, explicitThinking: true };
}

/**
 * Normalize model and thinking into a safe model ref.
 *
 * Handles two edge cases:
 * 1. When the model string already carries a `:thinking` suffix and an
 *    explicit thinking level is also set, strip the embedded suffix.
 * 2. When no model is available at all, suppress both thinking and modelRef.
 */
export function normalizeModelRef(
	model: string | undefined,
	thinking: string | undefined,
): {
	effectiveModel: string | undefined;
	effectiveThinking: string | undefined;
	effectiveModelRef: string | undefined;
} {
	if (!model) {
		return {
			effectiveModel: undefined,
			effectiveThinking: undefined,
			effectiveModelRef: undefined,
		};
	}
	let baseModel = model;
	if (thinking) baseModel = splitModelRef(model).model;
	const ref = thinking ? `${baseModel}:${thinking}` : baseModel;
	return {
		effectiveModel: baseModel,
		effectiveThinking: thinking,
		effectiveModelRef: ref,
	};
}

export function resolveAvailableModelRef(
	model: string | undefined,
	thinking: string | undefined,
	explicitThinking: boolean,
	modelRegistry: ModelRegistryLike | undefined,
	parentModelRef?: string,
): { model: string | undefined; thinking: string | undefined } {
	if (!model || !modelRegistry) return { model, thinking };
	const available = modelRegistry.getAvailable();
	if (available.length === 0) return { model, thinking };
	const [parentProvider] = parentModelRef?.split("/") ?? [];
	let resolved = model;
	let provider: string | undefined;
	let id: string;
	const slash = model.indexOf("/");
	if (slash === -1) {
		id = model;
		const matches = available.filter((candidate) => candidate.id === id);
		if (matches.length === 1) {
			provider = matches[0]?.provider;
			resolved = `${provider}/${id}`;
		} else if (matches.length > 1 && parentProvider) {
			const parentProviderMatch = matches.find((candidate) => candidate.provider === parentProvider);
			if (parentProviderMatch) {
				provider = parentProviderMatch.provider;
				resolved = `${provider}/${id}`;
			} else {
				throw new Error(`Ambiguous model override '${model}'. Use provider/model.`);
			}
		} else if (matches.length > 1) {
			throw new Error(`Ambiguous model override '${model}'. Use provider/model.`);
		} else {
			throw new Error(`Unknown model override '${model}'.`);
		}
	} else {
		provider = model.slice(0, slash);
		id = model.slice(slash + 1);
		const match = available.find((candidate) => candidate.provider === provider && candidate.id === id);
		if (!match) throw new Error(`Unknown model override '${model}'.`);
	}
	const match = available.find((candidate) => `${candidate.provider}/${candidate.id}` === resolved);
	if (thinking && match) {
		const supported = getSupportedThinkingLevels({
			...match,
			reasoning: match.reasoning !== false,
		} as Parameters<typeof getSupportedThinkingLevels>[0]) as string[];
		if (!supported.includes(thinking)) {
			if (!explicitThinking) return { model: resolved, thinking: undefined };
			throw new Error(
				`Model '${resolved}' does not support thinking level '${thinking}'. ` +
					`Supported levels: ${supported.join(", ")}.`,
			);
		}
	}
	return { model: resolved, thinking };
}

/** The agent's model settings as written in its definition (and persisted for resume). */
export interface AgentModelConfig {
	definitionModel?: string;
	definitionThinking?: string;
	allowedModels?: string;
	agentName?: string;
}

/**
 * The agent's own default ref. A model written without a provider resolves to
 * its one registry ref; an ambiguous or unknown one stays as written. The
 * thinking field applies when the model carries no level suffix.
 */
function resolveAgentDefaultRef(
	config: AgentModelConfig,
	modelRegistry: ModelRegistryLike | undefined,
): string | undefined {
	if (!config.definitionModel) return undefined;
	const { model, thinking } = splitModelRef(config.definitionModel);
	const matches = model.includes("/")
		? []
		: (modelRegistry?.getAvailable() ?? []).filter((candidate) => candidate.id === model);
	const resolved = matches.length === 1 ? `${matches[0]?.provider}/${model}` : model;
	return buildModelRef(resolved, thinking ?? config.definitionThinking);
}

/**
 * The one ref the agent's own default adds to its accepted list: the default
 * model at its effective level (its own level, else `effectiveThinking`), or
 * the inherited ref when the agent has no default. A model-wide grant would
 * accept the default model at every level.
 */
export function resolveImplicitModelGrant(
	config: AgentModelConfig,
	modelRegistry: ModelRegistryLike | undefined,
	inheritedModelRef: string | undefined,
	effectiveThinking: string | undefined,
): string | undefined {
	const defaultRef = resolveAgentDefaultRef(config, modelRegistry);
	return defaultRef ? buildModelRef(defaultRef, effectiveThinking) : inheritedModelRef;
}

interface CallModelRequest {
	/** The model of the launch or resume call. */
	model: string;
	/** The thinking parameter of the call. */
	thinking?: string;
	config: AgentModelConfig;
	/** The ref the child ran on without an agent default (the parent's model); accepted, never a provider source. */
	inheritedModelRef?: string;
	/** The level used when neither the call's model suffix nor its thinking parameter names one. */
	fallbackThinking?: string;
	/** The level of the default grant; defaults to `fallbackThinking`. */
	grantThinking?: string;
	/** Its provider breaks a tie when an exact bare id exists at several providers: the parent's model, or the prior run's on resume. */
	tieBreakRef?: string;
	modelRegistry?: ModelRegistryLike;
}

/** Whether Pi knows the model as an exact id; with no registry every name counts as exact. */
function hasExactModel(model: string, modelRegistry: ModelRegistryLike | undefined): boolean {
	const available = modelRegistry?.getAvailable() ?? [];
	if (available.length === 0) return true;
	const slash = model.indexOf("/");
	return slash === -1
		? available.some((candidate) => candidate.id === model)
		: available.some(
				(candidate) => candidate.provider === model.slice(0, slash) && candidate.id === model.slice(slash + 1),
			);
}

/**
 * Split the call's model and level against Pi's known ids: a whole known id
 * stays whole, colons included; a suffix after a known id is its level even
 * when Pi does not know the level, so the refusal names it (as v2.9.2).
 */
function splitCallModel(
	model: string,
	fallbackThinking: string | undefined,
	modelRegistry: ModelRegistryLike | undefined,
): ReturnType<typeof splitModelRefThinking> {
	if ((modelRegistry?.getAvailable().length ?? 0) > 0) {
		if (hasExactModel(model, modelRegistry)) return { model, thinking: fallbackThinking, explicitThinking: false };
		const idx = model.lastIndexOf(":");
		if (idx !== -1 && hasExactModel(model.slice(0, idx), modelRegistry)) {
			return { model: model.slice(0, idx), thinking: model.slice(idx + 1), explicitThinking: true };
		}
	}
	return splitModelRefThinking(model, fallbackThinking);
}

/**
 * Resolve the model of a launch or resume call (D08, D22). Exact ids, the
 * bare-id provider tie-break and level precedence follow v2.9.2: the call's
 * `:level` suffix, else its thinking parameter, else `fallbackThinking`; an
 * accepted list validates the level and never picks one. A fragment resolves
 * only when no exact id matches.
 *
 * Recorded limits:
 * - A bare default (`model: base`) that two registry providers carry stays unqualified in the grant, so an exact call for one of them can be refused.
 * - A literal registry id that ends in a known thinking level (`base:high`) is read as a model plus a level.
 */
export function resolveCallModelRef(request: CallModelRequest): ReturnType<typeof normalizeModelRef> {
	const implicitRef = resolveImplicitModelGrant(
		request.config,
		request.modelRegistry,
		request.inheritedModelRef,
		request.grantThinking ?? request.fallbackThinking,
	);
	const split = splitCallModel(request.model, request.thinking ?? request.fallbackThinking, request.modelRegistry);
	const explicitThinking = split.explicitThinking || request.thinking != null;
	let model = split.model as string;
	if (!hasExactModel(model, request.modelRegistry)) {
		const accepted = parseAllowedModels(request.config.allowedModels);
		model = matchModelFragment({
			requested: model,
			accepted: accepted.length > 0 && implicitRef ? [implicitRef, ...accepted] : accepted,
			known: request.modelRegistry?.getAvailable() ?? [],
			defaultRef: resolveAgentDefaultRef(request.config, request.modelRegistry),
			agentName: request.config.agentName,
		});
	}
	const available = resolveAvailableModelRef(
		model,
		split.thinking,
		explicitThinking,
		request.modelRegistry,
		request.tieBreakRef,
	);
	const resolved = normalizeModelRef(available.model, available.thinking);
	assertModelAllowed(
		resolved.effectiveModelRef,
		request.config.allowedModels,
		request.config.agentName,
		implicitRef ? [implicitRef] : [],
	);
	return resolved;
}

export async function buildChildLaunchPlan(options: ChildLaunchPlanOptions): Promise<ChildLaunchPlan> {
	const { params, agentDefs, parentCwd, parentSessionDir } = options;
	const hasAllowedModels = !!agentDefs?.allowedModels?.trim();
	const resolveRef = (
		model: string | undefined,
		fallbackThinking: string | undefined,
		opts: { resolveAlways: boolean; explicitThinking: boolean },
	): {
		effectiveModel?: string;
		effectiveThinking?: string;
		effectiveModelRef?: string;
	} => {
		const split = splitModelRefThinking(model, fallbackThinking);
		const explicit = split.explicitThinking || opts.explicitThinking;
		// Resolve a bare id (no provider) through the registry only when this is a
		// launch override or when this agent opts into allowed-models; otherwise
		// pass it through untouched so agents without the feature keep Pi's native
		// model resolution.
		const shouldResolve = !!split.model && (opts.resolveAlways || (hasAllowedModels && !split.model.includes("/")));
		const available = shouldResolve
			? resolveAvailableModelRef(split.model, split.thinking, explicit, options.modelRegistry, options.parentModelRef)
			: split;
		return normalizeModelRef(available.model, available.thinking);
	};

	const fallbackThinking = agentDefs?.thinking ?? options.parentThinking;
	const modelConfig: AgentModelConfig = {
		definitionModel: agentDefs?.model,
		definitionThinking: agentDefs?.thinking,
		allowedModels: agentDefs?.allowedModels,
		agentName: params.agent,
	};
	const inheritedModelRef = agentDefs?.model
		? undefined
		: normalizeModelRef(options.parentModelRef, fallbackThinking).effectiveModelRef;
	const resolveDefaultModel = () => {
		const ref = resolveRef(agentDefs?.model ?? options.parentModelRef, params.thinking ?? fallbackThinking, {
			resolveAlways: false,
			explicitThinking: params.thinking != null,
		});
		// With neither a model nor a thinking override, the grant resolves exactly as v2.9.2 did: the
		// parent's provider breaks a bare-id tie and an unsupported inherited level drops, so a default
		// that two providers carry is granted as the ref it runs on (M34). A thinking-only call keeps the
		// default at the inherited level, so that grant cannot widen to every level.
		const implicitRef =
			params.thinking == null
				? resolveRef(agentDefs?.model ?? options.parentModelRef, fallbackThinking, {
						resolveAlways: false,
						explicitThinking: false,
					}).effectiveModelRef
				: resolveImplicitModelGrant(modelConfig, options.modelRegistry, inheritedModelRef, fallbackThinking);
		if (hasAllowedModels) {
			assertModelAllowed(
				ref.effectiveModelRef,
				agentDefs?.allowedModels,
				params.agent,
				implicitRef ? [implicitRef] : [],
			);
		}
		// A bare default passes to Pi as written; the recorded ref names the one registry
		// ref Pi picks for it, or stays bare when the name is not unique (D23).
		if (ref.effectiveModel && !ref.effectiveModel.includes("/")) {
			const shown = resolveAgentDefaultRef(
				{ definitionModel: ref.effectiveModel, definitionThinking: ref.effectiveThinking },
				options.modelRegistry,
			);
			return { ...ref, effectiveModelRef: shown };
		}
		return ref;
	};
	const { effectiveModel, effectiveThinking, effectiveModelRef } =
		params.model != null
			? resolveCallModelRef({
					model: params.model,
					thinking: params.thinking,
					config: modelConfig,
					inheritedModelRef,
					fallbackThinking,
					tieBreakRef: options.parentModelRef,
					modelRegistry: options.modelRegistry,
				})
			: resolveDefaultModel();

	const runtimePaths = resolveSubagentRuntimePaths(params, agentDefs, parentCwd, parentSessionDir);
	const subagentSessionFile = generateSubagentSessionFile(
		resolveSubagentNoSession(agentDefs) ? join(tmpdir(), "pi-subagents", "sessions") : runtimePaths.sessionDir,
	);
	const tools = params.tools ?? agentDefs?.tools;
	const skills = params.skills ?? agentDefs?.skills;
	const injectSkills = agentDefs?.injectSkills;
	const extensionSources = resolveSubagentExtensions(agentDefs);
	// No list keeps the inherited set; a list passes to Pi as configured, unresolved entries included (D10).
	const extensions = resolveConfiguredExtensionSources(extensionSources, {
		cwd: runtimePaths.effectiveCwd ?? parentCwd,
		agentDir: runtimePaths.effectiveAgentConfigDir,
		agentDefs,
		mode: options.mode ?? "background",
	});
	const denySet = addToolModeDeniedNames(resolveDenyTools(agentDefs), tools);
	const skillLaunchPlan = await buildSkillLaunchPlan(
		skills,
		injectSkills,
		runtimePaths.effectiveCwd ?? parentCwd,
		runtimePaths.effectiveAgentConfigDir,
		extensions,
	);

	return {
		agentDefs,
		effectiveModel,
		effectiveThinking,
		effectiveModelRef,
		runtimePaths,
		subagentSessionFile,
		sessionTitle: buildSubagentSessionTitle(params),
		capability: {
			tools,
			skills,
			injectSkills,
			extensions,
			denySet,
			skillLaunchPlan,
		},
	};
}
