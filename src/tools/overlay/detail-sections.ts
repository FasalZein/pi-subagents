import type { AgentDefaults } from "../../agents/definitions.ts";
import {
	type PersistedSubagentLaunchMetadata,
	readSubagentLaunchMetadataEntries,
} from "../../session/session-files.ts";
import type { DetailSection } from "./render-types.ts";

// Detail sections of one overlay row (T83): every fact shown is a fact of that row's own run.
// Grants come from the first launch entry of the session, which resume keeps as the grant authority;
// the model comes from the row's own run, never from another run of the same session.

export type AgentDetailDefaults = AgentDefaults & {
	name?: string;
	description?: string;
};

/** The model of one run (D23): its display ref and, when known, the launch entry that started it. */
export interface RunModel {
	ref?: string;
	facts?: PersistedSubagentLaunchMetadata;
}

/** What one row shows of its session: the saved grants and its own run's model. */
export interface RunDetailFacts {
	grants?: PersistedSubagentLaunchMetadata;
	model: RunModel;
}

/**
 * Reads a row's facts. `own` is what the row knows of its run: a running run's ref and launch entry, an
 * ended run's published or cached ref. A row that knows only its ref takes the newest entry with that ref
 * for its model details. A row that knows nothing (an old session message) takes the session's model only
 * when every entry names the same one; otherwise it shows none rather than another run's.
 */
export function readRunDetailFacts(sessionFile: string | undefined, own: RunModel): RunDetailFacts {
	const entries = sessionFile ? readSubagentLaunchMetadataEntries(sessionFile) : [];
	const grants = entries[0];
	if (own.facts) return { grants, model: { ref: own.ref ?? own.facts.modelRef, facts: own.facts } };
	const refs = new Set(entries.map((entry) => entry.modelRef).filter(Boolean));
	const ref = own.ref ?? (refs.size === 1 ? [...refs][0] : undefined);
	return { grants, model: { ref, facts: ref ? entries.findLast((entry) => entry.modelRef === ref) : undefined } };
}

const SECTION_FIELDS = [
	{
		title: "Identity",
		fields: ["name", "description", "agent file"],
	},
	{
		title: "Runtime",
		fields: ["mode", "session-mode", "async", "auto-exit", "parent-close", "no-session", "timeout", "launched"],
	},
	{
		title: "Model",
		fields: ["model", "thinking", "resolved", "allow-model-override", "override-model", "override-thinking"],
	},
	{
		title: "Workspace",
		fields: ["cwd", "trust-project", "flags", "env"],
	},
	{
		title: "Capabilities",
		fields: [
			"tools",
			"deny-tools",
			"extensions",
			"skills",
			"inject-skills",
			"spawning",
			"no-context-files",
			"inherit-append-system",
		],
	},
];

function none(value?: string | null): string {
	return value && value.trim() ? value : "none";
}

function inherited(value?: string | null): string {
	return value && value.trim() ? value : "default";
}

function spawningLabel(spawning: true | string[] | false | undefined): string {
	return Array.isArray(spawning) ? spawning.join(",") || "false" : String(spawning ?? false);
}

/**
 * With saved grants (`meta`, the first launch entry) every grant shows as saved, an omitted one with the
 * default the runtime applies to it; the current definition fills in only for a row without metadata.
 */
