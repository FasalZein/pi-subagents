import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTestDir, SESSION_HEADER, writeExecutable } from "./fixtures.ts";
import { join } from "./node.ts";

interface Notice {
	message: string;
	type?: string;
}

type Handler = (...args: unknown[]) => unknown;
// biome-ignore lint/suspicious/noExplicitAny: the registered tool shape is probed dynamically.
type RegisteredTool = { name: string; execute: (...args: any[]) => Promise<any> };

let moduleGeneration = 0;

/**
 * Load the extension the way Pi does on startup and on /reload: Pi disables
 * the module cache, so each load gets a fresh module instance of
 * src/subagents.ts and a fresh factory call.
 */
export async function loadExtension(cwd: string, sessionId = `session-${moduleGeneration + 1}`) {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		sendMessage() {},
		appendEntry() {},
		getThinkingLevel: () => "low",
	} as unknown as ExtensionAPI;
	moduleGeneration += 1;
	const module = await import(`../../src/subagents.ts?generation=${moduleGeneration}`);
	const prevCwd = process.cwd();
	process.chdir(cwd);
	try {
		module.default(api);
	} finally {
		process.chdir(prevCwd);
	}
	const notices: Notice[] = [];
	const parentSession = join(cwd, `${sessionId}.jsonl`);
	writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);
	const ctx = {
		cwd,
		hasUI: true,
		mode: "interactive",
		ui: {
			theme: { fg: (_tone: string, text: string) => text, bold: (text: string) => text },
			setWidget() {},
			notify(message: string, type?: string) {
				notices.push({ message, type });
			},
		},
		sessionManager: {
			getHeader: () => ({ id: sessionId, type: "session", timestamp: "", cwd }),
			getSessionId: () => sessionId,
			getSessionFile: () => parentSession,
			getLeafId: () => null,
		},
	};
	const emit = async (event: string, payload: object) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
	};
	const startSession = async (reason: string) => {
		notices.length = 0;
		await emit("session_start", { reason });
		return [...notices];
	};
	return { tools, ctx, emit, startSession };
}

/** A fake `pi` binary: each child runs the script (default: exit at once), so its launch completes. */
export function useFakePi(script = "exit 0"): void {
	process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(createTestDir(), "fake-pi", `#!/bin/sh\n${script}\n`);
}
