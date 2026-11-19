import { readFileSync } from "node:fs";
import { compile, type JsonSchema, type ValidationError, type Validator } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { DRAFT_7_META_SCHEMA, DRAFT_2020_12_META_SCHEMA } from "./json-schema-meta.ts";

/** D12: data over this many characters as JSON is refused; the child writes a file and names it in artifacts. */
export const DATA_MAX_CHARS = 32_000;

/** D12: a refusal and a data error name at most this many violations. */
export const MAX_VIOLATIONS = 10;

/**
 * Internal parent-to-child protocol: the path of the launch schema file. Every child environment sets
 * it, empty unless this launch named a schema, so no child inherits another run's schema.
 */
export const DATA_SCHEMA_ENV = "PI_SUBAGENT_DATA_SCHEMA";

type Draft = "2020-12" | "7";

const DRAFT_URIS: ReadonlyMap<string, Draft> = new Map([
	["https://json-schema.org/draft/2020-12/schema", "2020-12"],
	["http://json-schema.org/draft-07/schema", "7"],
]);

const META_SCHEMAS: Readonly<Record<Draft, object>> = {
	"2020-12": DRAFT_2020_12_META_SCHEMA,
	"7": DRAFT_7_META_SCHEMA,
};

/** The base URI of a launch schema without its own $id; a reserved name, never fetched. */
const LAUNCH_BASE = "https://json-schema.invalid/launch.json";

declare const checkedSchema: unique symbol;

/** A JSON Schema that passed parseDataSchema: valid for its draft, every reference inside the schema. */
export interface DataSchema {
	readonly schema: JsonSchema;
	readonly draft: Draft;
	readonly [checkedSchema]: true;
}

export type DataSchemaParse = { ok: true; value: DataSchema } | { ok: false; error: string };

const metaValidators = new Map<Draft, Validator>();

function formatPath(pointer: string): string {
	if (pointer === "") return "data";
	return `data${pointer.replace(/~1/g, "/").replace(/~0/g, "~").replace(/\//g, ".")}`;
}

function schemaPath(pointer: string): string {
	return pointer === "" ? "the schema" : `schema${pointer.replace(/\//g, ".")}`;
}

