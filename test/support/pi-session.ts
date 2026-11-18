import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, getCurrentTools } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createCodemodeExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	type SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** One provider request: the tool names it declared. */
export type DeclaredTools = string[];

export interface PiSessionOptions {
	cwd: string;
	agentDir: string;
	/** The extensions in load order. Pi loads built-in extensions after packages. */
	extensions: ExtensionFactory[];
	sessionManager: SessionManager;
	/** The defaultTools setting, for example ["+tool_search"]. */
	defaultTools?: string[];
	/** `--tools` entries, for example ["-subagent_kill"]. */
	tools?: string[];
	/** Scripted model replies after the declared tools are recorded; default: one text reply. */
	replies?: FauxResponseStep[];
}

/**
 * Run one prompt through a real Pi session with a faux provider and return the
 * tools each provider request declared. Real Pi orders startup handlers,
 * restores the transcript's loadout and applies `--tools` modifiers, which a
 * hand-written mock cannot reproduce faithfully.
 */
export async function runPiPrompt(options: PiSessionOptions): Promise<DeclaredTools[]> {
	const faux = fauxProvider();
	const declared: DeclaredTools[] = [];
	const replies = options.replies ?? [fauxAssistantMessage("ok")];
	faux.setResponses(
		replies.map((reply) => async (context, streamOptions, state, model) => {
			declared.push(getCurrentTools(context.messages).map((tool) => tool.name));
			return typeof reply === "function" ? reply(context, streamOptions, state, model) : reply;
		}),
	);
	// Keep the runtime off the owner's auth and model files.
	const modelRuntime = await ModelRuntime.create({
		authPath: join(options.agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(options.agentDir, "models-store.json"),
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		extensionFactories: options.extensions,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		modelRuntime,
		model: faux.getModel(),
		resourceLoader,
		settingsManager: SettingsManager.inMemory(options.defaultTools ? { defaultTools: options.defaultTools } : {}),
		sessionManager: options.sessionManager,
		...(options.tools ? { tools: options.tools } : {}),
	});
	try {
		await session.bindExtensions({});
		await session.prompt("hello");
	} finally {
		session.dispose();
	}
	return declared;
}

/** Pi's built-in codemode and tool search extensions, as the CLI loads them. */
export const discoveryExtensions: ExtensionFactory[] = [
	createCodemodeExtension({ mode: "on" }),
	createToolSearchExtension(),
];

/**
 * A later startup handler that activates a discovery tool, as Pi's built-in MCP
 * extension does in its own session_start for servers with codemode or deferred exposure.
 */
export function activatesOnSessionStart(toolName: string): ExtensionFactory {
	return (pi) => {
		pi.on("session_start", () => {
			pi.setActiveTools([...pi.getActiveTools(), toolName]);
		});
	};
}
