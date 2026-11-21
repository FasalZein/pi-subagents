import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentDefaults } from "../agents/definitions.ts";
import { ChildSessionStorage } from "../session/child-session-storage.ts";
import { resolveEffectiveSessionMode, type SubagentSessionMode } from "../session/session-files.ts";
import type { SubagentParamsInput } from "../types.ts";
import { buildChildContextBoundary, isChildContextBoundaryDisabled } from "./context-boundary.ts";
import { definitionRunsInMemory, resolveSubagentNoSession } from "./policy.ts";
import type { PreparedSubagentLaunch, SubagentLaunchContext } from "./prep.ts";

/** The session a child gets: its seed mode, or an empty Pi in-memory session that ignores any seed. */
export type ChildSessionKind = SubagentSessionMode | "in-memory";

/**
 * The session a launch of this definition gives the child, by the rules of the
 * launch (getChildSeedMode, getPreparedSessionLaunchArgs), so the index and the
 * agent detail say what the child sees (D19, D13).
 */
export function resolveChildSessionKind(agentDefs: AgentDefaults | null): ChildSessionKind {
	if (definitionRunsInMemory(agentDefs)) return "in-memory";
	const noSession = resolveSubagentNoSession(agentDefs);
	return getChildSeedMode(resolveEffectiveSessionMode({}, agentDefs), noSession) ?? "standalone";
}

export function getNoSessionSeedMode(
	sessionMode: SubagentSessionMode,
): Exclude<SubagentSessionMode, "standalone"> | null {
	if (sessionMode === "standalone") return null;
	return "fork";
}

function getChildSeedMode(
	sessionMode: SubagentSessionMode,
	noSession: boolean,
): Exclude<SubagentSessionMode, "standalone"> | null {
	if (noSession) return getNoSessionSeedMode(sessionMode);
	return sessionMode === "standalone" ? null : sessionMode;
}

function shouldWriteChildContextBoundary(seedMode: Exclude<SubagentSessionMode, "standalone"> | null): boolean {
	return seedMode === "fork" && !isChildContextBoundaryDisabled();
}

export function seedPreparedSubagentSession(
	prepared: PreparedSubagentLaunch,
	params: Pick<SubagentParamsInput, "name">,
	ctx: Pick<SubagentLaunchContext, "cwd" | "sessionManager">,
	sessionMode: SubagentSessionMode,
	noSession: boolean,
	forcedCwd?: string,
): {
	seedMode: Exclude<SubagentSessionMode, "standalone"> | null;
	boundarySystemPrompt: boolean;
} {
	const seedMode = getChildSeedMode(sessionMode, noSession);
	const boundarySystemPrompt = shouldWriteChildContextBoundary(seedMode);
	// The child's exit record lands beside its session file; an in-memory standalone child writes no
	// file there, so its directory must exist before the first exit record (T73).
	mkdirSync(dirname(prepared.subagentSessionFile), { recursive: true });
	const storage = new ChildSessionStorage(prepared.subagentSessionFile);
	// The header's cwd becomes the child pi's project root when it continues the session (see below).
	const sessionCwd = forcedCwd ?? prepared.runtimePaths.effectiveCwd ?? ctx.cwd;
	if (!seedMode && sessionMode === "standalone" && !noSession) {
		// Without a file here, Pi would create the session at the first spawn, after the launch coordinator
		// skipped its launch metadata, and a resume would lose the agent's deny-env. A header without a
		// parent session keeps standalone free of lineage and lets the metadata land before the spawn.
		storage.writeStandaloneHeader(sessionCwd, prepared.sessionTitle);
	}
	if (seedMode) {
		if (!prepared.sessionFile) {
			throw new Error(
				`Cannot launch ${seedMode} subagent: no parent session file. ` +
					`Use session-mode: standalone in the agent frontmatter, ` +
					`or start pi with a persistent session (--session or --session-dir).`,
			);
		}
		// The seeded session header's cwd becomes the child pi's project root
		// when it continues the session, so a forced-cwd child (verified
		// fan-out candidates in their worktrees) must record where it actually
		// runs — not the blueprint cwd the launch was resolved against.
		storage.seed(seedMode, prepared.sessionFile, sessionCwd, {
			...(prepared.sessionTitle ? { sessionName: prepared.sessionTitle } : {}),
			activeLeafId: ctx.sessionManager.getLeafId?.(),
		});
		if (boundarySystemPrompt) {
			const spawnPolicy = prepared.spawnPolicy;
			const boundaryOptions = {
				name: params.name,
				spawningAllowed: spawnPolicy ? spawnPolicy.childBudget !== null : !!prepared.agentDefs?.spawning,
				spawnableAgents: spawnPolicy?.spawnableAgents ?? [],
				spawnBudget: spawnPolicy?.childBudget ?? null,
				spawnWidth: spawnPolicy?.effectiveWidth ?? null,
			};
			storage.writeBoundary(boundaryOptions, buildChildContextBoundary(boundaryOptions));
		}
	}
	storage.writeExtensionEntry(prepared.effectiveExtensions);
	return { seedMode, boundarySystemPrompt };
}
