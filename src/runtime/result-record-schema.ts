import { type Static, Type } from "typebox";
import type { ResultRecord } from "./result-record.ts";

/**
 * D13's ResultRecord as a JSON schema, for tools that hand records to scripts (D16). The compile
 * check below keeps it in step with the type: every ResultRecord must fit this schema.
 */
const ResultTypingSchema = Type.Union([
	Type.Object({
		typed: Type.Literal(true),
		data: Type.Optional(Type.Unknown()),
		dataError: Type.Optional(Type.Undefined()),
	}),
	Type.Object({ typed: Type.Literal(true), data: Type.Optional(Type.Undefined()), dataError: Type.String() }),
	Type.Object({
		typed: Type.Literal(false),
		data: Type.Optional(Type.Undefined()),
		dataError: Type.Optional(Type.Undefined()),
	}),
]);

const ResultFieldsSchema = Type.Object({
	runId: Type.String(),
	name: Type.String(),
	agent: Type.String(),
	title: Type.Optional(Type.String()),
	modelRef: Type.Optional(Type.String()),
	outcome: Type.Union([
		Type.Literal("done"),
		Type.Literal("partial"),
		Type.Literal("blocked"),
		Type.Literal("failed"),
		Type.Literal("timed_out"),
		Type.Literal("cancelled"),
	]),
	summary: Type.String(),
	sessionFile: Type.Optional(Type.String()),
	artifacts: Type.Array(Type.String()),
	endedAt: Type.Number(),
	elapsedSeconds: Type.Number(),
	exit: Type.Object({
		code: Type.Optional(Type.Number()),
		signal: Type.Optional(Type.String()),
		error: Type.Optional(Type.String()),
	}),
	timeLimit: Type.Optional(
		Type.Object({
			kind: Type.Union([Type.Literal("timeout"), Type.Literal("idle-timeout")]),
			seconds: Type.Number(),
			wrapUp: Type.Boolean(),
		}),
	),
	contextUsage: Type.Optional(Type.Object({ tokens: Type.Number(), window: Type.Optional(Type.Number()) })),
	resume: Type.Union([
		Type.Object({ resumable: Type.Literal(true) }),
		Type.Object({ resumable: Type.Literal(false), reason: Type.String() }),
	]),
	report: Type.Union([
		Type.Object({ saved: Type.Literal(true), path: Type.String() }),
		Type.Object({ saved: Type.Literal(false), error: Type.String() }),
	]),
});

export const ResultRecordSchema = Type.Intersect([ResultTypingSchema, ResultFieldsSchema]);
export type ResultRecordJson = Static<typeof ResultRecordSchema>;

/** Compile check: a ResultRecord is a ResultRecordJson (the schema is never narrower than the type). */
export function recordAsJson(record: ResultRecord): ResultRecordJson {
	return record;
}
