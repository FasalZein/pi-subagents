import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSetTabTitleToolEnabled } from "../agents/titles.ts";
import { currentMuxAdapter, muxSetupHint } from "../mux.ts";
import { asSubagentToolResult } from "../runtime/state.ts";
import { SET_TAB_TITLE_TOOL_NAME } from "./tool-names.ts";

const SET_TAB_TITLE_DESCRIPTION =
	"Set a short title on the current tab and workspace to show the phase of a multi-phase workflow.";

/**
 * The setup hint when the selected backend sets no title (Rex), equal to the cf6dbf4 hint of a session
 * with no known backend: it names the terminals whose titles Pi sets (D10).
 */
const TITLE_SETUP_HINT =
	"Start pi inside Herdr (`herdr`, then run `pi`), cmux (`cmux pi`), tmux (`tmux new -A -s pi 'pi'`), zellij (`zellij --session pi`, then run `pi`), or WezTerm.";

function muxUnavailable(hint: string) {
	return asSubagentToolResult({
		content: [{ type: "text" as const, text: `Terminal multiplexer not available. ${hint}` }],
		details: { error: "mux not available" },
	});
}

/**
 * Whether the optional set_tab_title tool should be registered for the given
 * denied-tool set. Gated on the PI_SUBAGENT_ENABLE_SET_TAB_TITLE opt-in and on
 * the tool not being denied. Shared by the parent extension and the mandatory
 * child extension so the child-side protocol tool contract actually holds even
 * under `extensions: none`.
 */
export function shouldRegisterSetTabTitleTool(deniedTools: ReadonlySet<string>): boolean {
	return isSetTabTitleToolEnabled() && !deniedTools.has(SET_TAB_TITLE_TOOL_NAME);
}

/**
 * Register the optional set_tab_title tool. Self-contained: it reads the
 * opt-in env var, checks the live mux backend, and renames the current tab
 * and workspace. Safe to call from both parent and child (mandatory)
 * extension entry points.
 */
export function registerSetTabTitleTool(pi: ExtensionAPI): void {
	if (!isSetTabTitleToolEnabled()) return;
	pi.registerTool({
		name: SET_TAB_TITLE_TOOL_NAME,
		label: "Set Tab Title",
		description: SET_TAB_TITLE_DESCRIPTION,
		parameters: Type.Object({
			title: Type.String({
				description: "New tab title (also applied to workspace/session when supported)",
			}),
		}),
		execute: async (_toolCallId, params) => {
			try {
				// One selection per call (D10): every probe could pick another backend in a mixed session, and a
				// rename on a backend without that ability would report a title that was never set.
				const adapter = currentMuxAdapter();
				if (!adapter) return muxUnavailable(muxSetupHint());
				const { renameCurrentTab, renameWorkspace } = adapter;
				if (!renameCurrentTab && !renameWorkspace) return muxUnavailable(TITLE_SETUP_HINT);
				renameCurrentTab?.call(adapter, params.title);
				renameWorkspace?.call(adapter, params.title);
				return asSubagentToolResult({
					content: [{ type: "text" as const, text: `Title set to: ${params.title}` }],
					details: { title: params.title },
				});
			} catch (err: unknown) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				return asSubagentToolResult({
					content: [
						{
							type: "text" as const,
							text: `Failed to set title: ${errorMessage}`,
						},
					],
					details: { error: errorMessage },
				});
			}
		},
	});
}
