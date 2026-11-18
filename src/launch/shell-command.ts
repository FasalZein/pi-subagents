import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shellEscape } from "../mux.ts";
import type { ProgramLaunch, SurfaceFromEnv } from "../mux/backend.ts";
import { getInteractiveProcessFile } from "../session/interactive-process.ts";
import { getPiInvocation } from "./child-command.ts";
import {
	buildParentEnvSnapshot,
	type PaneIdentityPolicy,
	PREFIX_PANE_IDENTITY,
	paneIdentityCapsuleFields,
	resolveDenyEnvPatterns,
	withoutExactIdentityEnv,
} from "./child-env.ts";
import { disposeEnvCapsule, writeEnvCapsule } from "./env-capsule.ts";
import { buildInteractiveSentinelShellCommands } from "./interactive-sentinel.ts";
import { buildShellChangeDirectoryPrefix } from "./resume.ts";

export interface InteractiveShellCommandInput {
	cwd?: string;
	/** Raw pi argv (unescaped); the capsule carries it as structured data. */
	piArgs: string[];
	/** Controlled launch overrides: frontmatter `env:` plus PI_* control vars. */
	envOverrides: Record<string, string>;
	/** Agent frontmatter `deny-env` spec; unioned with PI_SUBAGENT_ENV_DENY. */
	denyEnv?: string;
	doneSentinelFile: string;
	/** Derive PI_SUBAGENT_SURFACE from this name of the child's surface env (a direct-program session). */
	surfaceFromEnv?: SurfaceFromEnv;
	/** Identity names of the child's surface (the backend adapter's paneIdentity); undefined: v2.9.2 prefixes. */
	paneIdentity: PaneIdentityPolicy | undefined;
}

export interface InteractiveShellCommand {
	/** The string typed or staged into the child pane. Paths only — never env data. */
	command: string;
	/** The same launch for a direct-program session: shell command and launcher argv. */
	launch: ProgramLaunch;
	capsulePath: string;
	/**
	 * Delete the capsule. Call only when the launch failed before the pane's
	 * launcher could consume it; after a successful send the pane owns the file.
	 */
	dispose: () => void;
}

export function getRunChildLauncherPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "run-child.mjs");
}

/**
 * Build the single interactive launch command used by initial launch, resume,
 * and timeout wrap-up.
 *
 * The observable pane command carries only the sentinel trap, the cd prefix,
 * and two paths (launcher + capsule). The pi argv and the environment travel
 * inside the one-shot capsule, which the launcher unlinks before spawning.
 */
export function buildInteractiveShellCommand(input: InteractiveShellCommandInput): InteractiveShellCommand {
	const invocation = getPiInvocation(input.piArgs);
	const paneIdentity = input.paneIdentity ?? PREFIX_PANE_IDENTITY;
	const capsulePath = writeEnvCapsule({
		command: invocation.command,
		args: invocation.args,
		...(input.cwd ? { cwd: input.cwd } : {}),
		parentEnv: withoutExactIdentityEnv(
			buildParentEnvSnapshot(process.env, resolveDenyEnvPatterns(input.denyEnv)),
			paneIdentity,
		),
		overrides: input.envOverrides,
		...paneIdentityCapsuleFields(paneIdentity),
		processIdFile: getInteractiveProcessFile(input.doneSentinelFile),
		...(input.surfaceFromEnv ? { surfaceFromEnv: { ...input.surfaceFromEnv } } : {}),
	});
	const sentinel = buildInteractiveSentinelShellCommands(input.doneSentinelFile);
	const launcherArgv = [process.execPath, getRunChildLauncherPath(), capsulePath];
	const launcher = launcherArgv.map(shellEscape).join(" ");
	const command =
		`trap ${shellEscape(sentinel.exitTrap)} EXIT; ` +
		`${buildShellChangeDirectoryPrefix(input.cwd)}${launcher}; ${sentinel.direct}`;
	return {
		command,
		launch: { shellCommand: command, launcherArgv, ...(input.cwd ? { cwd: input.cwd } : {}) },
		capsulePath,
		dispose: () => disposeEnvCapsule(capsulePath),
	};
}
