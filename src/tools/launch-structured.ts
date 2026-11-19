import type { JsonValue } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { ResultRecordSchema, recordAsJson } from "../runtime/result-record-schema.ts";
import type { RunningSubagent } from "../types.ts";

/**
 * D16: what a codemode script gets from a launch or a resume instead of the text. The session file
 * is data only: the reply text never shows it.
 */
const launchedChildFields = {
	/** The run id that subagent_wait, subagent_kill and subagent_resume accept. */
	runId: Type.String(),
	name: Type.String(),
	agent: Type.String(),
	modelRef: Type.Optional(Type.String()),
	sessionFile: Type.Optional(Type.String()),
	where: Type.Union([Type.Literal("pane"), Type.Literal("headless")]),
};

const LaunchedChildSchema = Type.Union([
	Type.Object({ ...launchedChildFields, state: Type.Literal("started") }),
	Type.Object({
		...launchedChildFields,
		state: Type.Literal("ended"),
		/** The run's published record (D13); null when the run published none (a verified fan-out). */
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

export const SubagentLaunchOutput = Type.Union([
	Type.Object({ status: Type.Literal("launched"), children: Type.Array(LaunchedChildSchema) }),
	Type.Object({
		status: Type.Literal("launch_failed"),
		/** The children that started before the failure; they keep running. */
		children: Type.Array(LaunchedChildSchema),
		failed: FailedChildSchema,
	}),
]);
export type SubagentLaunchStructured = Static<typeof SubagentLaunchOutput>;

type ChildSource = Pick<
	RunningSubagent,
	"id" | "name" | "agent" | "modelRef" | "mode" | "noSession" | "sessionFile" | "resultTarget"
>;

/**
 * One child's data. It is ended when its run published a record or this reply delivered its
 * report; otherwise it is started and reports later.
 */
export function launchedChildData(running: ChildSource, agent: string, delivered: boolean): LaunchedChild {
	const target = running.resultTarget;
	const record = target?.store.read(target.reservation.runId);
	const base = {
		runId: running.id,
		name: running.name,
		agent: running.agent ?? agent,
		...(running.modelRef ? { modelRef: running.modelRef } : {}),
		...(running.noSession || !running.sessionFile ? {} : { sessionFile: running.sessionFile }),
		where: running.mode === "interactive" ? ("pane" as const) : ("headless" as const),
	};
	if (record || delivered) return { ...base, state: "ended", record: record ? recordAsJson(record) : null };
	return { ...base, state: "started" };
}

/** The one cast: a record's data is typed unknown but is JSON (D12 accepts only JSON data). */
export function asStructuredContent(output: SubagentLaunchStructured): JsonValue {
	return output as unknown as JsonValue;
}
