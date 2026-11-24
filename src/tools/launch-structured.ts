import type { JsonValue } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { readPublishedRecord } from "../runtime/published-record.ts";
import { ResultRecordSchema, recordAsJson } from "../runtime/result-record-schema.ts";
import { runReportFolder } from "../runtime/run-lookup.ts";
import type { RunningSubagent } from "../types.ts";

/**
 * D16: what a codemode script gets from a launch or a resume instead of the text. The session file
 * is data only: the reply text never shows it.
 */
const launchedChildFields = {
	/** The run id that subagent_kill and subagent_resume accept, and that the result message names. */
	runId: Type.String(),
	name: Type.String(),
	agent: Type.String(),
	modelRef: Type.Optional(Type.String()),
	sessionFile: Type.Optional(Type.String()),
	where: Type.Union([Type.Literal("pane"), Type.Literal("headless")]),
	/**
	 * Owner decision 2026-11-24: the absolute folder where the run's report lands (the text reply's
	 * "report folder" line, run-lookup.ts runReportFolder); null when the run folder could not be made.
	 */
	reportFolder: Type.Union([Type.String(), Type.Null()]),
};

const LaunchedChildSchema = Type.Union([
	Type.Object({ ...launchedChildFields, state: Type.Literal("started") }),
	Type.Object({
		...launchedChildFields,
		state: Type.Literal("ended"),
		/** The run's published record (D13); null when no record is available to this reply. */
		record: Type.Union([ResultRecordSchema, Type.Null()]),
	}),
]);
type LaunchedChild = Static<typeof LaunchedChildSchema>;

const FailedChildSchema = Type.Object({
	/** 1-based position of the child in the children list. */
	position: Type.Integer({ minimum: 1 }),
	name: Type.String(),
	agent: Type.String(),
	error: Type.String(),
});
export type FailedChild = Static<typeof FailedChildSchema>;

const SubagentLaunchStructuredSchema = Type.Union([
	Type.Object({ status: Type.Literal("launched"), children: Type.Array(LaunchedChildSchema) }),
	Type.Object({
		status: Type.Literal("launch_failed"),
		/** The children that started before the failure; they keep running. */
		children: Type.Array(LaunchedChildSchema),
		failed: FailedChildSchema,
	}),
]);
/** The reply as the code builds it: failed is there exactly when status is launch_failed. */
export type SubagentLaunchStructured = Static<typeof SubagentLaunchStructuredSchema>;

/**
 * The reply as the tool declares it, one object instead of the union: Pi writes the declared type
 * into the codemode description, and the union wrote the children type twice (G1.1 cost).
 * asStructuredContent checks at compile time that every SubagentLaunchStructured fits it.
 */
export const SubagentLaunchOutput = Type.Object({
	status: Type.Union([Type.Literal("launched"), Type.Literal("launch_failed")]),
	children: Type.Array(LaunchedChildSchema),
	failed: Type.Optional({
		...FailedChildSchema,
		description: "Only with launch_failed; the listed children started and keep running.",
	}),
});

type ChildSource = Pick<
	RunningSubagent,
	"id" | "name" | "agent" | "modelRef" | "mode" | "noSession" | "sessionFile" | "resultTarget" | "verifiedRunDir"
>;

/**
 * One child's data. It is ended when its run published a record or this reply delivered its
 * report; otherwise it is started and reports later. `deliveredDetails` are the details of the
 * delivered result: a verified run's record is found by the run id and report file they name.
 */
export function launchedChildData(
	running: ChildSource,
	agent: string,
	delivered: boolean,
	deliveredDetails?: unknown,
): LaunchedChild {
	const target = running.resultTarget;
	const named = (deliveredDetails ?? {}) as { runId?: unknown; reportFile?: unknown };
	const record =
		target?.store.read(target.reservation.runId) ??
		(delivered && typeof named.runId === "string"
			? readPublishedRecord(named.runId, {
					reportFile: typeof named.reportFile === "string" ? named.reportFile : undefined,
				})
			: null);
	const base = {
		runId: running.id,
		name: running.name,
		agent: running.agent ?? agent,
		...(running.modelRef ? { modelRef: running.modelRef } : {}),
		...(running.noSession || !running.sessionFile ? {} : { sessionFile: running.sessionFile }),
		where: running.mode === "interactive" ? ("pane" as const) : ("headless" as const),
		reportFolder: runReportFolder(running) ?? null,
	};
	if (record || delivered) return { ...base, state: "ended", record: record ? recordAsJson(record) : null };
	return { ...base, state: "started" };
}

/** The one cast: a record's data is typed unknown but is JSON (D12 accepts only JSON data). */
export function asStructuredContent(output: SubagentLaunchStructured): JsonValue {
	const declared: Static<typeof SubagentLaunchOutput> = output;
	return declared as unknown as JsonValue;
}
