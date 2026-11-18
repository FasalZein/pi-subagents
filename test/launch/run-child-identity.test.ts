import {
	buildParentEnvSnapshot,
	HERDR_CORE_PANE_IDENTITY,
	HERDR_PANE_IDENTITY,
	type PaneIdentityPolicy,
	PREFIX_PANE_IDENTITY,
	paneIdentityCapsuleFields,
	REX_PANE_IDENTITY,
	resolveDenyEnvPatterns,
	withoutExactIdentityEnv,
} from "../../src/launch/child-env.ts";
import { writeEnvCapsule } from "../../src/launch/env-capsule.ts";
import type { MuxBackendAdapter } from "../../src/mux/backend.ts";
import { cmuxBackend } from "../../src/mux/cmux.ts";
import { herdrBackend } from "../../src/mux/herdr-backend.ts";
import { tmuxBackend } from "../../src/mux/tmux.ts";
import { weztermBackend } from "../../src/mux/wezterm.ts";
import { zellijBackend } from "../../src/mux/zellij.ts";
import { makeProbeDir, presenceProbeCommand, runLauncherInSurface } from "../support/env-presence.ts";
import { assert, describe, it } from "../support/index.ts";

// Spec D34: herdr-core, Rex and old herdr copy only exact identity names. All values are synthetic markers.
const EXACT_BACKENDS: Array<{ label: string; policy: PaneIdentityPolicy; privateMarker: string }> = [
	{ label: "herdr-core", policy: HERDR_CORE_PANE_IDENTITY, privateMarker: "HC_PROBE_PRIVATE" },
	{ label: "Rex", policy: REX_PANE_IDENTITY, privateMarker: "REX_PROBE_PRIVATE" },
	{ label: "old herdr", policy: HERDR_PANE_IDENTITY, privateMarker: "HERDR_PROBE_PRIVATE" },
];

function identityNames(policy: PaneIdentityPolicy): string[] {
	return policy.kind === "exact" ? [...policy.required, ...policy.optional] : [];
}

function requiredNames(policy: PaneIdentityPolicy): string[] {
	return policy.kind === "exact" ? [...policy.required] : [];
}

const PARENT_ENV = {
	T44_ALLOWED_MARKER: "allowed",
	T44_DENIED_MARKER: "denied",
	T44_WILD_DENY_A: "wild",
};
const DENY_ENV = "T44_DENIED_MARKER, T44_WILD_DENY_*, T44_PANE_DENIED";

/** Build the capsule as the parent does: deny-filtered snapshot without the policy's identity names. */
function launch(
	policy: PaneIdentityPolicy,
	parentEnv: Record<string, string>,
	overrides: Record<string, string>,
	probe: { command: string; args: string[] },
	dir: string,
): string {
	return writeEnvCapsule(
		{
			...probe,
			parentEnv: withoutExactIdentityEnv(
				buildParentEnvSnapshot(parentEnv, resolveDenyEnvPatterns(DENY_ENV, {})),
				policy,
			),
			overrides,
			...paneIdentityCapsuleFields(policy),
		},
		dir,
	);
}

