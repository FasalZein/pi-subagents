export function parseAllowedModels(raw: string | undefined): string[] {
	if (!raw?.trim()) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/**
 * Mirrors MODEL_THINKING_LEVELS of @earendil-works/pi-ai (dist/providers/model-schema.js).
 * A local copy, because Pi's extension loader aliases the bare `@earendil-works/pi-ai` to one file,
 * so the subpath import does not resolve in an installed extension, and the bare entry does not export it.
 * test/agents/model-refs-thinking-levels.test.ts compares it with Pi's value.
 */
export const PI_THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

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

interface FragmentRequest {
	/** The model part of the call without its level: `provider/fragment` or a bare fragment. */
	requested: string;
	/** The agent's accepted refs, its default ref included. Empty means the agent has no accepted list. */
	accepted: readonly string[];
	/** Pi's known models, searched only when `accepted` is empty. Ids stay whole, colons included. */
	known: ReadonlyArray<{ provider: string; id: string }>;
	/**
	 * The agent's own default ref; its provider settles a fragment that matches
	 * under several providers. A model inherited from the parent is not a default.
	 */
	defaultRef?: string;
	agentName?: string;
}

function providerOf(modelKey: string): string | undefined {
	const slash = modelKey.indexOf("/");
	return slash === -1 ? undefined : modelKey.slice(0, slash);
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

function refuseModel(request: FragmentRequest, reason: string, candidates: readonly string[]): never {
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
 * Resolve a model fragment to one `provider/id` (D08, D22). The caller runs this
 * only when no exact id matches, so an exact id never becomes ambiguous here.
 * The provider part must be equal and the model part may be a fragment. The
 * search runs inside the accepted list, or inside Pi's known models when the
 * agent has no accepted list. Every refusal throws.
 */
export function matchModelFragment(request: FragmentRequest): string {
	const restricted = request.accepted.length > 0;
	const keys = restricted
		? [...new Set(request.accepted.map((ref) => splitModelRef(ref).model))]
		: request.known.map((model) => `${model.provider}/${model.id}`);
	const name = request.requested;
	const provider = providerOf(name);
	const fragment = provider === undefined ? name : name.slice(provider.length + 1);
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
