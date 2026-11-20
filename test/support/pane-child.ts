import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock } from "node:test";
import { createTestDir } from "./fixtures.ts";
import {
	clearPublishedRunningSubagentCountForTest,
	resetSubagentStateForTest,
	subagentDoneExtension,
} from "./project.ts";

/**
 * The child extension of a pane subagent, loaded in this process with a fake
 * Pi API. emit() replays Pi events, press() replays raw pane keys.
 */
const ENV_KEYS = [
	"PI_SUBAGENT_SESSION",
	"PI_SUBAGENT_AUTO_EXIT",
	"PI_SUBAGENT_SURFACE",
	"PI_SUBAGENT_PROVIDER_RECOVERY_DELAYS_MS",
];

export function loadPaneChild(options: { autoExit: boolean; pane: boolean; onNotice?: (message: string) => void }) {
	const handlers = new Map<string, any>();
	const tools = new Map<string, any>();
	const notices: string[] = [];
	const nudges: string[] = [];
	const keyListeners: Array<(data: string) => unknown> = [];
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	let shutdowns = 0;
	const dir = createTestDir();
	const sessionFile = join(dir, "child.jsonl");
	writeFileSync(sessionFile, "");
	process.env.PI_SUBAGENT_SESSION = sessionFile;
	if (options.autoExit) process.env.PI_SUBAGENT_AUTO_EXIT = "1";
	if (options.pane) process.env.PI_SUBAGENT_SURFACE = "fake-pane";
	// Below the 10 s floor, so each recovery window is 10 s of mocked time.
	process.env.PI_SUBAGENT_PROVIDER_RECOVERY_DELAYS_MS = "10,10,10";
	subagentDoneExtension({
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools() {},
		registerTool(definition: { name: string }) {
			tools.set(definition.name, definition);
			return definition;
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => unknown }) {
			commands.set(name, command);
		},
		on(event: string, handler: any) {
			handlers.set(event, handler);
		},
		sendUserMessage(message: string) {
			nudges.push(message);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		registerShortcut() {},
	} as any);
	const ctx = {
		cwd: dir,
		isIdle: () => true,
		ui: {
			setStatus() {},
			setWidget() {},
			notify(message: string) {
				notices.push(message);
				options.onNotice?.(message);
			},
			onTerminalInput(listener: (data: string) => unknown) {
				keyListeners.push(listener);
				return () => keyListeners.splice(keyListeners.indexOf(listener), 1);
			},
		},
		shutdown() {
			shutdowns += 1;
		},
	};
	const exitFile = `${sessionFile}.exit`;
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	return {
		ctx,
		dir,
		notices,
		nudges,
		tools,
		commands,
		/** Custom session entries the extension appended, in order. */
		entries,
		/** Raw pane input, as Pi's TUI hands it to extension listeners. */
		press(data: string) {
			for (const listener of [...keyListeners]) listener(data);
		},
		emit(event: string, payload: unknown) {
			handlers.get(event)?.(payload, ctx);
		},
		takeOver() {
			handlers.get("agent_start")?.({}, ctx);
			handlers.get("input")?.({ source: "interactive", text: "hold on" }, ctx);
		},
		get shutdowns() {
			return shutdowns;
		},
		readExit: () => (existsSync(exitFile) ? JSON.parse(readFileSync(exitFile, "utf8")) : null),
	};
}

export function cleanupPaneChild(dir: string) {
	clearPublishedRunningSubagentCountForTest();
	resetSubagentStateForTest();
	for (const key of ENV_KEYS) delete process.env[key];
	mock.timers.reset();
	rmSync(dir, { recursive: true, force: true });
}