describe("run-child exact identity names (D34)", () => {
	for (const { label, policy, privateMarker } of EXACT_BACKENDS) {
		const names = identityNames(policy);
		const surfaceIdentity = Object.fromEntries(names.map((name) => [name, `surface-${name}`]));
		const parentIdentity = Object.fromEntries(names.map((name) => [name, `parent-${name}`]));

		it(`${label}: takes identity from the surface and drops denied and surface-only markers`, () => {
			const probe = makeProbeDir();
			try {
				const markers = [
					"T44_ALLOWED_MARKER",
					"T44_DENIED_MARKER",
					"T44_WILD_DENY_A",
					"T44_PANE_DENIED",
					privateMarker,
				];
				const capsule = launch(
					policy,
					{ ...PARENT_ENV, ...parentIdentity },
					{},
					presenceProbeCommand(probe.outFile, [...markers, ...names], surfaceIdentity),
					probe.dir,
				);
				const run = runLauncherInSurface(
					capsule,
					{ ...surfaceIdentity, [privateMarker]: "surface-only", T44_PANE_DENIED: "pane-only" },
					probe.outFile,
				);
				assert.equal(run.status, 0, run.stderr);
				assert.deepEqual(run.flags, {
					T44_ALLOWED_MARKER: "yes",
					T44_DENIED_MARKER: "no",
					T44_WILD_DENY_A: "no",
					T44_PANE_DENIED: "no",
					[privateMarker]: "no",
					...Object.fromEntries(names.map((name) => [name, "yes"])),
					...Object.fromEntries(names.map((name) => [`equal:${name}`, "yes"])),
				});
			} finally {
				probe.dispose();
			}
		});

		it(`${label}: an identity name that only the parent has does not reach the child`, () => {
			const probe = makeProbeDir();
			try {
				const required = Object.fromEntries(requiredNames(policy).map((name) => [name, `surface-${name}`]));
				const capsule = launch(policy, parentIdentity, {}, presenceProbeCommand(probe.outFile, names), probe.dir);
				const run = runLauncherInSurface(capsule, required, probe.outFile);
				assert.equal(run.status, 0, run.stderr);
				for (const name of names) {
					assert.equal(run.flags?.[name], name in required ? "yes" : "no", name);
				}
			} finally {
				probe.dispose();
			}
		});

		for (const missing of requiredNames(policy)) {
			it(`${label}: refuses to start when the surface lacks ${missing}`, () => {
				const probe = makeProbeDir();
				try {
					const capsule = launch(policy, parentIdentity, {}, presenceProbeCommand(probe.outFile, []), probe.dir);
					const { [missing]: _dropped, ...surface } = surfaceIdentity;
					const run = runLauncherInSurface(capsule, surface, probe.outFile);
					assert.equal(run.status, 2);
					assert.match(run.stderr, new RegExp(`identity variable ${missing}`));
					assert.equal(run.flags, undefined, "the child must not start");
				} finally {
					probe.dispose();
				}
			});

			it(`${label}: refuses an env override that names ${missing}`, () => {
				const probe = makeProbeDir();
				try {
					const capsule = launch(
						policy,
						{},
						{ [missing]: "override" },
						presenceProbeCommand(probe.outFile, []),
						probe.dir,
					);
					const run = runLauncherInSurface(capsule, surfaceIdentity, probe.outFile);
					assert.equal(run.status, 2);
					assert.match(run.stderr, new RegExp(`override names the surface identity variable ${missing}`));
					assert.equal(run.flags, undefined, "the child must not start");
				} finally {
					probe.dispose();
				}
			});
		}

		it(`${label}: an env override of a denied non-identity name still reaches the child`, () => {
			const probe = makeProbeDir();
			try {
				const capsule = launch(
					policy,
					PARENT_ENV,
					{ T44_DENIED_MARKER: "override" },
					presenceProbeCommand(probe.outFile, ["T44_DENIED_MARKER"]),
					probe.dir,
				);
				const run = runLauncherInSurface(capsule, surfaceIdentity, probe.outFile);
				assert.equal(run.status, 0, run.stderr);
				assert.deepEqual(run.flags, { T44_DENIED_MARKER: "yes" });
			} finally {
				probe.dispose();
			}
		});
	}

	// Each launch path passes adapter.paneIdentity to the capsule; this pins the policy of each backend.
	const ADAPTERS: Array<{ adapter: MuxBackendAdapter; privateMarker: string; surface: Record<string, string> }> = [
		{ adapter: tmuxBackend, privateMarker: "TMUX_PROBE_PRIVATE", surface: { TMUX_PANE: "%2" } },
		{ adapter: cmuxBackend, privateMarker: "CMUX_PROBE_PRIVATE", surface: { CMUX_SURFACE_ID: "surface:2" } },
		{ adapter: weztermBackend, privateMarker: "WEZTERM_PROBE_PRIVATE", surface: { WEZTERM_PANE: "2" } },
		{ adapter: zellijBackend, privateMarker: "ZELLIJ_PROBE_PRIVATE", surface: { ZELLIJ_PANE_ID: "2" } },
		{
			adapter: herdrBackend,
			privateMarker: "HERDR_PROBE_PRIVATE",
			surface: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" },
		},
	];
	for (const { adapter, privateMarker, surface } of ADAPTERS) {
		it(`${adapter.id} adapter: denied markers stay out; a pane-only prefixed marker follows the backend policy`, () => {
			const probe = makeProbeDir();
			try {
				const policy = adapter.paneIdentity ?? PREFIX_PANE_IDENTITY;
				const markers = [
					"T44_ALLOWED_MARKER",
					"T44_DENIED_MARKER",
					"T44_WILD_DENY_A",
					"T44_PANE_DENIED",
					privateMarker,
				];
				const capsule = launch(
					policy,
					PARENT_ENV,
					{},
					presenceProbeCommand(probe.outFile, markers, surface),
					probe.dir,
				);
				const run = runLauncherInSurface(
					capsule,
					{ ...surface, [privateMarker]: "pane-only", T44_PANE_DENIED: "pane-only" },
					probe.outFile,
				);
				assert.equal(run.status, 0, run.stderr);
				assert.deepEqual(run.flags, {
					T44_ALLOWED_MARKER: "yes",
					T44_DENIED_MARKER: "no",
					T44_WILD_DENY_A: "no",
					T44_PANE_DENIED: "no",
					// D34 known limit: prefix backends still copy a pane-only name with their prefix.
					[privateMarker]: policy.kind === "prefix" ? "yes" : "no",
					...Object.fromEntries(Object.keys(surface).map((name) => [`equal:${name}`, "yes"])),
				});
			} finally {
				probe.dispose();
			}
		});
	}
});
