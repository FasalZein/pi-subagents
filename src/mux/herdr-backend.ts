import { HERDR_PANE_IDENTITY } from "../launch/child-env.ts";
import type { MuxBackendAdapter } from "./backend.ts";
import {
	closeHerdrPane,
	isHerdrRuntimeAvailable,
	readHerdrPaneScreen,
	readHerdrPaneScreenAsync,
	runHerdrPaneCommand,
	sendHerdrPaneEnter,
} from "./herdr.ts";
import {
	createHerdrSplit,
	createHerdrSurface,
	renameHerdrCurrentTab,
	renameHerdrCurrentWorkspace,
	resolveHerdrPlacementPolicy,
} from "./herdr-surfaces.ts";
import { createHerdrWorkReporter } from "./herdr-work.ts";

/** Old herdr (the herdr CLI with HERDR_PANE_ID), not herdr-core. */
export const herdrBackend: MuxBackendAdapter = {
	id: "herdr",
	isAvailable: () => isHerdrRuntimeAvailable(),
	setupHint: () => "Start pi inside Herdr (`herdr`, then run `pi`).",
	createSurface: async (name, options) => createHerdrSurface(name, options?.herdr),
	createSplit: createHerdrSplit,
	sendCommand: (surface, command) => {
		if (command.length > 0) runHerdrPaneCommand(surface, command);
		else sendHerdrPaneEnter(surface);
	},
	readScreen: readHerdrPaneScreen,
	readScreenAsync: readHerdrPaneScreenAsync,
	closeSurface: (surface) => closeHerdrPane(surface),
	renameCurrentTab: renameHerdrCurrentTab,
	renameWorkspace: renameHerdrCurrentWorkspace,
	stagesShellCommands: true,
	paneIdentity: HERDR_PANE_IDENTITY,
	resolveHerdrPlacementPolicy: (value) => resolveHerdrPlacementPolicy(value),
	connectWorkReporter: (session) => createHerdrWorkReporter(session),
};
