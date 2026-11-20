import { parseEnvString } from "../launch/env.ts";
import { resolveHerdrPlacementPolicy, resolveRexPlacementPolicy, resolveZellijPlacementPolicy } from "../mux.ts";
import type { PersistedSubagentLaunchMetadata } from "../session/session-files.ts";

export function resolveResumeHerdrPlacementPolicy(
	launchMetadata: PersistedSubagentLaunchMetadata | undefined,
	parentPolicy: string | undefined,
): ReturnType<typeof resolveHerdrPlacementPolicy> | undefined {
	const agentPolicy = parseEnvString(launchMetadata?.env).PI_SUBAGENT_HERDR_PLACEMENT;
	if (agentPolicy !== undefined) return resolveHerdrPlacementPolicy(agentPolicy);
	if (parentPolicy !== undefined) return resolveHerdrPlacementPolicy(parentPolicy);
	return launchMetadata?.herdrPlacementPolicy;
}

/** Same precedence as Herdr: persisted per-agent env, then the current parent default, then the persisted policy. */
export function resolveResumeRexPlacementPolicy(
	launchMetadata: PersistedSubagentLaunchMetadata | undefined,
	parentPolicy: string | undefined,
): ReturnType<typeof resolveRexPlacementPolicy> {
	const agentPolicy = parseEnvString(launchMetadata?.env).PI_SUBAGENT_REX_PLACEMENT;
	if (agentPolicy !== undefined) return resolveRexPlacementPolicy(agentPolicy);
	if (parentPolicy !== undefined) return resolveRexPlacementPolicy(parentPolicy);
	// The saved value is checked too, and old metadata without one gets the default.
	return resolveRexPlacementPolicy(launchMetadata?.rexPlacementPolicy);
}

export function resolveResumeZellijPlacementPolicy(
	launchMetadata: PersistedSubagentLaunchMetadata | undefined,
	parentPolicy: string | undefined,
): ReturnType<typeof resolveZellijPlacementPolicy> | undefined {
	const agentPolicy = parseEnvString(launchMetadata?.env).PI_SUBAGENT_ZELLIJ_PLACEMENT;
	if (agentPolicy !== undefined) return resolveZellijPlacementPolicy(agentPolicy);
	if (parentPolicy !== undefined) return resolveZellijPlacementPolicy(parentPolicy);
	return launchMetadata?.zellijPlacementPolicy;
}
