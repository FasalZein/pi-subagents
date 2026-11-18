import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	endedAtToolUseBoundary,
	findLatestAssistantError,
	isOperatorInput,
	shouldAutoExitOnAgentEnd,
	shouldMarkUserTookOver,
} from "../auto-exit.ts";
import { applyChildSystemPromptOverrides } from "./child-system-prompt.ts";
import { getPublishedRunningSubagentCount } from "../runtime/nested-lifecycle.ts";
import { installSubagentContextReminders } from "./context-reminders.ts";
import { createExitSignalWriter } from "./exit-signal.ts";
import { deleteMarkedSessionFileOnProcessExit } from "../session/delete-on-exit.ts";
import { installSubagentTimeoutReminders } from "./timeout-reminders.ts";
import { type FinalContextSnapshot, getFinalContextSnapshot } from "./final-context-snapshot.ts";
import { createPaneTakeover, requestShutdown } from "./pane-takeover.ts";
import { isMissingOptionalDependency, optionalRequire } from "./optional-dependency.ts";
import {
	ProviderErrorRecoveryController,
	resolveProviderRecoveryDelaysMs,
} from "./provider-error-recovery.ts";
import { registerSetTabTitleTool, shouldRegisterSetTabTitleTool } from "./set-tab-title.ts";
import { createCallerPingState, registerCallerPingTool, rearmCallerPingExitAfterReenable, suppressCallerPingExit } from "./caller-ping.ts";
import { SUBAGENT_DONE_TOOL_NAME, SUBAGENT_LAUNCH_TOOL_NAMES } from "./tool-names.ts";

const TOOL_BOUNDARY_RECOVERY_NUDGE = "continue";
const MAX_CONSECUTIVE_TOOL_BOUNDARY_ENDS = 3;
export function isMissingOptionalDependencyForTest(error: unknown, id: string): boolean {
	return isMissingOptionalDependency(error, id);
}

export function getDeniedToolNames(autoExit: boolean, deniedEnv = process.env.PI_DENY_TOOLS ?? ""): string[] {
	const denied = deniedEnv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (autoExit && !denied.includes(SUBAGENT_DONE_TOOL_NAME)) {
		denied.push(SUBAGENT_DONE_TOOL_NAME);
	}
	return denied;
}

export function filterToolNames(toolNames: string[], deniedTools: string[]): string[] {
	const denied = new Set(deniedTools);
	const seen = new Set<string>();
	return toolNames.filter((name) => {
		if (!name || denied.has(name) || seen.has(name)) return false;
		seen.add(name);
		return true;
	});
}

export function shouldRegisterSubagentDone(autoExit: boolean, deniedTools: string[], isInteractive = false): boolean {
	if (deniedTools.includes(SUBAGENT_DONE_TOOL_NAME)) return false;
	if (autoExit) return false;
	if (isInteractive) return false;
	return true;
}

type PaneUiContext = {
	ui: { setStatus(key: string, message?: string): void; notify(message: string, tone?: string): void };
};

type ToolControlAPI = Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools" | "registerTool">;

type WidgetThemeLike = {
	bg(tone: string, text: string): string;
	bold(text: string): string;
	fg(tone: string, text: string): string;
};

export function installDeniedToolGuards(
	pi: ToolControlAPI,
	autoExit: boolean,
	onChange?: (activeTools: string[], deniedTools: string[]) => void,
) {
	const originalRegisterTool = pi.registerTool.bind(pi);
	const originalSetActiveTools = pi.setActiveTools.bind(pi);

	const notify = (activeTools: string[], deniedTools: string[]) => {
		onChange?.([...activeTools].sort(), [...deniedTools]);
	};

	const applyDeniedTools = (): string[] => {
		const deniedTools = getDeniedToolNames(autoExit);
		const allowedTools = filterToolNames(pi.getActiveTools(), deniedTools);
		originalSetActiveTools(allowedTools);
		notify(allowedTools, deniedTools);
		return allowedTools;
	};

	pi.setActiveTools = (toolNames: string[]) => {
		const deniedTools = getDeniedToolNames(autoExit);
		const allowedTools = filterToolNames(toolNames, deniedTools);
		originalSetActiveTools(allowedTools);
		notify(allowedTools, deniedTools);
	};

	pi.registerTool = (definition) => {
		const result = originalRegisterTool(definition);
		applyDeniedTools();
		return result;
	};

	return { applyDeniedTools };
}