export function buildSections(
	defs: AgentDetailDefaults | null,
	meta?: PersistedSubagentLaunchMetadata,
	model: RunModel = {},
): DetailSection[] {
	const fields: Array<{ label: string; value: string }> = [];
	const name = meta?.name ?? defs?.name ?? "—";

	fields.push({ label: "name", value: name });
	fields.push({ label: "description", value: defs?.description ?? "—" });
	fields.push({ label: "agent file", value: defs?.path ?? "—" });
	if (meta) {
		fields.push({
			label: "launched",
			value: meta.timestamp ? new Date(meta.timestamp).toLocaleString() : "—",
		});
	}
	fields.push({ label: "model", value: inherited(meta ? meta.definitionModel : defs?.model) });
	fields.push({ label: "thinking", value: inherited(meta ? meta.definitionThinking : defs?.thinking) });
	if (model.ref) fields.push({ label: "resolved", value: model.ref });
	fields.push({
		label: "allow-model-override",
		value: String(meta ? meta.allowModelOverride === true : defs?.allowModelOverride === true),
	});
	const facts = model.facts;
	if (facts?.modelSource === "launch-override" || facts?.modelSource === "resume-override") {
		fields.push({ label: "override-model", value: inherited(facts.model) });
		fields.push({ label: "override-thinking", value: inherited(facts.thinking) });
	}
	fields.push({ label: "mode", value: meta ? meta.mode : (defs?.mode ?? "interactive") });
	fields.push({ label: "cwd", value: meta ? meta.cwd : (defs?.cwd ?? "parent cwd") });
	fields.push({
		label: "trust-project",
		value: String(meta ? (meta.trustProject ?? false) : (defs?.trustProject ?? false)),
	});
	fields.push({ label: "flags", value: none(meta ? meta.flags : defs?.flags) });
	fields.push({ label: "env", value: none(meta ? meta.env : defs?.env) });
	fields.push({ label: "tools", value: (meta ? meta.tools : defs?.tools) ?? "all" });
	fields.push({ label: "deny-tools", value: none(meta ? (meta.denyTools ?? []).join(",") : defs?.denyTools) });
	// An explicit empty list launches the child with no extensions of its own (getExtensionLaunchArgs).
	fields.push({
		label: "extensions",
		value: meta?.extensions ? none(meta.extensions.join(", ")) : "all",
	});
	fields.push({ label: "skills", value: (meta ? meta.skills : defs?.skills) ?? "all" });
	fields.push({ label: "inject-skills", value: none(meta ? meta.injectSkills : defs?.injectSkills) });
	// A legacy entry without a spawn grant resumes with none (spawnableAgents).
	fields.push({ label: "spawning", value: spawningLabel(meta ? meta.spawnableAgents : defs?.spawning) });
	fields.push({
		label: "no-context-files",
		value: String(meta ? meta.noContextFiles : (defs?.noContextFiles ?? false)),
	});
	fields.push({
		label: "inherit-append-system",
		value: String(meta ? (meta.inheritAppendSystem ?? false) : (defs?.inheritAppendSystem ?? false)),
	});
	fields.push({
		label: "async",
		value: String(meta ? meta.async : (defs?.async ?? true)),
	});
	fields.push({
		label: "auto-exit",
		value: String(meta ? (meta.autoExit ?? false) : (defs?.autoExit ?? false)),
	});
	fields.push({
		label: "session-mode",
		value: ((meta ? meta.sessionMode : defs?.sessionMode) ?? "lineage-only") as string,
	});
	fields.push({
		label: "parent-close",
		value: ((meta ? meta.parentClosePolicy : defs?.parentClosePolicy) ?? "terminate") as string,
	});
	fields.push({
		label: "no-session",
		value: String(meta ? meta.noSession : (defs?.noSession ?? false)),
	});
	const wallClock = meta ? meta.timeout : defs?.timeout;
	const idle = meta ? meta.idleTimeout : defs?.idleTimeout;
	const budgets = [wallClock ? `${wallClock}s` : "", idle ? `idle ${idle}s` : ""].filter(Boolean);
	const onTimeout = ((meta ? meta.onTimeout : defs?.onTimeout) ?? "report") as string;
	fields.push({ label: "timeout", value: budgets.length ? `${budgets.join(" / ")} (${onTimeout})` : "none" });

	return SECTION_FIELDS.map((section) => ({
		title: section.title,
		fields: section.fields
			.map((label) => fields.find((field) => field.label === label))
			.filter((field): field is { label: string; value: string } => Boolean(field)),
	})).filter((section) => section.fields.length > 0);
}
