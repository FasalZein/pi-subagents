import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type ParsedSpawnEnv, parseSpawnEnv, resolveSpawnPolicy, type SpawnPolicyResult } from "../spawn/policy.ts";
import { normalizeVerifierModelRef } from "../vf/model-ref.ts";

export interface AgentDefaults {
	enabled?: boolean;
	model?: string;
	allowedModels?: string;
	allowModelOverride?: boolean;
	tools?: string;
	skills?: string;
	injectSkills?: string;
	extensions?: string;
	thinking?: string;
	denyTools?: string;
	spawning?: true | string[] | false;
	spawnDepth?: number;
	spawnWidth?: number;
	visibleTo?: string[];
	autoExit?: boolean;
	systemPromptMode?: "append" | "replace";
	cwd?: string;
	cwdBase?: string;
	path?: string;
	body?: string;
	mode?: "interactive" | "background";
	sessionMode?: "standalone" | "lineage-only" | "fork";
	async?: boolean;
	noContextFiles?: boolean;
	inheritAppendSystem?: boolean;
	noSession?: boolean;
	trustProject?: boolean;
	taskExpansion?: "shell";
	/** Wall-clock seconds a child may run before the parent kills it. */
	timeout?: number;
	/** Seconds a child may go without session growth before the parent kills it. */
	idleTimeout?: number;
	/** Raw `timeout-warn-threshold` value; launch policy validates it. */
	timeoutWarnThreshold?: string;
	/** What the parent allows after a timeout kill. Defaults to `report`. */
	onTimeout?: "report" | "block-resume";
	/**
	 * `llm-as-a-verifier` frontmatter flag. Marks every launch of this
	 * definition as a verified fan-out (ticket 01 owns the boolean only; the
	 * count/model/criteria siblings are parsed below (ticket 10).
	 */
	llmAsVerifier?: boolean;
	/**
	 * `llm-as-a-verifier-candidates`: candidate count for the fan-out
	 * (integer >= 2; default resolved at pre-flight, env/3).
	 */
	llmAsVerifierCandidates?: number;
	/**
	 * `llm-as-a-verifier-model`: verifier override as a canonical
	 * `provider/model[:thinking]` ref; null means the default verifier profile.
	 */
	llmAsVerifierModel?: string | null;
	/**
	 * `llm-as-a-verifier-criteria`: built-in rubric name or path, stored
	 * verbatim; resolved to an absolute file at pre-flight.
	 */
	llmAsVerifierCriteria?: string;
	contextWarnThreshold?: string;
	contextWarnStep?: string;
	reportContextUsage?: boolean;

	flags?: string;
	env?: string;
	/** Comma- or newline-separated env names (with `*` globs) excluded from the inherited parent env. */
	denyEnv?: string;
	parentClosePolicy?: "terminate" | "continue";
}

export interface ResolvedAgentDefinition extends AgentDefaults {
	name: string;
	description?: string;
	source: "project" | "global";
	path: string;
	/** `pinned: true` puts the agent first in the index (D19). */
	pinned?: boolean;
}

/** An enabled agent file whose frontmatter failed to parse (D24). */
export interface MalformedAgentFile {
	name: string;
	source: "project" | "global";
	path: string;
	error: string;
	/**
	 * The visible-to the file states, read apart from the error. An unterminated
	 * header is read to the end of the file, as its name is; without the key the
	 * default ("all") holds. An invalid value gives [] (no caller).
	 */
	visibleTo: string[];
}

type ParsedAgentFile =
	| { kind: "agent"; definition: ResolvedAgentDefinition }
	| { kind: "malformed"; file: MalformedAgentFile };

export interface AgentCatalog {
	/** Valid definitions after project files shadow global ones. */
	definitions: ResolvedAgentDefinition[];
	/** Every enabled malformed file, including ones a valid project file shadows. */
	malformedFiles: MalformedAgentFile[];
	/** The effective entry for a name: a project file shadows a global one even when malformed. */
	lookup(name: string): ParsedAgentFile | undefined;
}

