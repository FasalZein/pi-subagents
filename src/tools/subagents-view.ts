import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getEffectiveAgentDefinitions } from "../agents/definitions.ts";
import { completedSubagentResults, runningSubagents } from "../runtime/state.ts";
import { type OverlayRuntime, SubagentsOverlayController } from "./overlay/index.ts";

export { SubagentsOverlayController as SubagentsOverlay } from "./overlay/index.ts";

export function registerSubagentsView(pi: ExtensionAPI, runtime: OverlayRuntime) {
	let activeOverlay: SubagentsOverlayController | null = null;
	let activeOverlayPromise: Promise<void> | null = null;

	async function open(ctx: ExtensionContext): Promise<void> {
		if (activeOverlay || activeOverlayPromise) return;
		if (
			!runningSubagents.size &&
			!completedSubagentResults.size &&
			!getEffectiveAgentDefinitions(undefined, { includeDisabled: true }).length
		) {
			ctx.ui.notify("No subagents or definitions.", "info");
			return;
		}

		let overlay: SubagentsOverlayController | null = null;
		const customPromise = ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			overlay = new SubagentsOverlayController(
				done,
				ctx,
				{
					fg: (tone, text) => theme.fg(tone as Parameters<typeof theme.fg>[0], text),
					bg: (color, text) => theme.bg(color as Parameters<typeof theme.bg>[0], text),
					bold: (text) => theme.bold(text),
				},
				runtime,
				tui,
			);
			activeOverlay = overlay;
			return overlay;
		});
		const trackedPromise = customPromise.finally(() => {
			if (activeOverlay === overlay) activeOverlay = null;
			if (activeOverlayPromise === trackedPromise) activeOverlayPromise = null;
		});
		activeOverlayPromise = trackedPromise;
		return trackedPromise;
	}

	pi.registerCommand("subagents", {
		description: "Open subagent manager",
		handler: async (_args, ctx) => {
			await open(ctx);
		},
	});

	pi.registerShortcut?.("alt+s", {
		description: "Toggle subagent manager",
		handler: async (_ctx) => {
			if (activeOverlay) {
				activeOverlay.close();
				return;
			}
			pi.sendUserMessage("/subagents", { expandPromptTemplates: true });
		},
	});

	pi.on("session_shutdown", async () => {
		const overlay = activeOverlay;
		activeOverlay = null;
		activeOverlayPromise = null;
		overlay?.dispose();
	});
}
