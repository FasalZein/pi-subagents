#!/usr/bin/env node
/**
 * Fixed-cost probe (G1.1, G1.2): the prompt text this extension adds to a request.
 *
 *   node scripts/context-cost-probe.mjs <agent dir> --loadout on|only|none [--json]
 *   node scripts/context-cost-probe.mjs <agent dir> --loadout none --generate 100 [--pinned] [--json]
 *
 * <agent dir> holds agents/*.md (for example scripts/orchestration-benchmark/agent-fixture).
 * --generate N writes N definitions to a temporary agent dir, cycling the given files
 * under new names; --pinned marks every one pinned.
 *
 * Method: a real Pi session (SDK, in process) with a faux provider records the first
 * provider request twice, once with this extension and once without. Pi itself renders
 * the system prompt (sections included) and the tool list, so the probe measures what a
 * provider receives. The other tools (Pi's default loadout), the codemode extension, its
 * mode and its inline budget (3000) are the same in both runs. Loadouts: on = codemode
 * active in mode on; only = codemode active in mode only; none = codemode inactive.
 * A declaration counts as JSON.stringify(toToolDeclaration(tool)).length: Pi's complete
 * declaration (name, description, parameters, constrainedSampling).
 * total = (system prompt with - without) + (sum of declarations with - without); the
 * codemode description is a declaration, so tool sections embedded in it count too.
 * subagent_agents with no argument and a launch of an agent outside the index run as faux
 * tool calls in loadout none (the management tools are direct there); the launched child is
 * a fake pi that records its agent name. The probe clears PI_SUBAGENT_* and PI_DENY_TOOLS so
 * it measures a root session. All sizes are characters; tokens are estimated as chars / 4.
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	toToolDeclaration,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export const LOADOUTS = ["on", "only", "none"];
export const INLINE_BUDGET = 3000;
export const CAPS = { total: 6000, section: 1600, agentsNoArg: 200 };
const EXTENSION_URL = new URL("../src/subagents.ts", import.meta.url);
const EXTENSION_TOOL = /^(subagent|caller_ping)/;

// Pi's own declaration shape, constrainedSampling included (codemode carries its grammar there).
const declarationChars = (tool) => JSON.stringify(toToolDeclaration(tool)).length;

function rootEnv() {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PI_SUBAGENT_") || key === "PI_DENY_TOOLS") delete process.env[key];
	}
}

let generation = 0;

/** One prompt in a real Pi session; returns every provider request and the text of each tool result. */
async function runSession({ agentDir, loadout, extension, replies }) {
	const cwd = mkdtempSync(join(tmpdir(), "cost-probe-cwd-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const piDir = mkdtempSync(join(tmpdir(), "cost-probe-pi-"));
	const requests = [];
	const faux = fauxProvider();
	const steps = replies ?? [fauxAssistantMessage("ok")];
	faux.setResponses(
		steps.map((reply) => async (context) => {
			requests.push({
				systemPrompt: getCurrentSystemPrompt(context.messages),
				tools: getCurrentTools(context.messages).map((tool) => ({
					name: tool.name,
					description: tool.description,
					chars: declarationChars(tool),
					// The declaration exactly as the request carries it (the faux provider serializes this object).
					request: JSON.stringify(tool),
				})),
				toolResults: context.messages
					.filter((message) => message.role === "toolResult")
					.map((message) => ({
						toolName: message.toolName,
						isError: message.isError === true,
						text: (message.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""),
					})),
			});
			return reply;
		}),
	);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(piDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(piDir, "models-store.json"),
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const mode = loadout === "only" ? "only" : "on";
	const factories = [];
	let module;
	if (extension) {
		generation += 1;
		module = await import(`${EXTENSION_URL.href}?probe=${generation}`);
		factories.push(module.default);
	}
	factories.push(createCodemodeExtension({ mode, inlineBudget: INLINE_BUDGET }));
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: piDir,
		extensionFactories: factories,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir: piDir,
		modelRuntime,
		model: faux.getModel(),
		resourceLoader,
		// The codemode factory fixes mode and inline budget; the setting only activates it.
		settingsManager: SettingsManager.inMemory(loadout === "none" ? {} : { defaultTools: ["+codemode"] }),
		// A persistent session: a lineage-only child needs a parent session file.
		sessionManager: SessionManager.create(cwd, join(piDir, "sessions")),
	});
	try {
		await session.bindExtensions({});
		await session.prompt("hello");
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		module?.resetSubagentStateForTest?.();
		rmSync(cwd, { recursive: true, force: true });
		rmSync(piDir, { recursive: true, force: true });
	}
	return requests;
}

const INDEX_SECTION = /<index>\n[\s\S]*?\n<\/index>/;

/** Sizes of one loadout with and without the extension (first request of a session). */
export async function measureLoadout(agentDir, loadout) {
	if (!LOADOUTS.includes(loadout)) throw new Error(`unknown loadout ${loadout}`);
	rootEnv();
	const [withExt] = await runSession({ agentDir, loadout, extension: true });
	const [without] = await runSession({ agentDir, loadout, extension: false });
	const sum = (request) => request.tools.reduce((total, tool) => total + tool.chars, 0);
	const codemode = (request) => request.tools.find((tool) => tool.name === "codemode");
	const sectionText = withExt.systemPrompt.match(INDEX_SECTION)?.[0] ?? "";
	const promptDelta = withExt.systemPrompt.length - without.systemPrompt.length;
	const declarationDelta = sum(withExt) - sum(without);
	return {
		loadout,
		section: sectionText.length,
		indexShown: (sectionText.match(/^- /gm) ?? []).length,
		indexOmitted: Number(sectionText.match(/^\+(\d+) more:/m)?.[1] ?? 0),
		declarations: withExt.tools
			.filter((tool) => EXTENSION_TOOL.test(tool.name))
			.map((tool) => ({ name: tool.name, chars: tool.chars })),
		codemodeDescription: {
			with: codemode(withExt)?.description.length ?? null,
			without: codemode(without)?.description.length ?? null,
		},
		tools: {
			with: withExt.tools.map(({ name, chars, request }) => ({ name, chars, request })),
			without: without.tools.map(({ name, chars, request }) => ({ name, chars, request })),
		},
		codemodeDeclaration: { with: codemode(withExt)?.chars ?? null, without: codemode(without)?.chars ?? null },
		otherTools: without.tools.map((tool) => tool.name),
		systemPrompt: { with: withExt.systemPrompt.length, without: without.systemPrompt.length, delta: promptDelta },
		declarationSum: { with: sum(withExt), without: sum(without), delta: declarationDelta },
		total: promptDelta + declarationDelta,
		indexText: sectionText,
	};
}

/** The text subagent_agents returns with no argument (loadout none, where it is direct). */
export async function measureAgentsNoArg(agentDir) {
	rootEnv();
	const requests = await runSession({
		agentDir,
		loadout: "none",
		extension: true,
		replies: [fauxAssistantMessage(fauxToolCall("subagent_agents", {})), fauxAssistantMessage("ok")],
	});
	const result = requests[1]?.toolResults.at(-1);
	const text = result?.text ?? "";
	const ok = result?.toolName === "subagent_agents" && !result.isError;
	return { chars: text.length, text, ok };
}

/** Launch an agent that the index does not list; a fake pi records the agent it was started as. */
export async function launchOutsideIndex(agentDir, agent) {
	rootEnv();
	const dir = mkdtempSync(join(tmpdir(), "cost-probe-launch-"));
	const marker = join(dir, "launched");
	const fakePi = join(dir, "fake-pi");
	writeFileSync(fakePi, `#!/bin/sh\nprintf '%s' "$PI_SUBAGENT_AGENT" > '${marker}'\nexit 0\n`);
	chmodSync(fakePi, 0o755);
	const artifactRoot = process.env.PI_ARTIFACT_PROJECT_ROOT;
	try {
		process.env.PI_SUBAGENT_PI_COMMAND = fakePi;
		// Run artifacts of the launch go to the temporary folder, not the user's history.
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(dir, "artifacts");
		const child = { agent, name: "probe-launch", title: "Probe launch outside index", task: "probe" };
		const requests = await runSession({
			agentDir,
			loadout: "none",
			extension: true,
			replies: [fauxAssistantMessage(fauxToolCall("subagent", { children: [child] })), fauxAssistantMessage("ok")],
		});
		const reply = requests[1]?.toolResults.at(-1)?.text ?? "";
		const launched = existsSync(marker) ? readFileSync(marker, "utf8") : null;
		return { agent, launched, works: launched === agent, reply };
	} finally {
		delete process.env.PI_SUBAGENT_PI_COMMAND;
		if (artifactRoot === undefined) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
		else process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		rmSync(dir, { recursive: true, force: true });
	}
}

/** N definitions in a new temporary agent dir, cycling the files of sourceDir/agents under new names. */
export function generateAgentDir(sourceDir, count, { pinned = false } = {}) {
	const files = readdirSync(join(sourceDir, "agents"))
		.filter((file) => file.endsWith(".md"))
		.sort();
	if (files.length === 0) throw new Error(`no agent files in ${sourceDir}/agents`);
	const dir = mkdtempSync(join(tmpdir(), "cost-probe-agents-"));
	mkdirSync(join(dir, "agents"));
	for (let i = 0; i < count; i++) {
		const name = `generated-${String(i + 1).padStart(3, "0")}`;
		let text = readFileSync(join(sourceDir, "agents", files[i % files.length]), "utf8");
		text = text.replace(/^name: .*$/m, `name: ${name}`);
		text = text.replace(/^pinned: .*\n/m, "");
		if (pinned) text = text.replace(/^name: .*$/m, (line) => `${line}\npinned: true`);
		// Self-contained: a launch resolves named skills, which a generated dir does not hold.
		text = text.replace(/^(?:skills|inject-skills): .*\n/gm, "");
		writeFileSync(join(dir, "agents", `${name}.md`), text);
	}
	return dir;
}

/** Every agent name in agentDir/agents that the index section does not list. */
export function agentsOutsideIndex(agentDir, indexText) {
	const shown = new Set([...indexText.matchAll(/^- ([^:]+):/gm)].map((match) => match[1]));
	return readdirSync(join(agentDir, "agents"))
		.filter((file) => file.endsWith(".md"))
		.map((file) =>
			readFileSync(join(agentDir, "agents", file), "utf8")
				.match(/^name: (.*)$/m)?.[1]
				?.trim(),
		)
		.filter((name) => name && !shown.has(name))
		.sort();
}

/** The full probe of one loadout: sizes, caps, and for a generated set the G1.2 extras. */
export async function probe(agentDir, loadout, { extras = false } = {}) {
	const result = await measureLoadout(agentDir, loadout);
	const report = { agentDir, ...result, caps: CAPS };
	// Fail closed: a missing index, a failed tool call or a missing launch fails, never counts as zero.
	const count = readdirSync(join(agentDir, "agents")).filter((file) => file.endsWith(".md")).length;
	report.pass = {
		total: result.total <= CAPS.total,
		section: result.section > 0 && result.section <= CAPS.section,
		indexCoverage: result.indexShown + result.indexOmitted === count,
	};
	if (extras) {
		const agents = await measureAgentsNoArg(agentDir);
		report.agentsNoArg = agents;
		report.pass.agentsNoArg = agents.ok && agents.chars > 0 && agents.chars <= CAPS.agentsNoArg;
		const outside = agentsOutsideIndex(agentDir, result.indexText);
		report.outsideLaunch = outside.length > 0 ? await launchOutsideIndex(agentDir, outside.at(-1)) : null;
		report.pass.outsideLaunch = report.outsideLaunch?.works === true;
	}
	return report;
}

function formatReport(report) {
	const lines = [
		`agent dir: ${report.agentDir}`,
		`loadout: ${report.loadout} (codemode inline budget ${INLINE_BUDGET}; other tools: ${report.otherTools.join(", ")})`,
		`section <index>: ${report.section} chars (${report.indexShown} agent lines, ${report.indexOmitted} omitted; cap ${CAPS.section})`,
		...["with", "without"].flatMap((side) =>
			report.tools[side].map((d) => `declaration (${side}) ${d.name}: ${d.chars} chars`),
		),
		`codemode description: with ${report.codemodeDescription.with ?? "-"}, without ${report.codemodeDescription.without ?? "-"} chars`,
		...(report.loadout === "only"
			? [
					`  of which embedded extension sections: ${report.codemodeDescription.with - report.codemodeDescription.without} chars (breakdown; already in the codemode declaration)`,
				]
			: []),
		`system prompt: with ${report.systemPrompt.with}, without ${report.systemPrompt.without}, delta ${report.systemPrompt.delta}`,
		`declarations: with ${report.declarationSum.with}, without ${report.declarationSum.without}, delta ${report.declarationSum.delta}`,
		`total: ${report.total} chars (about ${Math.round(report.total / 4)} tokens; cap ${CAPS.total})`,
	];
	if (report.agentsNoArg)
		lines.push(`subagent_agents (no argument): ${report.agentsNoArg.chars} chars (cap ${CAPS.agentsNoArg})`);
	if (report.outsideLaunch)
		lines.push(
			`launch outside index: ${report.outsideLaunch.agent} -> ${report.outsideLaunch.works ? "started" : "FAILED"}`,
		);
	lines.push(
		`pass: ${Object.entries(report.pass)
			.map(([k, v]) => `${k}=${v}`)
			.join(" ")}`,
	);
	return lines.join("\n");
}

async function main(argv) {
	const args = [...argv];
	const flag = (name) => {
		const at = args.indexOf(name);
		if (at < 0) return undefined;
		const [, value] = args.splice(at, 2);
		return value;
	};
	const bool = (name) => {
		const at = args.indexOf(name);
		if (at >= 0) args.splice(at, 1);
		return at >= 0;
	};
	const loadout = flag("--loadout");
	const generate = flag("--generate");
	const pinned = bool("--pinned");
	const json = bool("--json");
	const [source] = args;
	if (!source || !LOADOUTS.includes(loadout)) {
		console.error(
			"usage: node scripts/context-cost-probe.mjs <agent dir> --loadout on|only|none [--generate N [--pinned]] [--json]",
		);
		return 2;
	}
	const agentDir = generate ? generateAgentDir(source, Number(generate), { pinned }) : source;
	try {
		const report = await probe(agentDir, loadout, { extras: Boolean(generate) });
		delete report.indexText;
		console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
		return Object.values(report.pass).every(Boolean) ? 0 : 1;
	} finally {
		if (generate) rmSync(agentDir, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await main(process.argv.slice(2));
	// The extension leaves module timers; the report is complete here.
	process.exit();
}