export function getAgentConfigDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function parseAgentDefinition(
	path: string,
	source: "project" | "global",
	cwdBase: string,
	includeDisabled = false,
): ParsedAgentFile | null {
	const content = readFileSync(path, "utf8");
	try {
		const definition = parseAgentDefinitionContent(content, path, source, cwdBase, includeDisabled);
		return definition ? { kind: "agent", definition } : null;
	} catch (error) {
		// An unterminated header has no closing line: read its keys to the end of the file.
		const frontmatter = content.match(/^---\r?\n([\s\S]*?)(?:\n---|$)/)?.[1] ?? "";
		const get = (key: string) => frontmatter.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"))?.[1].trim();
		// A disabled file is never launched, so its parse error is not news.
		if (get("enabled") === "false") return null;
		const message = error instanceof Error ? error.message : String(error);
		return {
			kind: "malformed",
			file: {
				name: get("name") ?? basename(path, ".md"),
				source,
				path,
				error: message,
				visibleTo: readVisibleTo(content),
			},
		};
	}
}

/**
 * The visibility of a file that failed to parse, by the same header match and
 * key reading as a valid file. When it cannot be read, no caller sees the
 * file: an unrelated error must never widen its visibility.
 */
function readVisibleTo(content: string): string[] {
	// Same header read as the name of a malformed file: an unterminated header runs to the end.
	const frontmatter = content.match(/^---\r?\n([\s\S]*?)(?:\n---|$)/)?.[1];
	if (frontmatter === undefined) return [];
	try {
		return parseVisibleTo(frontmatter.match(/^visible-to:[ \t]*(.+)$/m)?.[1].trim());
	} catch {
		return [];
	}
}

