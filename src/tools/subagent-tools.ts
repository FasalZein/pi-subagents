import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentDefaults } from "../agents/definitions.ts";
import { type LaunchableAgent, nameOf, renderUnknownAgentRefusal } from "../agents/launchable-agents.ts";
import { stripInternalLaunchOverrides } from "../launch/launch-overrides.ts";
import { resolveVerifierCandidateCount } from "../vf/criteria.ts";
import {
	enforceAgentFrontmatter,
	getSubagentAgentRequirementError,
	resolveSubagentBlocking,
	shouldUseBackgroundLaunch,
} from "../launch/policy.ts";
import type { SubagentLaunchContext } from "../launch/prep.ts";
import { parseSpawnEnv, resolveSpawnPolicy } from "../spawn/policy.ts";
import { isRenderedResult, launchWarningLines } from "../runtime/run-result.ts";
import { asSubagentToolResult, getSubagentBatchStopMetadata, markSubagentBatchBlocking } from "../runtime/state.ts";
import {
	claimSpawnWidthSlot,
	getLiveSlotCount,
	getSpawnWidthLimit,
	releaseSpawnWidthSlotOnCompletion,
	type SpawnSlotLease,
	tryAcquireSlots,
} from "../runtime/spawn-width.ts";
import { getLaunchCapError, tryAcquireLaunchCapSlots } from "../runtime/launch-cap.ts";
import { launchVerifiedFanOut } from "../vf/run/launch.ts";
import type { RunningSubagent, SubagentParamsInput, SubagentResult } from "../types.ts";

import { formatSubagentBatchLines, formatTaskPreview, isFinishedStatus, renderSubagentCompletionText } from "./message-renderers.ts";
import { droppedExtensionLines } from "../launch/extension-entries.ts";
import { renderLaunchReply } from "./launch-reply.ts";
import { applySynchronousLaunchPolicy, getChildLaunchWarning } from "./policy.ts";
import { registerSetTabTitleTool } from "./set-tab-title.ts";
import { SET_TAB_TITLE_TOOL_NAME, SUBAGENT_TOOL_NAME } from "./tool-names.ts";

let initialPromptLaunchActive = isInitialPromptInvocation();

export const SubagentChildParams = Type.Object({
	agent: Type.String({ description: "Name of the agent definition to launch." }),
	name: Type.String({
		description: "Lower-kebab handle of 2 to 4 words and at most 32 characters, such as auth-scout or diff-reviewer.",
	}),
	title: Type.String({
		description: "Sentence-case title of 3 to 8 words for the child session, such as Auth implementation map.",
	}),
	task: Type.String({ description: "The work for this child, in Markdown for anything beyond one line." }),
	model: Type.Optional(
		Type.String({
			description:
				"Leave unset unless the user named a concrete model or thinking level for this launch; give provider/model, a model fragment, or a model name without a provider.",
		}),
	),
	thinking: Type.Optional(
		Type.String({ description: "Thinking level for this child, such as high; the rule for model applies." }),
	),
});

export const SubagentParams = Type.Object({
	children: Type.Array(SubagentChildParams, {
		minItems: 1,
		description: "The children to start in this one call, up to the spawn width.",
	}),
});

type ToolResult = ReturnType<typeof asSubagentToolResult>;