export default function (pi: ExtensionAPI) {
	const typebox = optionalRequire("typebox") as typeof import("typebox") | null;
	const doneParams = typebox?.Type?.Object
		? typebox.Type.Object({})
		: { type: "object", properties: {}, additionalProperties: false };
	const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
	const isInteractive = !!process.env.PI_SUBAGENT_SURFACE;
	const denied: string[] = getDeniedToolNames(autoExit);
	let outputTokens = 0;
	let finalContextUsage: FinalContextSnapshot | undefined;
	// Factory-scoped because the takeover machinery that suppresses it lives
	// inside the `if (autoExit)` block, while caller_ping registers outside it.
	const callerPingState = createCallerPingState();
	const contextReminders = installSubagentContextReminders(pi);
	installSubagentTimeoutReminders(pi);
	// D13: after a continue detach the parent is gone; this child deletes its no-session file at exit.
	deleteMarkedSessionFileOnProcessExit(process.env.PI_SUBAGENT_SESSION);

	const writeExitSignal = createExitSignalWriter({
		pi,
		getFinalContextUsage: () => finalContextUsage,
		hasDeliveredFinalWarning: () => contextReminders.hasDeliveredFinalWarning(),
	});

	// D11: set when a person types or presses Escape in the pane after the run
	// started; only /auto-exit clears it. While set, the person owns the pane:
	// nothing here requests shutdown or writes an exit record before it closes.
	const takeover = createPaneTakeover({ writeExitSignal });
	const endRunWithError = takeover.endRunWithError;
	// Set by the auto-exit or manual branch below; raw pane keys reach it.
	let onOperatorKeystroke: (ctx: PaneUiContext) => void = () => {};

	const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
	const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
	const recoveryStatusKey = "pi-subagent-recovery";
	const piRecoveryNoCompactionGraceMs = 180_000;
	const piRecoveryCompactionTimeoutMs = 180_000;
	const providerErrorRecovery = new ProviderErrorRecoveryController(
		{
			sendUserMessage: (message) => pi.sendUserMessage(message),
			endWithError: endRunWithError,
			getOutputTokens: () => outputTokens,
			// Only interactive panes have a status bar worth updating; background
			// `pi -p` children have no operator watching and no TUI footer.
			showRecoveryCountdown: (ctx, message) => {
				if (isInteractive) ctx.ui.setStatus(recoveryStatusKey, message);
			},
			clearRecoveryCountdown: (ctx) => {
				if (isInteractive) ctx.ui.setStatus(recoveryStatusKey, undefined);
			},
		},
		{ recoveryDelaysMs: resolveProviderRecoveryDelaysMs() },
	);

	// The latest provider error whose recovery window has not yet been superseded
	// by a successful assistant turn. `session_shutdown` uses it to report a clean
	// failure when the process is about to exit before a delayed nudge can fire
	// (notably `pi -p` background children, which exit as soon as Pi's own retries
	// finish).
	let pendingProviderError: {
		errorMessage: string;
		stopReason: "error";
	} | null = null;
	type PendingPiRecovery = {
		token: number;
		errorMessage: string;
		stopReason: "error";
		ctx: { shutdown: () => void };
		timer?: ReturnType<typeof setTimeout>;
	};
	let pendingPiRecovery: PendingPiRecovery | null = null;
	let piRecoveryGeneration = 0;

	function cancelPendingPiRecovery() {
		piRecoveryGeneration++;
		if (pendingPiRecovery?.timer) clearTimeout(pendingPiRecovery.timer);
		pendingPiRecovery = null;
	}

	function failPendingPiRecovery(token: number) {
		const pending = pendingPiRecovery;
		if (!pending || pending.token !== token) return;
		pendingPiRecovery = null;
		endRunWithError(pending.ctx, {
			type: "error",
			errorMessage: pending.errorMessage,
			stopReason: pending.stopReason,
			outputTokens,
		});
	}

	function armPiRecoveryFailureTimer(delayMs: number) {
		if (!pendingPiRecovery) return;
		const token = pendingPiRecovery.token;
		if (pendingPiRecovery.timer) clearTimeout(pendingPiRecovery.timer);
		const timer = setTimeout(() => failPendingPiRecovery(token), delayMs);
		timer.unref?.();
		pendingPiRecovery.timer = timer;
	}

	function deferToPiNativeRecovery(
		errorInfo: { errorMessage: string; stopReason: "error" },
		ctx: { shutdown: () => void },
	) {
		cancelPendingPiRecovery();
		pendingPiRecovery = { token: piRecoveryGeneration, ...errorInfo, ctx };
		armPiRecoveryFailureTimer(piRecoveryNoCompactionGraceMs);
	}

	function enforceDeniedTools() {
		try {
			const deniedNames = getDeniedToolNames(autoExit);
			const allowedTools = filterToolNames(pi.getActiveTools(), deniedNames);
			pi.setActiveTools(allowedTools);
		} catch {
			// Tools may not be ready yet, or the extension context may be stale after
			// session shutdown/reload while delayed startup guards are still pending.
		}
	}

	pi.on("session_start", (_event, ctx) => {
		enforceDeniedTools();
		if (isInteractive) takeover.watchPaneKeys(ctx.ui, () => onOperatorKeystroke(ctx));
		setTimeout(() => enforceDeniedTools(), 0);
		setTimeout(() => enforceDeniedTools(), 250);

		// Register a widget callback so pi can re-render on resize
		ctx.ui.setWidget(
			"subagent-tools",
			(_tui: unknown, theme: WidgetThemeLike) => ({
				render: () => {
					const avail = Math.max(1, ((_tui as { terminal?: { columns?: number } })?.terminal?.columns ?? 80) - 1);

					// Build visible text first, truncate BEFORE ANSI wrapping
					const visibleLabel = subagentAgent ? `${subagentName} (${subagentAgent})` : subagentName;
					const visiblePrefix = "▸ Agent ";

					let displayLabel = visibleLabel;
					if (visiblePrefix.length + visibleLabel.length > avail) {
						const maxLabel = Math.max(0, avail - visiblePrefix.length - 1);
						displayLabel = visibleLabel.slice(0, maxLabel) + "…";
					}

					// Split truncated label into name and suffix for different styling
					const nameLen = Math.min(subagentName.length, displayLabel.length);
					const styledName = theme.bold(displayLabel.slice(0, nameLen));
					const styledSuffix = nameLen < displayLabel.length ? theme.fg("muted", displayLabel.slice(nameLen)) : "";

					const line = `${theme.fg("accent", "▸")} ${theme.fg("accent", "Agent")} ${styledName}${styledSuffix}`;
					return [line];
				},
				invalidate: () => {},
			}),
			{ placement: "aboveEditor" },
		);
	});

	pi.on("before_agent_start", (event) => {
		enforceDeniedTools();
		return applyChildSystemPromptOverrides(event);
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message as {
			role?: string;
			stopReason?: string;
			usage?: { output?: number };
		};
		if (message.role !== "assistant") return;
		if (!message.usage) return;
		outputTokens += message.usage.output ?? 0;
		finalContextUsage = getFinalContextSnapshot(ctx) ?? finalContextUsage;
	});

	// Every subagent child reports Pi shutdown through the session sidecar. This is
	// the primary lifecycle signal; mux/shell sentinels are only pane-death fallback.
	// If the run ended on an unrecovered provider error, surface that instead of a
	// phony "done" so the parent learns it was a failure, not a clean completion.
	pi.on("session_shutdown", () => {
		takeover.stopWatchingPaneKeys();
		providerErrorRecovery.cancelPendingRecovery();
		cancelPendingPiRecovery();
		// A run that ended on an error and was never recovered reports that error,
		// also when a person closes a taken-over pane (D12).
		if (takeover.unrecoveredError) {
			writeExitSignal(takeover.unrecoveredError);
			return;
		}
		if (pendingProviderError) {
			writeExitSignal({
				type: "error",
				errorMessage: pendingProviderError.errorMessage,
				stopReason: pendingProviderError.stopReason,
				outputTokens,
			});
			return;
		}
		// A shutdown is a lifecycle event, not the child deciding to stop.
		writeExitSignal({ type: "done", outputTokens }, { autonomous: false });
	});

	pi.on("session_before_compact", (event) => {
		const pending = pendingPiRecovery;
		if (!pending) return;
		if (event.reason !== "overflow" || !event.willRetry) return;
		armPiRecoveryFailureTimer(piRecoveryCompactionTimeoutMs);
		event.signal.addEventListener("abort", () => failPendingPiRecovery(pending.token), { once: true });
	});

	pi.on("session_compact", (event) => {
		if (!pendingPiRecovery) return;
		if (event.reason !== "overflow" || !event.willRetry) return;
		cancelPendingPiRecovery();
	});

	// Auto-exit: when the agent loop ends, shut down automatically.
	// If the user interrupts (Escape) or sends any input, auto-exit is
	// permanently disabled for the rest of the session — the operator has
	// taken over and the child stays open until closed or re-armed with
	// /auto-exit.
	// Enabled via `auto-exit: true` in agent frontmatter.
	const AUTO_EXIT_STATUS_KEY = "pi-subagent-auto-exit";
	if (autoExit) {
		let operatorInputHoldCount = 0;
		let autoExitReArmed = false;
		let agentStarted = false;
		let consecutiveToolBoundaryEnds = 0;
		let toolExecutionsThisTurn = 0;
		let terminatingToolExecutionsThisTurn = 0;
		let terminatingSubagentLaunchesThisTurn = 0;

		const AUTO_EXIT_DISABLED_MSG = "Auto-exit disabled — close manually or /auto-exit to re-enable";
		// Single owner of the disabled latch and the operator-facing status/toast.
		// Called from the `input` handler (every qualifying operator input except the
		// one-shot /auto-exit re-arm) and the aborted `agent_end` branch (Escape fires
		// no input event). Notifying at the disable moment — not from an agent_end
		// branch gated on operatorInputQueuedThisRun, which a follow-up/idle prompt's
		// new agent_start clears — keeps follow-ups and idle prompts from going silent.
		const disableAutoExitByOperator = (ctx: PaneUiContext) => {
			const started = takeover.markTakenOver();
			suppressCallerPingExit(callerPingState);
			if (!started) return;
			if (!isInteractive) return;
			ctx.ui.setStatus(AUTO_EXIT_STATUS_KEY, AUTO_EXIT_DISABLED_MSG);
			ctx.ui.notify(AUTO_EXIT_DISABLED_MSG, "warning");
		};

		pi.on("agent_start", () => {
			agentStarted = true;
			operatorInputHoldCount = 0;
		});

		onOperatorKeystroke = (ctx) => {
			// Before the first run, after a re-arm, or once taken over, a key changes nothing.
			if (!agentStarted || autoExitReArmed || takeover.tookOver) return;
			disableAutoExitByOperator(ctx);
			// The person owns the pane: no automatic "continue" nudge. A kept
			// provider error still reports on close. Pi's own compaction recovery
			// keeps running; its abort reaches failPendingPiRecovery.
			providerErrorRecovery.cancelPendingRecovery();
		};

		pi.on("turn_start", () => {
			// Each queued input holds auto-exit once. Release one at the first
			// turn_start that sees it; a queued steer lands after agent_start.
			if (operatorInputHoldCount > 0) operatorInputHoldCount -= 1;
			toolExecutionsThisTurn = 0;
			terminatingToolExecutionsThisTurn = 0;
			terminatingSubagentLaunchesThisTurn = 0;
		});

		pi.on("tool_execution_end", (event) => {
			toolExecutionsThisTurn += 1;
			const result = event.result as { terminate?: unknown } | undefined;
			if (result?.terminate !== true) return;
			terminatingToolExecutionsThisTurn += 1;
			if (SUBAGENT_LAUNCH_TOOL_NAMES.has(event.toolName)) terminatingSubagentLaunchesThisTurn += 1;
		});

		pi.on("input", (event, ctx) => {
			// The recovery controller sends `source: "extension"` nudges. Those
			// must never read as operator takeover — treating them as manual input
			// would reset the consecutive-failure chain and loop forever.
			if (!isOperatorInput((event as { source?: unknown }).source)) return;
			// Ignore the initial task message that starts an autonomous subagent.
			// Inputs while streaming, queued follow-ups, or later manual prompts mean
			// the operator is steering and the child should stay open for that turn.
			if (!shouldMarkUserTookOver(agentStarted, event.streamingBehavior)) return;
			if (autoExitReArmed) {
				if (event.streamingBehavior === "steer" || event.streamingBehavior === "followUp") {
					// A queued steer/follow-up sent before the re-arm drains into this
					// run: hold auto-exit once so the child stays open to answer it.
					// The re-arm survives until a fresh interactive prompt arrives.
					operatorInputHoldCount += 1;
				} else {
					// A fresh interactive prompt consumes the re-arm.
					autoExitReArmed = false;
				}
			} else if (!takeover.tookOver) {
				operatorInputHoldCount += 1;
				disableAutoExitByOperator(ctx);
			}
			providerErrorRecovery.cancelPendingRecovery(true);
			cancelPendingPiRecovery();
		});

		pi.on("agent_end", (event, ctx) => {
			// A turn with no tool calls fires no turn_start. Release one hold at
			// agent_end only when no turn started since the last input.
			if (operatorInputHoldCount > 0) operatorInputHoldCount -= 1;
			const messages = event.messages as Parameters<typeof shouldAutoExitOnAgentEnd>[0];
			const shouldExit = shouldAutoExitOnAgentEnd(messages);
			if (!shouldExit || operatorInputHoldCount > 0) {
				// Agent turn was aborted (Escape), or the operator sent a queued
				// steering message. Leave the session open and cancel any pending
				// autonomous recovery action. Escape fires no `input` event, so this
				// aborted branch is the only place it can disable + notify; operator
				// steers/follow-ups already notified from the `input` handler.
				if (!shouldExit && isInteractive) {
					disableAutoExitByOperator(ctx);
				}
				providerErrorRecovery.cancelPendingRecovery(operatorInputHoldCount > 0);
				cancelPendingPiRecovery();
				return;
			}
			// An agent loop cannot be complete when its last assistant message still
			// requests tool execution. Some providers occasionally stop Pi at this
			// boundary instead of continuing after the tool result. Nudge immediately
			// so background children do not exit before a delayed retry can fire, but
			// bound the retries so a persistently broken provider cannot loop forever.
			const intentionallyTerminatedToolBatch =
				toolExecutionsThisTurn > 0 && toolExecutionsThisTurn === terminatingToolExecutionsThisTurn;
			const coordinatorOnlyTurnStop =
				intentionallyTerminatedToolBatch && terminatingSubagentLaunchesThisTurn > 0;
			if (endedAtToolUseBoundary(messages) && coordinatorOnlyTurnStop) {
				pendingProviderError = null;
				providerErrorRecovery.cancelPendingRecovery();
				cancelPendingPiRecovery();
				consecutiveToolBoundaryEnds = 0;
				return;
			}
			if (endedAtToolUseBoundary(messages) && !intentionallyTerminatedToolBatch) {
				pendingProviderError = null;
				providerErrorRecovery.cancelPendingRecovery();
				cancelPendingPiRecovery();
				consecutiveToolBoundaryEnds += 1;
				if (consecutiveToolBoundaryEnds < MAX_CONSECUTIVE_TOOL_BOUNDARY_ENDS) {
					pi.sendUserMessage(TOOL_BOUNDARY_RECOVERY_NUDGE, {
						deliverAs: "steer",
					});
					return;
				}
				endRunWithError(ctx, {
					type: "error",
					errorMessage:
						`Subagent recovery exhausted after ${consecutiveToolBoundaryEnds} consecutive ` +
						"tool-use boundary endings.",
					stopReason: "toolUse",
					outputTokens,
				});
				return;
			}

			// Provider errors can arrive before Pi's own retry machinery is truly done:
			// a retryable error fires an agent_end, then Pi retries and may fire a
			// second agent_end that succeeds. Arm a recovery window instead of killing
			// immediately; any later successful assistant turn cancels it. The parent
			// only receives a failure once the window actually fires (interactive panes)
			// or the process exits still unrecovered (background `pi -p` children).
			const errorInfo = findLatestAssistantError(messages);
			if (errorInfo) {
				pendingProviderError = errorInfo;
				takeover.clearUnrecoveredError();
				if (errorInfo.recoveryKind === "pi") {
					// Context overflow is recoverable by Pi's native compaction path,
					// which runs after extension agent_end handlers. Do not enqueue a
					// generic "continue" nudge here: ctx.isIdle() can become true while
					// compaction is still in flight, racing the native compact-and-retry.
					// If Pi does not start or finish that native path, fail explicitly so
					// interactive auto-exit children do not stay open forever.
					providerErrorRecovery.cancelPendingRecovery();
					deferToPiNativeRecovery(errorInfo, ctx);
					return;
				}
				if (errorInfo.recoveryKind === "none") {
					providerErrorRecovery.cancelPendingRecovery();
					cancelPendingPiRecovery();
					// Defer stamping the failure while Pi's in-flight retry may still
					// recover. If the child really dies, session_shutdown reports it
					// from pendingProviderError, also when the person closes a taken-over pane.
					takeover.shutdownAfterError(ctx, errorInfo.errorMessage);
					return;
				}
				cancelPendingPiRecovery();
				providerErrorRecovery.handleProviderError(errorInfo, ctx);
				return;
			}
			// A successful answer supersedes any earlier error, also when the
			// child stays open for queued messages or live children.
			pendingProviderError = null;
			takeover.clearUnrecoveredError();
			if (ctx.hasPendingMessages?.()) return;
			// Keep the coordinator alive until every live child has reported back.
			if (getPublishedRunningSubagentCount() > 0) return;
			consecutiveToolBoundaryEnds = 0;
			providerErrorRecovery.cancelPendingRecovery(true);
			cancelPendingPiRecovery();
			if (takeover.tookOver) return;
			writeExitSignal({ type: "done", outputTokens }, { supersede: true });
			requestShutdown(ctx);
		});

		// /auto-exit re-enables auto-exit after operator interaction disabled it.
		pi.registerCommand?.("auto-exit", {
			description: "Re-enable auto-exit after operator interaction",
			handler: async (_args, ctx) => {
				if (!takeover.tookOver) {
					ctx.ui.notify("Auto-exit is already enabled.", "info");
					return;
				}
				takeover.release();
				autoExitReArmed = true;
				rearmCallerPingExitAfterReenable(callerPingState);
				ctx.ui.setStatus(AUTO_EXIT_STATUS_KEY, undefined);
				ctx.ui.notify("Auto-exit re-enabled — will close after next response.", "info");
			},
		});
	} else {
		// A child without auto-exit has no /auto-exit re-arm: a takeover holds
		// until the pane closes. Same input rules as the auto-exit branch.
		let agentStarted = false;
		pi.on("agent_start", () => {
			agentStarted = true;
		});
		onOperatorKeystroke = () => {
			if (agentStarted) takeover.markTakenOver();
		};
		pi.on("input", (event) => {
			if (!isOperatorInput((event as { source?: unknown }).source)) return;
			if (shouldMarkUserTookOver(agentStarted, event.streamingBehavior)) takeover.markTakenOver();
		});
	}

	if (!isInteractive || autoExit) {
		registerCallerPingTool(pi, callerPingState, {
			writeExitSignal,
			requestShutdown,
			getOutputTokens: () => outputTokens,
		});
	}

	if (shouldRegisterSubagentDone(autoExit, denied, isInteractive)) {
		pi.registerTool({
			name: SUBAGENT_DONE_TOOL_NAME,
			label: "Subagent Done",
			description:
				"When your task is complete, close this session and return your last assistant message to the caller as your result.",
			parameters: doneParams,
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				if (takeover.tookOver) {
					// D11/D12: the result stays in this session; the pane closes only
					// when the person closes it.
					return {
						content: [
							{
								type: "text",
								text: "Result recorded in this session. A person took over this pane, so it stays open until they close it.",
							},
						],
						details: {},
					};
				}
				// D12: Pi omits oversize nested-call arguments from the session; the parent reads them here.
				writeExitSignal({ type: "done", outputTokens, acceptedCall: { toolCallId, args: params } }, { supersede: true });
				requestShutdown(ctx);
				return {
					content: [{ type: "text", text: "Shutting down subagent session." }],
					details: {},
				};
			},
		});
	}

	// set_tab_title is a child-side protocol tool.
	// The mandatory child extension registers it under the same opt-in as the
	// parent so the declared contract holds even when `extensions: none` strips
	// the main pi-subagents extension from the child.
	if (shouldRegisterSetTabTitleTool(new Set(denied))) {
		registerSetTabTitleTool(pi);
	}
}