function parseAgentDefinitionContent(
	content: string,
	path: string,
	source: "project" | "global",
	cwdBase: string,
	includeDisabled: boolean,
): ResolvedAgentDefinition | null {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) {
		// Plain Markdown is not an agent file. A file that opens a frontmatter
		// header is one: skipping it would let a global agent of the same name
		// launch in its place (D24).
		if (!/^---\r?\n/.test(content)) return null;
		throw new Error('Frontmatter that opens with "---" needs a key line and a closing "---" line (LF line endings).');
	}
	const frontmatter = match[1];
	const get = (key: string) => {
		const m = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"));
		return m ? m[1].trim() : undefined;
	};
	const hasKey = (key: string) => new RegExp(`^${key}:`, "m").test(frontmatter);
	const getBlock = (key: string) => {
		const inline = get(key);
		if (inline !== "|") return inline;
		const lines = frontmatter.split(/\r?\n/);
		const start = lines.findIndex((line) => line.match(new RegExp(`^${key}:\\s*\\|\\s*$`)));
		if (start === -1) return inline;
		const block: string[] = [];
		for (let i = start + 1; i < lines.length; i++) {
			const line = lines[i];
			if (line.trim() && !line.match(/^[ \t]/)) break;
			block.push(line.replace(/^[ \t]{1,2}/, ""));
		}
		return block.join("\n").trim();
	};
	const enabledRaw = get("enabled");
	if (enabledRaw === "false" && !includeDisabled) return null;
	const spawningRaw = get("spawning");
	const autoExitRaw = get("auto-exit");
	const allowModelOverrideRaw = get("allow-model-override");
	const modeRaw = get("mode");
	const sessionModeRaw = get("session-mode");
	const asyncRaw = get("async");
	const noContextFilesRaw = get("no-context-files");
	const inheritAppendSystemRaw = get("inherit-append-system");
	const noSessionRaw = get("no-session");
	const trustProjectRaw = get("trust-project");
	const taskExpansionRaw = get("task-expansion");
	const timeoutRaw = get("timeout");
	const idleTimeoutRaw = get("idle-timeout");
	const timeoutWarnThresholdRaw = get("timeout-warn-threshold");
	const onTimeoutRaw = get("on-timeout");
	const contextWarnThresholdRaw = get("context-warn-threshold");
	const contextWarnStepRaw = get("context-warn-step");
	const reportContextUsageRaw = get("report-context-usage");
	const llmAsVerifier = parseLlmAsVerifier(get("llm-as-a-verifier"), hasKey("llm-as-a-verifier"), path);
	const llmAsVerifierCandidates = parseLlmAsVerifierCandidates(
		get("llm-as-a-verifier-candidates"),
		hasKey("llm-as-a-verifier-candidates"),
		path,
	);
	const llmAsVerifierModel = parseLlmAsVerifierModel(
		get("llm-as-a-verifier-model"),
		hasKey("llm-as-a-verifier-model"),
		path,
	);
	const llmAsVerifierCriteria = parseLlmAsVerifierCriteria(
		get("llm-as-a-verifier-criteria"),
		hasKey("llm-as-a-verifier-criteria"),
		path,
	);
	const spawnDepthRaw = get("spawn-depth");
	const spawnWidthRaw = get("spawn-width");

	const systemPromptRaw = get("system-prompt");
	const extensionsRaw = get("extensions");
	const injectSkillsRaw = get("inject-skills");
	const flagsRaw = get("flags");
	const parentClosePolicyRaw = get("parent-close-policy");
	const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
	const spawning = parseSpawning(spawningRaw);
	const spawnDepth = parsePositiveInteger("spawn-depth", spawnDepthRaw, hasKey("spawn-depth"));
	const spawnWidth = parsePositiveInteger("spawn-width", spawnWidthRaw, hasKey("spawn-width"));
	// A malformed budget must never resolve to "unbounded": that turns a typo
	// into the exact runaway the field exists to prevent.
	const timeout = parsePositiveInteger("timeout", timeoutRaw, hasKey("timeout"));
	const idleTimeout = parsePositiveInteger("idle-timeout", idleTimeoutRaw, hasKey("idle-timeout"));
	const onTimeout = parseOnTimeout(onTimeoutRaw, hasKey("on-timeout"), path);
	const visibleTo = parseVisibleTo(get("visible-to"));
	return {
		name: get("name") ?? basename(path, ".md"),
		description: get("description"),
		source,
		path,
		// Only the literal "false" disables; unrecognized values stay enabled.
		enabled: enabledRaw === undefined ? undefined : enabledRaw !== "false",
		model: get("model"),
		allowedModels: get("allowed-models"),
		allowModelOverride: allowModelOverrideRaw != null ? allowModelOverrideRaw === "true" : undefined,
		tools: get("tools"),
		skills: get("skills"),
		injectSkills: injectSkillsRaw,
		extensions: extensionsRaw,
		thinking: get("thinking"),
		denyTools: get("deny-tools"),
		spawning,
		...(spawnDepth !== undefined ? { spawnDepth } : {}),
		...(spawnWidth !== undefined ? { spawnWidth } : {}),
		visibleTo,
		autoExit: autoExitRaw != null ? autoExitRaw === "true" : undefined,
		...(get("pinned") === "true" ? { pinned: true } : {}),
		systemPromptMode: systemPromptRaw === "append" || systemPromptRaw === "replace" ? systemPromptRaw : undefined,
		cwd: get("cwd"),
		cwdBase,
		body: body || undefined,
		sessionMode:
			sessionModeRaw === "standalone" || sessionModeRaw === "lineage-only" || sessionModeRaw === "fork"
				? sessionModeRaw
				: undefined,
		async: asyncRaw != null ? asyncRaw === "true" : undefined,
		noContextFiles: noContextFilesRaw != null ? noContextFilesRaw === "true" : undefined,
		inheritAppendSystem: inheritAppendSystemRaw === "true",
		noSession: noSessionRaw != null ? noSessionRaw === "true" : undefined,
		trustProject: trustProjectRaw != null ? trustProjectRaw === "true" : undefined,
		mode: modeRaw === "background" || modeRaw === "interactive" ? modeRaw : undefined,
		taskExpansion: taskExpansionRaw === "shell" ? "shell" : undefined,
		...(timeout !== undefined ? { timeout } : {}),
		...(idleTimeout !== undefined ? { idleTimeout } : {}),
		timeoutWarnThreshold: timeoutWarnThresholdRaw,
		onTimeout,
		llmAsVerifier,
		...(llmAsVerifierCandidates !== undefined ? { llmAsVerifierCandidates } : {}),
		...(llmAsVerifierModel !== undefined ? { llmAsVerifierModel } : {}),
		...(llmAsVerifierCriteria !== undefined ? { llmAsVerifierCriteria } : {}),
		contextWarnThreshold: contextWarnThresholdRaw,
		contextWarnStep: contextWarnStepRaw,
		reportContextUsage: reportContextUsageRaw != null ? reportContextUsageRaw === "true" : undefined,

		flags: flagsRaw,
		env: getBlock("env"),
		denyEnv: getBlock("deny-env"),
		parentClosePolicy:
			parentClosePolicyRaw === "terminate" || parentClosePolicyRaw === "continue" ? parentClosePolicyRaw : undefined,
	};
}