export interface SubagentToolRuntime {
	loadAgentDefaults(agentName: string | undefined, cwd: string): AgentDefaults | null;
	resolveEffectiveSessionMode(params: Partial<SubagentParamsInput>, defs: AgentDefaults | null): string;
	resolveTaskSessionMode(defs: AgentDefaults): string;
	launchBackgroundSubagent(params: SubagentParamsInput, ctx: SubagentLaunchContext): Promise<RunningSubagent>;
	launchSubagent(params: SubagentParamsInput, ctx: SubagentLaunchContext): Promise<RunningSubagent>;
	watchBackgroundSubagent(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult>;
	watchSubagent(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult>;
	getWatcherSignal(running: RunningSubagent, controller: AbortController): AbortSignal;
	wireSubagentSteerBack(pi: ExtensionAPI, running: RunningSubagent, promise: Promise<SubagentResult>): void;
	startWidgetRefresh(): void;
	getLaunchedSubagentResult(running: RunningSubagent, signal?: AbortSignal): Promise<ToolResult>;
	muxUnavailableResult(action: string): unknown;
	/** The agents this session may launch, read from the current files. */
	listLaunchableAgents(cwd: string): LaunchableAgent[];
}

/** D23: an unknown agent is refused with the three closest names the caller may launch. */
function getUnknownAgentError(agent: string, launchable: () => LaunchableAgent[]): string {
	return `Error: ${renderUnknownAgentRefusal(agent, launchable().map(nameOf))}`;
}

function getSpawnWidthError(text: string): ToolResult {
	return asSubagentToolResult({
		content: [{ type: "text" as const, text }],
		details: { error: "spawn_width" },
	});
}

function getBatchWidthValidationError(count: number, limit: number): ToolResult {
	return getSpawnWidthError(
		`Error: batch of ${count} subagents exceeds the spawn width limit of ${limit}. Launch fewer children in this batch.`,
	);
}

function getSpawnWidthLimitError(limit: number): ToolResult {
	return getSpawnWidthError(
		`Spawn width limit reached (${getLiveSlotCount()}/${limit} slots busy). Wait for a running subagent to finish, or use subagent_kill to free a slot. Interactive children with auto-exit: false keep their slot until the pane closes.`,
	);
}

export function getSubagentNameError(name: string | undefined): string | null {
	const trimmed = name?.trim();
	if (!trimmed) {
		return "Error: name is required for subagent launches. Provide a lower-kebab <scope>-<role> handle like auth-scout, diff-reviewer, or session-tester.";
	}
	if (trimmed !== name) {
		return `Error: subagent name ${JSON.stringify(name)} has surrounding whitespace. Use lower-kebab <scope>-<role>, e.g. auth-scout.`;
	}
	if (trimmed.length > 32) {
		return `Error: subagent name ${JSON.stringify(name)} is too long. Use 2-4 lower-kebab words and keep it at 32 characters or fewer.`;
	}
	if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+){1,3}$/.test(trimmed)) {
		return `Error: subagent name ${JSON.stringify(name)} must be lower-kebab <scope>-<role> with 2-4 words, e.g. auth-scout, diff-reviewer, or session-tester. Do not use spaces, underscores, Title Case, or prose.`;
	}
	return null;
}

export function withToolWarning(result: ToolResult, warningPrefix: string): ToolResult {
	// D14: a published rendering holds the warnings inside its frame, the same text the message path shows.
	if (!warningPrefix || isRenderedResult(result)) return result;
	const existingText = resultText(result);
	// Spread the original result so batch/turn-control fields like `terminate`
	// survive; only the text content is prepended with the warning.
	return asSubagentToolResult({
		...result,
		content: [{ type: "text", text: `${warningPrefix}\n\n${existingText}` }],
	});
}

function getLaunchError(
	params: SubagentParamsInput,
	agentDefs: AgentDefaults | null,
	currentAgent: string | undefined,
	launchable: () => LaunchableAgent[],
): string | null {
	const nameError = getSubagentNameError(params.name);
	if (nameError) return nameError;
	if (!params.title?.trim())
		return "Error: title is required for subagent launches. Provide a short sentence-case title for the child session/widget.";
	if (params.agent && !agentDefs) return getUnknownAgentError(params.agent, launchable);
	const agentError = getSubagentAgentRequirementError(params, agentDefs);
	if (agentError) return agentError.content[0]?.text ?? "Agent requirement error";
	if (params.agent && params.agent === currentAgent) {
		return `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`;
	}
	const callerEnv = parseSpawnEnv(process.env);
	const spawnPolicy = resolveSpawnPolicy({
		callerAgent: callerEnv.callerAgent,
		targetAgent: params.agent ?? "",
		callerBudget: callerEnv.callerBudget,
		callerSpawnable: callerEnv.callerSpawnable,
		targetSpawning: agentDefs?.spawning ?? false,
		targetSpawnDepth: agentDefs?.spawnDepth,
		targetSpawnWidth: agentDefs?.spawnWidth,
		targetVisibleTo: agentDefs?.visibleTo ?? ["all"],
		envDepthCeiling: callerEnv.envDepthCeiling,
		envWidthCeiling: callerEnv.envWidthCeiling,
	});
	if (!spawnPolicy.allowed) return `Error: ${spawnPolicy.reason ?? "Spawn policy denied this target."}`;
	return null;
}

