/**
 * Meta-schemas of drafts 2020-12 and 7 for the launch schema check (D12). Neither pi-schema nor any
 * installed package ships them, so they are vendored here, condensed from the official documents:
 * https://json-schema.org/draft/2020-12/schema (its core, applicator, unevaluated, validation,
 * meta-data, format-annotation and content vocabularies, merged into one document with "#" in place of
 * $dynamicRef, which is equivalent while no extension meta-schema is in play) and
 * http://json-schema.org/draft-07/schema. Only constraints are kept; defaults and comments are dropped.
 * Both compile with pi-schema's 2020-12 semantics: they use no keyword whose meaning differs by draft.
 */
const schema = { $ref: "#" };
const schemaArray = { type: "array", minItems: 1, items: schema };
const schemaMap = { type: "object", additionalProperties: schema };
const nonNegativeInteger = { type: "integer", minimum: 0 };
const number = { type: "number" };
const string = { type: "string" };
const boolean = { type: "boolean" };
const anyArray = { type: "array" };
const stringArray = { type: "array", items: string, uniqueItems: true };
const simpleTypes = { enum: ["array", "boolean", "integer", "null", "number", "object", "string"] };
const anchorString = { type: "string", pattern: "^[A-Za-z_][-A-Za-z0-9._]*$" };
const uriReference = { type: "string", format: "uri-reference" };

/** Keywords whose shape is the same in both drafts. */
const shared = {
	$schema: { type: "string", format: "uri" },
	$ref: uriReference,
	$comment: string,
	title: string,
	description: string,
	readOnly: boolean,
	writeOnly: boolean,
	examples: anyArray,
	multipleOf: { type: "number", exclusiveMinimum: 0 },
	maximum: number,
	exclusiveMaximum: number,
	minimum: number,
	exclusiveMinimum: number,
	maxLength: nonNegativeInteger,
	minLength: nonNegativeInteger,
	pattern: { type: "string", format: "regex" },
	contains: schema,
	maxItems: nonNegativeInteger,
	minItems: nonNegativeInteger,
	uniqueItems: boolean,
	maxProperties: nonNegativeInteger,
	minProperties: nonNegativeInteger,
	required: stringArray,
	additionalProperties: schema,
	definitions: schemaMap,
	properties: schemaMap,
	patternProperties: { type: "object", additionalProperties: schema, propertyNames: { format: "regex" } },
	dependencies: { type: "object", additionalProperties: { anyOf: [schema, stringArray] } },
	propertyNames: schema,
	enum: anyArray,
	type: { anyOf: [simpleTypes, { type: "array", items: simpleTypes, minItems: 1, uniqueItems: true }] },
	format: string,
	contentMediaType: string,
	contentEncoding: string,
	if: schema,
	// biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword in a plain data object, never awaited.
	then: schema,
	else: schema,
	allOf: schemaArray,
	anyOf: schemaArray,
	oneOf: schemaArray,
	not: schema,
};

export const DRAFT_7_META_SCHEMA = {
	type: ["object", "boolean"],
	properties: {
		...shared,
		$id: uriReference,
		additionalItems: schema,
		items: { anyOf: [schema, schemaArray] },
	},
};

export const DRAFT_2020_12_META_SCHEMA = {
	type: ["object", "boolean"],
	properties: {
		...shared,
		$id: { type: "string", format: "uri-reference", pattern: "^[^#]*#?$" },
		$anchor: anchorString,
		$dynamicRef: uriReference,
		$dynamicAnchor: anchorString,
		$vocabulary: { type: "object", propertyNames: { format: "uri" }, additionalProperties: boolean },
		$defs: schemaMap,
		prefixItems: schemaArray,
		items: schema,
		unevaluatedItems: schema,
		unevaluatedProperties: schema,
		dependentSchemas: schemaMap,
		dependentRequired: { type: "object", additionalProperties: stringArray },
		maxContains: nonNegativeInteger,
		minContains: nonNegativeInteger,
		deprecated: boolean,
		contentSchema: schema,
	},
};
