import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { ErrorExitPayload } from "./provider-error-recovery.ts";

type ShutdownContext = { shutdown: () => void };

export function requestShutdown(ctx: ShutdownContext) {
	setTimeout(() => {
		try {
			ctx.shutdown();
		} catch {
			// Context may already be stale after session shutdown/reload.
		}
	}, 0);
}

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
	return !data.startsWith("\x1b") && !/[\x00-\x1f\x7f]/u.test(data);
}

interface PaneTakeoverDeps {
	writeExitSignal(payload: ErrorExitPayload): unknown;
}

/**
 * D11/D12 owner of a pane child after a person takes it over. While taken
 * over, nothing requests shutdown or writes an exit record; the latest
 * unrecovered terminal error stays here until the pane really closes, so the
 * close reports it instead of "done".
 */
export function createPaneTakeover(deps: PaneTakeoverDeps) {
	let tookOver = false;
	let unrecoveredError: ErrorExitPayload | null = null;
	let stopKeyWatch: (() => void) | undefined;

	function showEndedRunInPane(ctx: unknown, message: string) {
		try {
			(ctx as { ui: { notify(message: string, tone?: string): void } }).ui.notify(message, "error");
		} catch {
			// Context may already be stale after session shutdown/reload.
		}
	}

	/**
	 * Ends the run as failed after one tick, unless a person took over the pane
	 * in between: an input can land between the error and the deferred close.
	 */
	function shutdownAfterError(ctx: ShutdownContext, message: string, beforeShutdown?: () => void) {
		if (tookOver) {
			showEndedRunInPane(ctx, message);
			return;
		}
		setTimeout(() => {
			if (tookOver) {
				showEndedRunInPane(ctx, message);
				return;
			}
			beforeShutdown?.();
			try {
				ctx.shutdown();
			} catch {
				// Context may already be stale after session shutdown/reload.
			}
		}, 0);
	}

	return {
		get tookOver() {
			return tookOver;
		},
		/** Returns true when this call started the takeover. */
		markTakenOver(): boolean {
			const started = !tookOver;
			tookOver = true;
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