const RESERVED_SPAWNING_NAMES = new Set(["root", "all", "true", "false"]);

function parseCommaSeparated(value: string): string[] {
	return value
		.split(",")
		.map((token) => token.trim())
		.filter(Boolean);
}

function parseSpawning(raw: string | undefined): true | string[] | false {
	if (raw === undefined || raw === "false") return false;
	if (raw === "true") return true;
	const names = parseCommaSeparated(raw);
	for (const name of names) {
		if (RESERVED_SPAWNING_NAMES.has(name)) {
			throw new Error(`Invalid spawning value: reserved agent name "${name}" cannot appear in a spawn list.`);
		}
	}
	return names;
}

function parsePositiveInteger(key: string, raw: string | undefined, present: boolean): number | undefined {
	if (!present) return undefined;
	if (raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
		throw new Error(`${key} must be a positive safe integer greater than 0.`);
	}
	return Number(raw);
}

/**
 * Resolve the `on-timeout` policy, rejecting anything unrecognised.
 *
 * This one fails closed on purpose. Silently taking the permissive default
 * would mean a typo like `block-resuem` re-enables resume for exactly the
 * agent that asked to be protected from a second partial run.
 */
function parseOnTimeout(
	raw: string | undefined,
	present: boolean,
	path: string,
): "report" | "block-resume" | undefined {
	if (!present) return undefined;
	if (raw === "report" || raw === "block-resume") return raw;
	throw new Error(`on-timeout must be "report" or "block-resume" (got ${JSON.stringify(raw ?? "")}) in ${path}.`);
}

/**
 * Resolve the `llm-as-a-verifier` flag, rejecting anything but `true`/`false`.
 *
 * The candidate count moved to `llm-as-a-verifier-candidates` (ticket 10), so
 * an integer here is a stale or mistyped definition. Accepting it would either
 * guess a count the author meant to put on the sibling field or silently run
 * the default — both wrong, so it fails agent loading instead.
 */
function parseLlmAsVerifier(
	raw: string | undefined,
	present: boolean,
	path: string,
): boolean | undefined {
	if (!present) return undefined;
	if (raw === "true" || raw === "false") return raw === "true";
	throw new Error(`llm-as-a-verifier must be "true" or "false" (got ${JSON.stringify(raw ?? "")}) in ${path}.`);
}

/**
 * Resolve `llm-as-a-verifier-candidates`. Invalid values fail agent loading
 * rather than falling back to the default: a typo must never silently turn a
 * 5-candidate fan-out into 3.
 */