/** At most MAX_VIOLATIONS lines of path and message, and how many more there were. */
export function formatViolations(errors: readonly ValidationError[], path = formatPath): string {
	const lines = errors.slice(0, MAX_VIOLATIONS).map((error) => `- ${path(error.path)}: ${error.message}`);
	if (errors.length > MAX_VIOLATIONS) lines.push(`- and ${errors.length - MAX_VIOLATIONS} more`);
	return lines.join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSchema(value: unknown): value is JsonSchema {
	return typeof value === "boolean" || isObject(value);
}

/** The draft a schema object declares with its own $schema; 2020-12 when it declares none. */
function declaredDraft(node: Record<string, unknown>): Draft | undefined {
	if (!Object.hasOwn(node, "$schema")) return "2020-12";
	return typeof node.$schema === "string" ? DRAFT_URIS.get(node.$schema.replace(/#$/, "")) : undefined;
}

const SINGLE = ["additionalItems", "unevaluatedItems", "items", "contains", "additionalProperties"];
const SINGLE_MORE = ["unevaluatedProperties", "propertyNames", "if", "then", "else", "not", "contentSchema"];
const ARRAYS = ["allOf", "anyOf", "oneOf", "prefixItems", "items"];
const MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"];

function pointerSegment(key: string): string {
	return encodeURIComponent(key.replace(/~/g, "~0").replace(/\//g, "~1"));
}

/**
 * The JSON Pointer of every schema position: the root, each subschema of an applicator, and each entry
 * of a definition or property map, used or not. Literal JSON (const, enum, default, examples) is skipped.
 */
function schemaPositions(node: JsonSchema, pointer = "", into: string[] = []): string[] {
	into.push(pointer);
	if (!isObject(node)) return into;
	const visit = (value: unknown, at: string) => {
		if (isSchema(value)) schemaPositions(value, at, into);
	};
	for (const key of [...SINGLE, ...SINGLE_MORE]) if (Object.hasOwn(node, key)) visit(node[key], `${pointer}/${key}`);
	for (const key of ARRAYS) {
		const items = node[key];
		if (Object.hasOwn(node, key) && Array.isArray(items))
			items.forEach((item, i) => {
				visit(item, `${pointer}/${key}/${i}`);
			});
	}
	for (const key of MAPS) {
		const map = node[key];
		if (!Object.hasOwn(node, key) || !isObject(map)) continue;
		for (const [name, value] of Object.entries(map)) visit(value, `${pointer}/${key}/${pointerSegment(name)}`);
	}
	return into;
}

function valueAt(root: JsonSchema, pointer: string): unknown {
	return pointer
		.split("/")
		.slice(1)
		.reduce<unknown>(
			(node, segment) =>
				isObject(node) || Array.isArray(node)
					? (node as Record<string, unknown>)[decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~")]
					: undefined,
			root,
		);
}

/** The unresolved reference target that compile() names, when it is an outside http or https URL. */
function outsideUrl(message: string): string | undefined {
	const target = /no schema registered for (\S+?)\)?$/.exec(message)?.[1];
	return target && /^https?:\/\//i.test(target) ? target : undefined;
}

/**
 * D12: the boundary check of a launch schema, before any child starts. Refuses a value that is no
 * schema, a draft other than 2020-12 and 7 (also on a nested resource), a schema that fails its
 * draft's meta-schema, and any reference ($ref, $dynamicRef) at any schema position, unused
 * definitions and lone branches included, that does not resolve inside the schema; a reference to
 * an outside URL is named as such. pi-schema resolves only registered documents and never fetches.
 */
export function parseDataSchema(value: unknown): DataSchemaParse {
	if (!isSchema(value)) return { ok: false, error: "schema must be a JSON Schema object or a boolean" };
	const draft = isObject(value) ? declaredDraft(value) : "2020-12";
	if (!draft) return { ok: false, error: "invalid schema: $schema names a draft other than 2020-12 and 7" };
	let meta = metaValidators.get(draft);
	if (!meta) {
		meta = compile(META_SCHEMAS[draft], { formats });
		metaValidators.set(draft, meta);
	}
	const shape = meta.errors(value);
	if (shape.length > 0) return { ok: false, error: `invalid schema:\n${formatViolations(shape, schemaPath)}` };
	const positions = schemaPositions(value);
	for (const pointer of positions.slice(1)) {
		const node = valueAt(value, pointer);
		if (isObject(node) && declaredDraft(node) !== draft && Object.hasOwn(node, "$schema")) {
			return {
				ok: false,
				error: `invalid schema: ${schemaPath(pointer)} declares a $schema other than the root's draft`,
			};
		}
	}
	const base =
		isObject(value) && typeof value.$id === "string" ? new URL(value.$id, LAUNCH_BASE).href.split("#")[0] : LAUNCH_BASE;
	try {
		// One reference per schema position makes compile() reach every subschema, used or not.
		const everyPosition = { allOf: positions.map((pointer) => ({ $ref: `${base}#${pointer}` })) };
		compile(everyPosition, { draft, schemas: { [base]: value } });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const url = outsideUrl(message);
		if (url)
			return { ok: false, error: `schema refers to an outside URL (${url}); put every definition inside the schema` };
		return { ok: false, error: `invalid schema: ${message}` };
	}
	return { ok: true, value: { schema: value, draft } as DataSchema };
}

/** The schema file a launch wrote for this child, or undefined when the launch named none. */
export function readLaunchDataSchema(env: NodeJS.ProcessEnv = process.env): DataSchemaParse | undefined {
	const file = env[DATA_SCHEMA_ENV];
	if (!file) return undefined;
	try {
		return parseDataSchema(JSON.parse(readFileSync(file, "utf8")));
	} catch (error) {
		return {
			ok: false,
			error: `launch schema not readable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** What the completion call does with its data (D12). */
export type DataVerdict = { kind: "accept" } | { kind: "data_error"; error: string };

/**
 * D12 for one child: data over the size limit is refused every time with a hint; data that fails
 * the launch schema is refused once with at most 10 violations, and a second failure is accepted as a
 * data error with no data. Only a typed call reaches this: an untyped result has no data.
 */
export function createDataCheck(tool: string, launchSchema: DataSchemaParse | undefined) {
	let refusedOnce = false;
	const validator =
		launchSchema?.ok === true
			? compile(launchSchema.value.schema, { draft: launchSchema.value.draft, formats })
			: undefined;
	return (data: unknown): DataVerdict => {
		const json = data === undefined ? undefined : JSON.stringify(data);
		if (json !== undefined && json.length > DATA_MAX_CHARS) {
			throw new Error(
				`${tool} refused: data has ${json.length.toLocaleString("en-US")} characters as JSON; the limit is ` +
					`${DATA_MAX_CHARS.toLocaleString("en-US")}. Write the data to a file, name the file in artifacts, and call ${tool} again with smaller data or none.`,
			);
		}
		if (launchSchema === undefined) return { kind: "accept" };
		if (!launchSchema.ok) return { kind: "data_error", error: launchSchema.error };
		const errors =
			data === undefined
				? [{ path: "", keyword: "required", message: "missing; the launch schema requires data" }]
				: (validator?.errors(data) ?? []);
		if (errors.length === 0) return { kind: "accept" };
		const violations = formatViolations(errors);
		if (!refusedOnce) {
			refusedOnce = true;
			throw new Error(
				`${tool} refused: data does not match the launch schema:\n${violations}\n` +
					`Fix data and call ${tool} again. A second failure ends the run with a data error and no data.`,
			);
		}
		return { kind: "data_error", error: `data failed the launch schema twice:\n${violations}` };
	};
}
