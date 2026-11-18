import { type ModelRegistryLike, normalizeModelRef, resolveImplicitModelGrant } from "../launch/child-launch-plan.ts";
import { resolveSubagentTimeoutState } from "../launch/policy.ts";
import { formatTimeoutSeconds } from "../runtime/timeout-budget.ts";
import { type ParsedSpawnEnv, resolveSpawnPolicy } from "../spawn/policy.ts";
import {
	getContextReminderThresholds,
	parseContextWarnStep,
	parseContextWarnThreshold,
} from "../tools/context-reminders.ts";
import { type AgentListEntry, describeVerifiedFanOut } from "./agent-list.ts";
import type { IndexLaunchPolicy } from "./index-section.ts";
import { formatRefsByProvider, parseAllowedModels } from "./model-refs.ts";

/** The parent's model at the time of the call, which an agent without a default inherits (D22). */
export interface ParentModel {
	registry?: ModelRegistryLike;
	/** provider/id of the session model, without a level. */
	ref?: string;
	thinking?: string;
}

/** What the detail of one agent depends on besides its definition: the caller and its session. */
export interface AgentDetailContext {
	spawnEnv: ParsedSpawnEnv;
	launch: IndexLaunchPolicy;
	parentModel: ParentModel;
	/** Names the caller may launch; a helper's own grant shows only these. */
	visibleNames: ReadonlySet<string>;
}

/**
 * The default and accepted refs as the launch resolver computes them
 * (resolveImplicitModelGrant with the registry, the parent ref and the
 * effective level, as in buildChildLaunchPlan).
 */
function resolveModels(entry: AgentListEntry, parent: ParentModel): { defaultRef?: string; accepted?: string[] } {
	const fallbackThinking = entry.thinking ?? parent.thinking;
	const inheritedModelRef = entry.model ? undefined : normalizeModelRef(parent.ref, fallbackThinking).effectiveModelRef;
	const defaultRef = resolveImplicitModelGrant(
		{
			definitionModel: entry.model,
			definitionThinking: entry.thinking,
			allowedModels: entry.allowedModels,
			agentName: entry.name,
		},
		parent.registry,
		inheritedModelRef,
		fallbackThinking,
	);
	const allowed = parseAllowedModels(entry.allowedModels);
	if (allowed.length === 0) return { defaultRef };
	return { defaultRef, accepted: [...new Set([...(defaultRef ? [defaultRef] : []), ...allowed])] };
}

function renderModels(entry: AgentListEntry, parent: ParentModel): string[] {
	const { defaultRef, accepted } = resolveModels(entry, parent);
	const models =
		entry.allowModelOverride === false
			? "models: the default only (overrides are ignored)"
			: accepted
				? `models: ${formatRefsByProvider(accepted)}`
				: "models: any model ref";
	return [`default model: ${defaultRef ?? "the parent's model"}`, models];
}

const SESSION_MODES = {
	standalone: "fresh chat, needs a full brief",
	"lineage-only": "fresh chat linked to this session, needs a full brief",
	fork: "copy of this chat",
} as const satisfies Record<AgentListEntry["sessionMode"], string>;

/**
 * The kind and completion of a solo launch from this session, by the same
 * rules as the index flags (getFlags in index-section.ts): a headless or
 * forced-wait child always closes itself (applySynchronousLaunchPolicy).
 */
function renderChild(entry: AgentListEntry, launch: IndexLaunchPolicy): string {
	const verified = describeVerifiedFanOut(entry);
	const pane = launch.paneAvailable && entry.mode !== "background" && !verified;
	const closesItself = !pane || launch.forcesWait || entry.autoExit === true;
	return [
		`child: ${pane ? "pane" : "headless"}`,
		closesItself ? "closes itself" : "stays open until a human or the agent finishes",
		launch.forcesWait || entry.async === false ? "launch waits for the result" : "launch returns at once",
		...(verified ? [`verified fan-out (${verified})`] : []),
	].join(", ");
}

function renderTimeout(entry: AgentListEntry): string[] {
	const state = resolveSubagentTimeoutState(entry);
	const { timeoutSeconds, idleTimeoutSeconds } = state.timeoutBudget ?? {};
	if (!timeoutSeconds) return idleTimeoutSeconds ? [`idle-timeout ${formatTimeoutSeconds(idleTimeoutSeconds)}`] : [];
	const report =
		state.timeoutWarnThreshold !== undefined
			? ` (report at ${formatTimeoutSeconds(Math.floor((timeoutSeconds * state.timeoutWarnThreshold) / 100))})`
			: "";
	return [
		`timeout ${formatTimeoutSeconds(timeoutSeconds)}${report}${state.timeoutBlocksResume ? ", no resume after it" : ""}`,
		...(idleTimeoutSeconds ? [`idle-timeout ${formatTimeoutSeconds(idleTimeoutSeconds)}`] : []),
	];
}

function renderContextWarnings(entry: AgentListEntry): string | undefined {
	const start = parseContextWarnThreshold(entry.contextWarnThreshold);
	if (start === null) return undefined;
	const thresholds = getContextReminderThresholds(start, parseContextWarnStep(entry.contextWarnStep));
	return `context warnings at ${thresholds.map((percent) => `${percent}%`).join(", ")}`;
}

function renderLimits(entry: AgentListEntry): string {
	const limits = [
		...renderTimeout(entry),
		renderContextWarnings(entry),
		entry.reportContextUsage === false ? "token counts hidden" : undefined,
	].filter((limit): limit is string => limit !== undefined);
	return `limits: ${limits.length > 0 ? limits.join(", ") : "none"}`;
}

/**
 * The child's own launch grant, as prep.ts passes it to the child: the budget
 * left after this launch, the width, and the names the caller can also see.
 */
function renderMayLaunch(entry: AgentListEntry, context: AgentDetailContext): string {
	const { spawnEnv } = context;
	const grant = resolveSpawnPolicy({
		callerAgent: spawnEnv.callerAgent,
		targetAgent: entry.name,
		callerBudget: spawnEnv.callerBudget,
		callerSpawnable: spawnEnv.callerSpawnable,
		targetSpawning: entry.spawning,
		targetSpawnDepth: entry.spawnDepth,
		targetSpawnWidth: entry.spawnWidth,
		targetVisibleTo: entry.visibleTo,
		envDepthCeiling: spawnEnv.envDepthCeiling,
		envWidthCeiling: spawnEnv.envWidthCeiling,
	});
	if (grant.childBudget === null) return "may launch: none";
	const { spawnableAgents } = grant;
	if (spawnableAgents !== true && spawnableAgents.length === 0) return "may launch: none";
	// A name the caller cannot see is withheld, so a helper's grant never discloses it.
	const shown = spawnableAgents === true ? [] : spawnableAgents.filter((name) => context.visibleNames.has(name));
	const names =
		spawnableAgents === true ? "any agent" : shown.length > 0 ? shown.join(", ") : "no agent that you can see";
	const bounds = [
		`depth ${grant.childBudget}`,
		...(grant.effectiveWidth !== null ? [`width ${grant.effectiveWidth}`] : []),
	];
	return `may launch: ${names} (${bounds.join(", ")})`;
}

/** The full definition view of one agent (D20). */
export function renderAgentDetail(entry: AgentListEntry, context: AgentDetailContext): string {
	return [
		`${entry.name} (${entry.source}): ${(entry.description ?? "").trim()}`,
		...renderModels(entry, context.parentModel),
		renderChild(entry, context.launch),
		`session: ${SESSION_MODES[entry.sessionMode]}`,
		renderLimits(entry),
		renderMayLaunch(entry, context),
	].join("\n");
}