async function launchSubagentByMode(
	params: SubagentParamsInput,
	launchCtx: SubagentLaunchContext,
	runtime: SubagentToolRuntime,
	ctx: ExtensionContext,
	usesBackgroundLaunch: boolean,
	slots: SpawnSlotLease,
): Promise<RunningSubagent> {
	const running = usesBackgroundLaunch
		? await runtime.launchBackgroundSubagent(params, launchCtx)
		: await runtime.launchSubagent(params, launchCtx);
	claimSpawnWidthSlot(running, slots);
	const watcherAbort = new AbortController();
	running.abortController = watcherAbort;
	const watch = usesBackgroundLaunch ? runtime.watchBackgroundSubagent : runtime.watchSubagent;
	running.completionPromise = releaseSpawnWidthSlotOnCompletion(
		running,
		watch(running, runtime.getWatcherSignal(running, watcherAbort)),
	);
	return running;
}

function buildSubagentLaunchContext(
	toolCallId: string,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	autoExit: true | undefined,
	warning: string,
): SubagentLaunchContext {
	const parentModelRef = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	return {
		sessionManager: ctx.sessionManager,
		cwd: ctx.cwd,
		launchToolCallId: toolCallId,
		autoExit,
		modelRegistry: ctx.modelRegistry,
		parentModelRef,
		parentThinking: pi.getThinkingLevel() as string,
		resultWarnings: launchWarningLines(warning),
	};
}

async function launchOneSubagent(
	toolCallId: string,
	params: SubagentParamsInput,
	agentDefs: AgentDefaults | null,
	ctx: ExtensionContext,
	runtime: SubagentToolRuntime,
	pi: ExtensionAPI,
	slots: SpawnSlotLease,
	warning: string,
): Promise<RunningSubagent> {
	const effectiveParams = enforceAgentFrontmatter(params, agentDefs);
	// In print/prompt-style runs there is no durable parent turn for async steer
	// delivery. Force blocking and record the batch as blocking too, so a stop
	// requested from frontmatter cannot attach `terminate` to the completed
	// result before the model reads the report it just waited for.
	const usesBackgroundLaunch = shouldUseBackgroundLaunch(effectiveParams, agentDefs, ctx.hasUI);
	const forceSynchronousLaunch = shouldForceSynchronousLaunch(ctx.hasUI);
	const headlessAutoExit = applySynchronousLaunchPolicy(
		effectiveParams,
		agentDefs,
		usesBackgroundLaunch,
		forceSynchronousLaunch,
	);

	const launchCtx = buildSubagentLaunchContext(toolCallId, ctx, pi, headlessAutoExit, warning);
	if (agentDefs?.llmAsVerifier === true) {
		// One logical child fronts the whole fan-out: N candidates are planned
		// here and owned by a detached supervisor; no per-candidate routes are
		// ever registered in this parent.
		const { running } = await launchVerifiedFanOut(effectiveParams, agentDefs, launchCtx, { slots });
		return running;
	}
	return launchSubagentByMode(effectiveParams, launchCtx, runtime, ctx, usesBackgroundLaunch, slots);
}

export function isOneShotPromptInvocation(argv = process.argv): boolean {
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--print" || arg === "-p") return true;
		if (arg === "--mode" && (argv[i + 1] === "json" || argv[i + 1] === "rpc")) {
			return true;
		}
	}
	return false;
}

