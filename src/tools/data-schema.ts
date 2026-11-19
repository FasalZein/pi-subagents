import { readFileSync } from "node:fs";
import { compile, type JsonSchema, type ValidationError, type Validator } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";

/** D12: data over this many characters as JSON is refused; the child writes a file and names it in artifacts. */
export const DATA_MAX_CHARS = 32_000;

/** D12: a refusal and a data error name at most this many violations. */
export const MAX_VIOLATIONS = 10;

/** Internal parent-to-child protocol: the path of the launch schema file; empty when the launch named none. */
export const DATA_SCHEMA_ENV = "PI_SUBAGENT_DATA_SCHEMA";

const DRAFT_URIS: Readonly<Record<string, "2020-12" | "7">> = {
	"https://json-schema.org/draft/2020-12/schema": "2020-12",
	"http://json-schema.org/draft-07/schema": "7",
};

/** Where compile() resolves a relative reference of a schema without $id; never an outside URL. */
const INTERNAL_BASE = "https://json-schema.invalid/";

/**
 * Keyword shapes of drafts 2020-12 and 7, after the draft-07 meta-schema. pi-schema reads keywords
 * defensively and ignores a malformed one, so a launch checks the shapes here first: a schema that a
 * typo would make accept everything is refused before any child starts.
 */
const nonNegative = { type: "integer", minimum: 0 };
const schemaArray = { type: "array", minItems: 1, items: { $ref: "#" } };
const schemaMap = { type: "object", additionalProperties: { $ref: "#" } };
const stringArray = { type: "array", items: { type: "string" }, uniqueItems: true };
const typeName = { enum: ["array", "boolean", "integer", "null", "number", "object", "string"] };
const META_SCHEMA = {
	type: ["object", "boolean"],
	properties: {
		$id: { type: "string" },
		$schema: { type: "string" },
		$ref: { type: "string" },
		$anchor: { type: "string" },
		$dynamicRef: { type: "string" },
		$dynamicAnchor: { type: "string" },
		$defs: schemaMap,
		definitions: schemaMap,
		type: { anyOf: [typeName, { type: "array", items: typeName, minItems: 1, uniqueItems: true }] },
		enum: { type: "array" },
		multipleOf: { type: "number", exclusiveMinimum: 0 },
		maximum: { type: "number" },
		exclusiveMaximum: { type: "number" },
		minimum: { type: "number" },
		exclusiveMinimum: { type: "number" },
		maxLength: nonNegative,
		minLength: nonNegative,
		pattern: { type: "string", format: "regex" },
		items: { anyOf: [{ $ref: "#" }, schemaArray] },
		prefixItems: schemaArray,
		additionalItems: { $ref: "#" },
		unevaluatedItems: { $ref: "#" },
		contains: { $ref: "#" },
		maxItems: nonNegative,
		minItems: nonNegative,
		maxContains: nonNegative,
		minContains: nonNegative,
		uniqueItems: { type: "boolean" },
		maxProperties: nonNegative,
		minProperties: nonNegative,
		required: stringArray,
		properties: schemaMap,
		patternProperties: { type: "object", additionalProperties: { $ref: "#" }, propertyNames: { format: "regex" } },
		additionalProperties: { $ref: "#" },
		unevaluatedProperties: { $ref: "#" },
		propertyNames: { $ref: "#" },
		dependencies: { type: "object", additionalProperties: { anyOf: [{ $ref: "#" }, stringArray] } },
		dependentRequired: { type: "object", additionalProperties: stringArray },
		dependentSchemas: schemaMap,
		if: { $ref: "#" },
		// biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword in a plain data object, never awaited.
		then: { $ref: "#" },
		else: { $ref: "#" },
		allOf: schemaArray,
		anyOf: schemaArray,
		oneOf: schemaArray,
		not: { $ref: "#" },
		format: { type: "string" },
	},
} as const;

let metaValidator: Validator | undefined;

/** A JSON Schema that a launch accepted: it compiles with every reference inside the schema itself. */
export interface DataSchema {
	readonly schema: JsonSchema;
	readonly draft: "2020-12" | "7";
}

export type DataSchemaParse = { ok: true; value: DataSchema } | { ok: false; error: string };

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

function draftOf(schema: JsonSchema): "2020-12" | "7" | undefined {
	if (typeof schema !== "object" || !("$schema" in schema)) return "2020-12";
	const uri = (schema as { $schema?: unknown }).$schema;
	return typeof uri === "string" ? DRAFT_URIS[uri.replace(/#$/, "")] : undefined;
}

/** The unresolved reference target that compile() names, when it is an outside http or https URL. */
function outsideUrl(message: string): string | undefined {
	const target = /no schema registered for (\S+?)\)?$/.exec(message)?.[1];
	return target && /^https?:\/\//i.test(target) && !target.startsWith(INTERNAL_BASE) ? target : undefined;
}

/**
 * D12: the boundary check of a launch schema. Refuses a value that is no schema, a malformed keyword,
 * a draft other than 2020-12 and 7, and a reference that does not resolve inside the schema; a
 * reference to an outside URL is named as such. pi-schema never fetches, so nothing leaves the host.
 */
export function parseDataSchema(value: unknown): DataSchemaParse {
	if (typeof value !== "boolean" && (typeof value !== "object" || value === null || Array.isArray(value))) {
		return { ok: false, error: "schema must be a JSON Schema object or a boolean" };
	}
	const schema = value as JsonSchema;
	metaValidator ??= compile(META_SCHEMA, { formats });
	const shape = metaValidator.errors(schema);
	if (shape.length > 0) return { ok: false, error: `invalid schema:\n${formatViolations(shape, schemaPath)}` };
	const draft = draftOf(schema);
	if (!draft) return { ok: false, error: "invalid schema: $schema names a draft other than 2020-12 and 7" };
	try {
		compile(schema, { draft });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const url = outsideUrl(message);
		if (url)
			return { ok: false, error: `schema refers to an outside URL (${url}); put every definition inside the schema` };
		return { ok: false, error: `invalid schema: ${message}` };
	}
	return { ok: true, value: { schema, draft } };
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
export function createDataCheck(tool: string, loadSchema: () => DataSchemaParse | undefined = readLaunchDataSchema) {
	let refusedOnce = false;
	let validator: Validator | undefined;
	let loaded: DataSchemaParse | undefined | null = null;
	return (data: unknown): DataVerdict => {
		const json = data === undefined ? undefined : JSON.stringify(data);
		if (json !== undefined && json.length > DATA_MAX_CHARS) {
			throw new Error(
				`${tool} refused: data has ${json.length.toLocaleString("en-US")} characters as JSON; the limit is ` +
					`${DATA_MAX_CHARS.toLocaleString("en-US")}. Write the data to a file, name the file in artifacts, and call ${tool} again with smaller data or none.`,
			);
		}
		if (loaded === null) loaded = loadSchema();
		if (!loaded) return { kind: "accept" };
		if (!loaded.ok) return { kind: "data_error", error: loaded.error };
		validator ??= compile(loaded.value.schema, { draft: loaded.value.draft, formats });
		const errors =
			data === undefined
				? [{ path: "", keyword: "required", message: "missing; the launch schema requires data" }]
				: validator.errors(data);
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
