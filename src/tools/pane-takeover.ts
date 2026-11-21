import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { ErrorExitPayload } from "./provider-error-recovery.ts";

type ShutdownContext = { shutdown: () => void };

/**
 * True for raw pane input that a person typed: Escape or a printable key.
 * Terminal reports (mouse, focus, size and color replies) start with an
 * escape sequence that is not the Escape key, so they never count.
 * Limit: a bracketed paste and xterm modifyOtherKeys sequences also start with
 * an escape sequence, so they do not count until the person submits or presses
 * a plain key. Revisit if a pane terminal reports every key that way.
 */
function isOperatorKeystroke(data: string): boolean {
	if (data.length === 0 || isKeyRelease(data)) return false;
	if (matchesKey(data, "escape")) return true;
	if (decodeKittyPrintable(data) !== undefined) return true;
	return !data.startsWith("\x1b") && !hasControlCharacter(data);
}

/** A C0 control character or DEL; a surrogate code unit is never one, so code units suffice. */
function hasControlCharacter(data: string): boolean {
	for (let index = 0; index < data.length; index++) {
		const code = data.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

interface PaneTakeoverDeps {
	writeExitSignal(payload: ErrorExitPayload): unknown;
	/** T85: keeps the exit record written before a takeover from reading as the child's exit. */
	holdExitRecord(): void;
}

/**
 * D11/D12 owner of a pane child after a person takes it over. While taken
 * over, nothing requests shutdown or writes an exit record; the latest
 * unrecovered terminal error stays here until the pane really closes, so the
 * close reports it instead of "done".
 */
export function createPaneTakeover(deps: PaneTakeoverDeps) {
	let tookOver = false;
	// T70: set when this child's own code asked Pi to shut down; any other shutdown came from outside.
	let childRequestedShutdown = false;
	let unrecoveredError: ErrorExitPayload | null = null;
	// T85: the child wrote its answer and its close waits for the next tick.
	let answerClosePending = false;
	let stopKeyWatch: (() => void) | undefined;

	function showEndedRunInPane(ctx: unknown, message: string) {
		try {
			(ctx as { ui: { notify(message: string, tone?: string): void } }).ui.notify(message, "error");
		} catch {
			// Context may already be stale after session shutdown/reload.
		}
	}

	/**
	 * Closes the pane after one tick, unless a person took it over in between:
	 * a key can land between the child's end and the deferred close (F2, D11).
	 */
	function shutdownOnNextTick(ctx: ShutdownContext, onTakenOver?: () => void, beforeShutdown?: () => void) {
		setTimeout(() => {
			if (tookOver) {
				onTakenOver?.();
				return;
			}
			beforeShutdown?.();
			childRequestedShutdown = true;
			try {
				ctx.shutdown();
			} catch {
				// Context may already be stale after session shutdown/reload.
			}
		}, 0);
	}

	/** Ends the run as failed; a taken-over pane shows the error and stays open. */
	function shutdownAfterError(ctx: ShutdownContext, message: string, beforeShutdown?: () => void) {
		if (tookOver) {
			showEndedRunInPane(ctx, message);
			return;
		}
		shutdownOnNextTick(ctx, () => showEndedRunInPane(ctx, message), beforeShutdown);
	}

	return {
		get tookOver() {
			return tookOver;
		},
		/**
		 * The child's own shutdown (completion, ping, untyped exit): marks the end as the child's (T70).
		 * Its exit record is already written, so a takeover before the tick only keeps the pane open.
		 */
		requestShutdown(ctx: ShutdownContext) {
			answerClosePending = true;
			const tickRan = () => {
				answerClosePending = false;
			};
			shutdownOnNextTick(ctx, tickRan, tickRan);
		},
		/** T70: true once this child's own deferred close asked Pi to shut down. */
		get childRequestedShutdown() {
			return childRequestedShutdown;
		},
		/** Returns true when this call started the takeover. */
		markTakenOver(): boolean {
			const started = !tookOver;
			tookOver = true;
			// The close will not run, so the answer already on disk must not read as an exit (T85).
			if (answerClosePending) deps.holdExitRecord();
			return started;
		},
		/** Only /auto-exit hands the pane back to the child. */
		release() {
			tookOver = false;
		},
		endRunWithError(ctx: ShutdownContext, payload: ErrorExitPayload) {
			unrecoveredError = payload;
			shutdownAfterError(ctx, payload.errorMessage, () => deps.writeExitSignal(payload));
		},
		shutdownAfterError,
		/**
		 * Esc during overflow compaction, a Pi retry or an idle recovery countdown
		 * aborts a signal, not a turn, and typing before Enter submits nothing, so
		 * neither reaches `input` or an aborted `agent_end`. Raw pane keys do.
		 */
		watchPaneKeys(ui: Pick<ExtensionUIContext, "onTerminalInput">, onKey: () => void) {
			stopKeyWatch?.();
			stopKeyWatch = ui.onTerminalInput((data) => {
				if (isOperatorKeystroke(data)) onKey();
				return undefined;
			});
		},
		stopWatchingPaneKeys() {
			stopKeyWatch?.();
			stopKeyWatch = undefined;
		},
		/** A newer turn supersedes the kept error: a success or a new provider error. */
		clearUnrecoveredError() {
			unrecoveredError = null;
		},
		get unrecoveredError() {
			return unrecoveredError;
		},
	};
}