function hasInitialPromptArgument(argv = process.argv): boolean {
	const optionsWithValue = new Set([
		"--provider",
		"--model",
		"--api-key",
		"--system-prompt",
		"--append-system-prompt",
		"--mode",
		"--name",
		"-n",
		"--session",
		"--session-id",
		"--fork",
		"--session-dir",
		"--models",
		"--tools",
		"-t",
		"--exclude-tools",
		"-xt",
		"--extension",
		"-e",
		"--skill",
		"--prompt-template",
		"--theme",
		"--thinking",
		"--tui-mode",
		"--export",
		"--list-models",
	]);
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") return i + 1 < argv.length;
		if (optionsWithValue.has(arg)) {
			i++;
			continue;
		}
		if (arg.startsWith("-")) continue;
		if (arg.startsWith("@")) continue;
		return true;
	}
	return false;
}

export function isInitialPromptInvocation(argv = process.argv): boolean {
	return !isOneShotPromptInvocation(argv) && hasInitialPromptArgument(argv);
}

export function markInitialPromptLaunchComplete(): void {
	initialPromptLaunchActive = false;
}

/**
 * A session with no durable turn for later steer delivery: no UI, or a
 * one-shot `pi -p` / `--mode json|rpc` run. Every launch in it is awaited, so
 * no helper ever reports later.
 */
export function isHeadlessLaunchSession(hasUI: boolean, argv = process.argv): boolean {
	return !hasUI || isOneShotPromptInvocation(argv);
}

export function shouldForceSynchronousLaunch(hasUI: boolean, argv = process.argv): boolean {
	const startupPromptActive = argv === process.argv ? initialPromptLaunchActive : isInitialPromptInvocation(argv);
	return isHeadlessLaunchSession(hasUI, argv) || startupPromptActive;
}

function resultText(result: ToolResult): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n\n");
}

function getToolWaitSignal(running: RunningSubagent, signal: AbortSignal | undefined): AbortSignal | undefined {
	return running.async === false ? undefined : signal;
}

