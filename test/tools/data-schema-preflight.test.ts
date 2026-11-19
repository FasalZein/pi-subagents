import { parseDataSchema } from "../../src/tools/data-schema.ts";
import { assert, describe, it } from "../support/index.ts";

// D12 launch preflight. Expected verdicts come from the official meta-schemas of draft 2020-12
// (json-schema.org/draft/2020-12/schema and its vocabularies) and draft 7
// (json-schema.org/draft-07/schema), and from the rule that every reference resolves inside the
// schema, unused definitions included. Each case is run under the draft named in the case.
const D7 = "http://json-schema.org/draft-07/schema#";
const D2020 = "https://json-schema.org/draft/2020-12/schema";

function verdict(schema: unknown): string {
	const parsed = parseDataSchema(schema);
	return parsed.ok ? "accept" : parsed.error;
}

const draftCases: [string, unknown, "accept" | RegExp][] = [
	// 2020-12: items is one schema; tuples use prefixItems.
	["2020-12 items as an array", { $schema: D2020, items: [{ type: "string" }] }, /schema\.items/],
	["2020-12 prefixItems", { prefixItems: [{ type: "string" }], items: false }, "accept"],
	["2020-12 title as a number", { title: 5 }, /schema\.title/],
	["2020-12 readOnly as a string", { readOnly: "yes" }, /schema\.readOnly/],
	["2020-12 deprecated as a string", { deprecated: "yes" }, /schema\.deprecated/],
	["2020-12 $comment as a number", { $comment: 1 }, /schema\.\$comment/],
	["2020-12 examples as an object", { examples: {} }, /schema\.examples/],
	["2020-12 $anchor with a leading digit", { $anchor: "1a" }, /schema\.\$anchor/],
	["2020-12 $id with a fragment", { $id: "https://example.com/s.json#frag" }, /schema\.\$id/],
	["2020-12 minContains below 0", { minContains: -1 }, /schema\.minContains/],
	["2020-12 dependentRequired with a string", { dependentRequired: { a: "b" } }, /schema\.dependentRequired/],
	[
		"2020-12 malformed annotation in a nested schema",
		{ properties: { a: { description: [] } } },
		/schema\.properties\.a\.description/,
	],
	[
		"2020-12 annotations of the right type",
		{ title: "t", readOnly: true, deprecated: false, examples: [1], $comment: "c" },
		"accept",
	],
	[
		"2020-12 unevaluatedProperties and $dynamicAnchor",
		{ $dynamicAnchor: "node", unevaluatedProperties: false },
		"accept",
	],
	// Draft 7: items may be an array; keywords of later drafts are unknown and ignored.
	["draft 7 items as an array", { $schema: D7, items: [{ type: "string" }], additionalItems: false }, "accept"],
	["draft 7 an empty items array", { $schema: D7, items: [] }, /schema\.items/],
	["draft 7 ignores prefixItems", { $schema: D7, prefixItems: [] }, "accept"],
	["draft 7 $id with a fragment", { $schema: D7, $id: "#node" }, "accept"],
	["draft 7 title as a number", { $schema: D7, title: 5 }, /schema\.title/],
	["draft 7 readOnly as a string", { $schema: D7, readOnly: "yes" }, /schema\.readOnly/],
	["draft 7 required as a string", { $schema: D7, required: "a" }, /schema\.required/],
	["draft 7 dependencies", { $schema: D7, dependencies: { a: ["b"], c: { required: ["d"] } } }, "accept"],
	// Neither draft.
	["draft 4", { $schema: "http://json-schema.org/draft-04/schema#" }, /draft other than 2020-12 and 7/],
	["an inherited key as $schema", { $schema: "constructor" }, /draft other than 2020-12 and 7/],
];

const referenceCases: [string, unknown, "accept" | RegExp][] = [
	[
		"an outside $ref in an unused definition",
		{ $defs: { unused: { $ref: "https://example.com/x.json" } } },
		/outside URL \(https:\/\/example\.com\/x\.json\)/,
	],
	["an outside $ref in a lone then", { then: { $ref: "http://example.com/t.json" } }, /outside URL/],
	["an outside $ref in an inactive else", { if: true, else: { $ref: "http://example.com/e.json" } }, /outside URL/],
	[
		"an outside $dynamicRef in an unused definition",
		{ $defs: { u: { $dynamicRef: "https://example.com/x#a" } } },
		/outside URL/,
	],
	[
		"an outside $ref in a draft 7 definition",
		{ $schema: D7, definitions: { u: { $ref: "https://example.com/x" } } },
		/outside URL/,
	],
	[
		"a dangling local $ref in an unused definition",
		{ $defs: { u: { $ref: "#/$defs/missing" } } },
		/invalid schema: Unresolved/,
	],
	[
		"a relative $ref under an outside embedded $id",
		{ $defs: { r: { $id: "https://example.com/r.json", properties: { x: { $ref: "other.json" } } } } },
		/outside URL \(https:\/\/example\.com\/other\.json\)/,
	],
	[
		"a nested $schema of the other draft",
		{ $defs: { r: { $id: "https://example.com/r", $schema: D7 } } },
		/declares a \$schema other than the root's draft/,
	],
	[
		"a nested $schema of an unknown draft",
		{ $defs: { r: { $id: "https://example.com/r", $schema: "https://example.com/meta" } } },
		/declares a \$schema/,
	],
	[
		"a $ref inside an embedded resource to its own definition",
		{
			$defs: {
				r: {
					$id: "https://example.com/r.json",
					$defs: { a: { type: "string" } },
					properties: { x: { $ref: "#/$defs/a" } },
				},
			},
		},
		"accept",
	],
	["a $ref by anchor", { $defs: { a: { $anchor: "name", type: "string" } }, $ref: "#name" }, "accept"],
	[
		"a relative root $id",
		{ $id: "verdict.json", $defs: { a: { type: "string" } }, $ref: "verdict.json#/$defs/a" },
		"accept",
	],
	[
		"a definition name that needs escaping",
		{ $defs: { "a/b c%": { type: "string" } }, $ref: "#/$defs/a~1b%20c%25" },
		"accept",
	],
	[
		"a $ref-shaped literal in const, enum, default and examples",
		{
			const: { $ref: "https://example.com/x" },
			enum: [{ $ref: "http://x" }],
			default: { $ref: "http://x" },
			examples: [{ $ref: "http://x" }],
		},
		"accept",
	],
];

describe("launch schema preflight (D12)", () => {
	for (const [name, schema, expected] of [...draftCases, ...referenceCases]) {
		it(name, () => {
			const actual = verdict(schema);
			if (expected === "accept") assert.equal(actual, "accept");
			else assert.match(actual, expected);
		});
	}
});