function parseLlmAsVerifierCandidates(
	raw: string | undefined,
	present: boolean,
	path: string,
): number | undefined {
	if (!present) return undefined;
	const message = `llm-as-a-verifier-candidates must be an integer >= 2 (got ${JSON.stringify(raw ?? "")}) in ${path}.`;
	if (raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 2) {
		throw new Error(message);
	}
	return Number(raw);
}

/**
 * Resolve `llm-as-a-verifier-model`, storing the canonical ref. The value is
 * validated here so an unparseable ref fails agent loading — before any
 * candidate spend — instead of exploding inside the bridge later.
 */
function parseLlmAsVerifierModel(
	raw: string | undefined,
	present: boolean,
	path: string,
): string | null | undefined {
	if (!present) return undefined;
	if (raw === undefined || !raw.trim()) {
		throw new Error(`llm-as-a-verifier-model must be a verifier profile name or provider/model[:thinking] (got ${JSON.stringify(raw ?? "")}) in ${path}.`);
	}
	try {
		return normalizeVerifierModelRef(raw).normalizedRef;
	} catch (error) {
		throw new Error(`llm-as-a-verifier-model: ${(error as Error).message} in ${path}.`);
	}
}

/**
 * Resolve `llm-as-a-verifier-criteria`. The value is stored verbatim — a
 * built-in name or a path — and resolved to an absolute file at pre-flight
 * (ticket 10), where an unresolvable file aborts the launch before any spend.
 */
function parseLlmAsVerifierCriteria(
	raw: string | undefined,
	present: boolean,
	path: string,
): string | undefined {
	if (!present) return undefined;
	if (raw === undefined || !raw.trim()) {
		throw new Error(
			`llm-as-a-verifier-criteria must be a built-in name (generic, code-change, research) or a path (got ${JSON.stringify(raw ?? "")}) in ${path}.`,
		);
	}
	return raw.trim();
}

function parseVisibleTo(raw: string | undefined): string[] {
	if (raw === undefined) return ["all"];
	const names = parseCommaSeparated(raw);
	if (names.includes("all") && names.length > 1) {
		throw new Error('visible-to cannot mix "all" with other agent names.');
	}
	return names;
}

type ResolveAgentCwd = (cwdHint: string | null, baseCwd: string) => string;

export function getEffectiveAgentDefinitions(
	baseCwd = process.cwd(),
	options: { includeDisabled?: boolean } = {},
): ResolvedAgentDefinition[] {
	return loadAgentCatalog(baseCwd, options).definitions;
}

/**
 * Load every agent file. A malformed file is isolated: it never stops the
 * other files from loading, and its name resolves to the parse error (D24).
 */
export function loadAgentCatalog(baseCwd = process.cwd(), options: { includeDisabled?: boolean } = {}): AgentCatalog {
	const configDir = getAgentConfigDir();
	const agents = new Map<string, ParsedAgentFile>();
	const malformedFiles: MalformedAgentFile[] = [];
	const dirs = [
		{
			path: join(configDir, "agents"),
			source: "global" as const,
			cwdBase: configDir,
		},
		{
			path: join(baseCwd, ".pi", "agents"),
			source: "project" as const,
			cwdBase: baseCwd,
		},
	];
	for (const { path: dir, source, cwdBase } of dirs) {
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)
			.filter((entry) => entry.endsWith(".md"))
			.sort((a, b) => a.localeCompare(b))) {
			const parsed = parseAgentDefinition(join(dir, file), source, cwdBase, options.includeDisabled === true);
			if (!parsed) continue;
			if (parsed.kind === "malformed") malformedFiles.push(parsed.file);
			agents.set(parsed.kind === "agent" ? parsed.definition.name : parsed.file.name, parsed);
		}
	}
	const definitions = [...agents.values()]
		.flatMap((entry) => (entry.kind === "agent" ? [entry.definition] : []))
		.sort((a, b) => a.name.localeCompare(b.name));
	return { definitions, malformedFiles, lookup: (name) => agents.get(name) };
}