export function registerSubagentCoreTools(
	pi: ExtensionAPI,
	shouldRegister: (name: string) => boolean,
	runtime: SubagentToolRuntime,
): void {
	if (shouldRegister(SUBAGENT_TOOL_NAME))
		pi.registerTool({
			name: SUBAGENT_TOOL_NAME,
			label: "Subagent",
			description: "Start one or more child agents, each named with its task in the children list.",
			parameters: SubagentParams,
			execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
				const children = params.children.map((child) => stripInternalLaunchOverrides(child as SubagentParamsInput));
				const widthLimit = getSpawnWidthLimit();
				if (children.length > widthLimit) return getBatchWidthValidationError(children.length, widthLimit);
				const currentAgent = parseSpawnEnv(process.env).callerAgent ?? undefined;
				const launchable = () => runtime.listLaunchableAgents(ctx.cwd);
				const prepared = children.map((child) => {
					const agentDefs = runtime.loadAgentDefaults(child.agent, ctx.cwd);
					const error = getLaunchError(child, agentDefs, currentAgent, launchable);
					if (error) throw new Error(error);
					return {
						child,
						agentDefs,
						blocking: resolveSubagentBlocking(child, agentDefs),
						warning: getChildLaunchWarning(child, agentDefs, shouldUseBackgroundLaunch(child, agentDefs, ctx.hasUI)),
					};
				});
				// Slot cost per child: 1 normally, N candidates for a verified
				// fan-out (SPEC: N candidates consume N spawn slots, reserved
				// atomically before any worktree creation or verifier spend).
				const slotCosts = prepared.map((entry) =>
					entry.agentDefs?.llmAsVerifier === true
						? resolveVerifierCandidateCount(entry.agentDefs.llmAsVerifierCandidates)
						: 1,
				);
				const totalSlots = slotCosts.reduce((sum, cost) => sum + cost, 0);
				// D9: the launch cap counts the same units, taken before any side effect.
				const unlaunchedCapSlots = tryAcquireLaunchCapSlots(totalSlots);
				if (!unlaunchedCapSlots) {
					return asSubagentToolResult({
						content: [{ type: "text", text: getLaunchCapError(totalSlots) }],
						details: { error: "launch_cap" },
					});
				}
				const unlaunchedSlots = tryAcquireSlots(totalSlots, widthLimit);
				if (!unlaunchedSlots) {
					unlaunchedCapSlots.release();
					return getSpawnWidthLimitError(widthLimit);
				}
				const hasBlockingChild = prepared.some((entry) => entry.blocking);
				const launched: RunningSubagent[] = [];
				try {
					if (prepared.length > 1 && hasBlockingChild) {
						markSubagentBatchBlocking();
					}

					for (let index = 0; index < prepared.length; index++) {
						const entry = prepared[index];
						// A failed child gives back its own share; the outer catch, the rest.
						const childSlots = unlaunchedSlots.split(slotCosts[index]);
						const childCapSlots = unlaunchedCapSlots.split(slotCosts[index]);
						let running: RunningSubagent;
						try {
							const { child, agentDefs, warning } = entry;
							running = await launchOneSubagent(toolCallId, child, agentDefs, ctx, runtime, pi, childSlots, warning);
						} catch (error) {
							childSlots.release();
							childCapSlots.release();
							throw error;
						}
						childCapSlots.commit();
						launched.push(running);
						runtime.wireSubagentSteerBack(pi, running, running.completionPromise!);
					}
				} catch (error) {
					unlaunchedSlots.release();
					unlaunchedCapSlots.release();
					throw error;
				}
				runtime.startWidgetRefresh();
				const results = await Promise.all(
					launched.map((running) => runtime.getLaunchedSubagentResult(running, getToolWaitSignal(running, signal))),
				);
				// D23: every launch reply starts with the launch facts; each delivered report follows unchanged,
				// with its own warnings (a published rendering already holds them).
				const delivered = results.map((result) => (result.details as { status?: string })?.status !== "started");
				const text = renderLaunchReply(
					launched,
					results.map((result, index) =>
						delivered[index] ? { report: resultText(withToolWarning(result, prepared[index].warning)) } : null,
					),
					[
						...prepared.filter((_, index) => !delivered[index]).map((entry) => entry.warning),
						// D10: outside every result frame, so each dropped entry is named once in this reply.
						...droppedExtensionLines(launched.flatMap((running) => running.droppedExtensions ?? [])),
					],
				);
				if (launched.length === 1) {
					return asSubagentToolResult({ ...results[0], content: [{ type: "text", text }] });
				}
				return asSubagentToolResult({
					content: [{ type: "text", text }],
					details: {
						// "batch" when this reply holds reports, so the TUI shows them.
						status: delivered.some(Boolean) ? "batch" : "started",
						children: results.map((result, index) => ({
							...(result.details as Record<string, unknown>),
							task: prepared[index]?.child.task,
							title: prepared[index]?.child.title,
							agent: prepared[index]?.child.agent,
							name: (result.details as { name?: string } | undefined)?.name ?? prepared[index]?.child.name,
						})),
					},
					...getSubagentBatchStopMetadata(),
				});
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				const children = Array.isArray(args.children) ? args.children : [];
				const lines = [
					`▸ ${theme.fg("toolTitle", theme.bold("Spawn"))} ${theme.fg("toolTitle", theme.bold(`${children.length} agents`))}`,
					"",
				];
				children.forEach((child, index) => {
					if (index > 0) lines.push("");
					const agent = child.agent ? theme.fg("dim", ` (${child.agent})`) : "";
					lines.push(`${theme.fg("accent", theme.bold(child.name ?? "subagent"))}${agent}`);
					const taskPreview = formatTaskPreview(child.task, context, theme).replace(/^\n/, "");
					if (taskPreview) lines.push(taskPreview);
				});
				text.setText(lines.join("\n"));
				return text;
			},
			renderResult(result, options, theme, context) {
				const details = result.details as { status?: string; children?: unknown[] } | undefined;
				if (details?.children) {
					if (details.status !== "batch") return new Text("", 0, 0);
					const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
					component.setText(`\n${formatSubagentBatchLines(result, context.args, options, theme).join("\n")}`);
					return component;
				}
				if (!isFinishedStatus(details?.status)) {
					return new Text("", 0, 0);
				}
				return renderSubagentCompletionText(
					result,
					options,
					theme,
					context.lastComponent instanceof Text ? context.lastComponent : undefined,
					true,
				);
			},
		});

	if (shouldRegister(SET_TAB_TITLE_TOOL_NAME)) registerSetTabTitleTool(pi);
}
