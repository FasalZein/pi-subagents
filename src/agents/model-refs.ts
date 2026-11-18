import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";

export function parseAllowedModels(raw: string | undefined): string[] {
	if (!raw?.trim()) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

const PI_THINKING_LEVELS: readonly string[] = MODEL_THINKING_LEVELS;

/**
 * Split Pi's provider/model[:thinking] syntax. Only a known Pi thinking level
 * counts as a suffix: registry ids such as `name:free` or `name:0` stay whole.
 */
export function splitModelRef(ref: string): {
	model: string;
	thinking?: string;
} {
	const idx = ref.lastIndexOf(":");
	if (idx === -1 || !PI_THINKING_LEVELS.includes(ref.slice(idx + 1))) return { model: ref };
	return { model: ref.slice(0, idx), thinking: ref.slice(idx + 1) };
}

/**
 * Combine a model and a separate thinking level into one ref. If the model
 * string already carries a valid thinking suffix, it wins and `thinking` is
 * ignored. Returns undefined when no model is given.
 */
export function buildModelRef(model: string | undefined, thinking: string | undefined): string | undefined {
	const trimmedModel = model?.trim();
	if (!trimmedModel) return undefined;
	if (splitModelRef(trimmedModel).thinking) return trimmedModel;
	const trimmedThinking = thinking?.trim();
	return trimmedThinking ? `${trimmedModel}:${trimmedThinking}` : trimmedModel;
}

function isModelAllowed(effectiveModelRef: string, allowedModelRef: string): boolean {
	const effective = splitModelRef(effectiveModelRef);
	const allowed = splitModelRef(allowedModelRef);
	if (allowed.model !== effective.model) return false;
	return !allowed.thinking || allowed.thinking === effective.thinking;
}

export function assertModelAllowed(
	effectiveModelRef: string | undefined,
	allowedModelsRaw: string | undefined,
	agentName: string | undefined,
	implicitAllowedModelRefs: string[] = [],
): void {
	const explicitAllowedModels = parseAllowedModels(allowedModelsRaw);
	if (explicitAllowedModels.length === 0) return;
	const allowedModels = [...implicitAllowedModelRefs.filter(Boolean), ...explicitAllowedModels];
	if (!effectiveModelRef) {
		throw new Error(`Agent '${agentName ?? "subagent"}' defines allowed-models but no model was resolved.`);
	}
	if (allowedModels.some((entry) => isModelAllowed(effectiveModelRef, entry))) return;
	throw new Error(
		`Model '${effectiveModelRef}' is not allowed for agent '${agentName ?? "subagent"}'. ` +
			`Allowed models: ${allowedModels.join(", ")}.`,
	);
}

/** Most candidates a refusal names (D22); the rest is counted, not listed. */
const MAX_REFUSAL_CANDIDATES = 8;

export interface ModelChoiceRequest {
	/** The model from the call: an exact ref, `provider/fragment` or a bare fragment, with an optional `:thinking`. */
	requested: string;
	/** The thinking parameter of the call. A `:thinking` suffix on `requested` wins over it. */
	requestedThinking?: string;
	/** The agent's accepted refs, its default ref included. Empty means the agent has no accepted list. */
	accepted: readonly string[];
	/** Pi's known models, searched only when `accepted` is empty. Ids stay whole, colons included. */
	known: ReadonlyArray<{ provider: string; id: string }>;
	/**
	 * The agent's own default ref; its provider settles a fragment that matches
	 * under several providers. A model inherited from the parent is not a default.
	 */
	defaultRef?: string;
	/** The agent's default thinking level, picked when the accepted list names it for the chosen model. */
	defaultThinking?: string;
	/** The thinking level used when neither the call nor the accepted list fixes one. */
	fallbackThinking?: string;
	agentName?: string;
}

export interface ModelChoice {
	/** `provider/id` without thinking. */
	model: string;
	thinking: string | undefined;
	/** True when the call or the accepted list fixed the level; false when it is only a fallback. */
	explicitThinking: boolean;
}

function providerOf(modelKey: string): string | undefined {
	const slash = modelKey.indexOf("/");
	return slash === -1 ? undefined : modelKey.slice(0, slash);
}

/** Group refs by `provider/id`, in list order, with the thinking levels each one lists. */
function groupRefsByModel(refs: readonly string[]): Map<string, Array<string | undefined>> {
	const groups = new Map<string, Array<string | undefined>>();
	for (const ref of refs) {
		const { model, thinking } = splitModelRef(ref);
		const levels = groups.get(model) ?? [];
		if (!levels.includes(thinking)) levels.push(thinking);
		groups.set(model, levels);
	}
	return groups;
}

/** Refs grouped by provider in list order, as `provider: a, b; other: c`; a ref without a provider stands alone. */
export function formatRefsByProvider(refs: readonly string[]): string {
	const byProvider = new Map<string, string[]>();
	for (const ref of refs) {
		const provider = providerOf(ref) ?? "";
		const names = byProvider.get(provider) ?? [];
		names.push(provider ? ref.slice(provider.length + 1) : ref);
		byProvider.set(provider, names);
	}
	return [...byProvider].map(([provider, names]) => (provider ? `${provider}: ` : "") + names.join(", ")).join("; ");
}

function formatCandidates(refs: readonly string[]): string {
	if (refs.length === 0) return "";
	const hidden = refs.length - MAX_REFUSAL_CANDIDATES;
	return ` Candidates: ${formatRefsByProvider(refs.slice(0, MAX_REFUSAL_CANDIDATES))}${hidden > 0 ? ` (+${hidden} more)` : ""}.`;
}

function refuseModel(request: ModelChoiceRequest, reason: string, candidates: readonly string[]): never {
	const agent = request.agentName ?? "subagent";
	const head =
		request.accepted.length > 0
			? `Model '${request.requested}' is not allowed for agent '${agent}'`
			: `Unknown model override '${request.requested}'`;
	const pointer = request.agentName
		? ` Call subagent_agents with name '${request.agentName}' for its accepted models.`
		: " Call subagent_agents for the accepted models.";
	throw new Error(`${head}: ${reason}.${formatCandidates(candidates)}${pointer}`);
}

/**
 * Resolve the model named in a launch or resume call (D22). An exact ref
 * wins; otherwise the provider part must be equal and the model part may be
 * a fragment. The search runs inside the accepted list, or inside Pi's known
 * models when the agent has no accepted list. Every refusal throws.
 */
export function resolveModelChoice(request: ModelChoiceRequest): ModelChoice {
	const restricted = request.accepted.length > 0;
	const pool = restricted
		? groupRefsByModel(request.accepted)
		: new Map(request.known.map((model): [string, Array<string | undefined>] => [`${model.provider}/${model.id}`, [undefined]]));
	const { model: name, thinking: suffixThinking } = splitRequestedRef(request.requested, pool);
	const askedThinking = suffixThinking ?? request.requestedThinking;
	// No accepted list and no known models: leave the name to Pi, as before.
	if (pool.size === 0) {
		return { model: name, thinking: askedThinking ?? request.fallbackThinking, explicitThinking: !!askedThinking };
	}
	const chosen = pool.has(name) ? name : matchFragment(request, name, pool, restricted);
	const levels = pool.get(chosen) ?? [undefined];
	const listedLevels = levels.filter((level): level is string => level !== undefined);
	// A ref without a level accepts every level of its model.
	if (!restricted || listedLevels.length < levels.length) {
		return {
			model: chosen,
			thinking: askedThinking ?? request.fallbackThinking,
			explicitThinking: !!askedThinking,
		};
	}
	if (askedThinking) {
		if (listedLevels.includes(askedThinking)) return { model: chosen, thinking: askedThinking, explicitThinking: true };
		refuseModel(
			request,
			`thinking level '${askedThinking}' is not accepted for '${chosen}'`,
			listedLevels.map((level) => `${chosen}:${level}`),
		);
	}
	const defaultLevel =
		request.defaultThinking && listedLevels.includes(request.defaultThinking)
			? request.defaultThinking
			: listedLevels[0];
	return { model: chosen, thinking: defaultLevel, explicitThinking: true };
}

/**
 * Split the call's ref against the pool: a whole pool key stays whole, colons
 * included. A suffix after a known model is its level even when Pi does not
 * know it, so the refusal names the unsupported level.
 */
function splitRequestedRef(ref: string, pool: Map<string, unknown>): { model: string; thinking?: string } {
	if (pool.has(ref)) return { model: ref };
	const idx = ref.lastIndexOf(":");
	if (idx !== -1 && pool.has(ref.slice(0, idx))) return { model: ref.slice(0, idx), thinking: ref.slice(idx + 1) };
	return splitModelRef(ref);
}

function matchFragment(
	request: ModelChoiceRequest,
	name: string,
	pool: Map<string, Array<string | undefined>>,
	restricted: boolean,
): string {
	const provider = providerOf(name);
	const fragment = provider === undefined ? name : name.slice(provider.length + 1);
	const keys = [...pool.keys()];
	// Only an exact full ref is a fast path (resolveModelChoice); an unqualified id is a fragment like any other.
	let matches = keys.filter(
		(key) =>
			(provider === undefined || providerOf(key) === provider) && key.slice(key.indexOf("/") + 1).includes(fragment),
	);
	if (matches.length === 0) {
		refuseModel(request, `no ${restricted ? "accepted" : "known"} model matches`, restricted ? keys : []);
	}
	if (new Set(matches.map(providerOf)).size > 1) {
		const defaultProvider = request.defaultRef ? providerOf(splitModelRef(request.defaultRef).model) : undefined;
		const underDefault = matches.filter((key) => providerOf(key) === defaultProvider);
		if (underDefault.length === 0) {
			refuseModel(
				request,
				`it matches under several providers and the default provider '${defaultProvider ?? "none"}' is not among them`,
				matches,
			);
		}
		matches = underDefault;
	}
	if (matches.length > 1) refuseModel(request, "it matches several models of one provider", matches);
	return matches[0] as string;
}