/**
 * One session notice naming every malformed agent file, or null when there is none.
 * Only a file whose name resolves to a malformed entry is called refused; a file that a
 * valid definition of the same name shadows is listed apart, since that name launches (D19).
 */
export function formatMalformedAgentNotice(catalog: Pick<AgentCatalog, "malformedFiles" | "lookup">): string | null {
	const refused: MalformedAgentFile[] = [];
	const shadowed: MalformedAgentFile[] = [];
	for (const file of catalog.malformedFiles) {
		(catalog.lookup(file.name)?.kind === "agent" ? shadowed : refused).push(file);
	}
	const list = (files: MalformedAgentFile[]) => files.map((file) => `- ${file.path}: ${file.error}`).join("\n");
	const sections = [
		refused.length > 0
			? `Skipped ${refused.length} malformed agent file(s); launches of these agents are refused:\n${list(refused)}`
			: "",
		shadowed.length > 0
			? `Skipped ${shadowed.length} malformed agent file(s) that a valid definition of the same name shadows; that definition takes their place:\n${list(shadowed)}`
			: "",
	].filter(Boolean);
	return sections.length > 0 ? sections.join("\n") : null;
}

/**
 * Rewrite the `enabled` frontmatter key of an agent file in place.
 *
 * Only the `enabled:` line changes; the rest of the file is preserved
 * byte-for-byte, so comments, key order, and the agent body survive. The key
 * is appended to the frontmatter block when the file does not set it yet.
 * Node fs only — no shell, so the behavior is identical on every platform.
 */
export function setAgentEnabled(agentPath: string, enabled: boolean): void {
	const content = readFileSync(agentPath, "utf8");
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match || match.index === undefined) throw new Error(`No frontmatter block in ${agentPath}.`);
	const value = enabled ? "true" : "false";
	const lines = match[1].split("\n");
	const enabledIndex = lines.findIndex((line) => /^enabled:/.test(line));
	if (enabledIndex === -1) lines.push(`enabled: ${value}`);
	else lines[enabledIndex] = `enabled: ${value}`;
	const block = `---\n${lines.join("\n")}\n---`;
	writeFileSync(agentPath, content.slice(0, match.index) + block + content.slice(match.index + match[0].length));
}

export function loadAgentDefaults(
	agentName: string,
	cwdHint: string | null | undefined,
	baseCwd: string,
	resolveAgentCwd: ResolveAgentCwd,
): AgentDefaults | null {
	const resolvedBaseCwd = resolveAgentCwd(cwdHint ?? null, baseCwd);
	const entry = loadAgentCatalog(resolvedBaseCwd).lookup(agentName);
	if (entry?.kind === "malformed") {
		// The grant comes first: only a caller that may launch the agent learns its file and parse error.
		const policy = malformedFileSpawnPolicy(entry.file, parseSpawnEnv(process.env));
		if (!policy.allowed) throw new Error(`Error: ${policy.reason ?? "Spawn policy denied this target."}`);
		throw new Error(`Agent "${agentName}" is malformed in ${entry.file.path}: ${entry.file.error}`);
	}
	return entry?.definition ?? null;
}

/** The spawn policy for a malformed file: its stated visibility, no spawning of its own. */
export function malformedFileSpawnPolicy(file: MalformedAgentFile, spawnEnv: ParsedSpawnEnv): SpawnPolicyResult {
	return resolveSpawnPolicy({
		callerAgent: spawnEnv.callerAgent,
		targetAgent: file.name,
		callerBudget: spawnEnv.callerBudget,
		callerSpawnable: spawnEnv.callerSpawnable,
		targetSpawning: false,
		targetSpawnDepth: undefined,
		targetSpawnWidth: undefined,
		targetVisibleTo: file.visibleTo,
		envDepthCeiling: spawnEnv.envDepthCeiling,
		envWidthCeiling: spawnEnv.envWidthCeiling,
	});
}
