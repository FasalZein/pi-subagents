import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createDataCheck,
	DATA_SCHEMA_ENV,
	type DataSchemaParse,
	parseDataSchema,
	readLaunchDataSchema,
} from "../../src/tools/data-schema.ts";
import { assert, createTestDir, describe, it } from "../support/index.ts";
import { cleanupPaneChild, loadPaneChild } from "../support/pane-child.ts";

// D12 limits from the decision text: at most 10 violations, 32,000 characters as JSON, one retry,
// drafts 2020-12 and 7, no outside URL.
function accepted(schema: unknown): DataSchemaParse {
	const parsed = parseDataSchema(schema);
	assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
	return parsed;
}

function violationLines(error: unknown): string[] {
	return String((error as Error).message)
		.split("\n")
		.filter((line) => line.startsWith("- "));
}

describe("launch schema boundary (D12)", () => {
	it("accepts drafts 2020-12 and 7, local references and a reference to the schema's own $id", () => {
		accepted({ type: "object", properties: { n: { type: "integer" } } });
		accepted(true);
		accepted({ $schema: "https://json-schema.org/draft/2020-12/schema", prefixItems: [{ type: "string" }] });
		accepted({ $schema: "http://json-schema.org/draft-07/schema#", items: [{ type: "string" }], definitions: {} });
		accepted({ $defs: { n: { type: "number" } }, $ref: "#/$defs/n" });
		accepted({
			$id: "https://example.com/s.json",
			$defs: { n: { type: "number" } },
			$ref: "https://example.com/s.json#/$defs/n",
		});
	});

	it("refuses other drafts, dangling references and malformed keywords", () => {
		const cases: [unknown, RegExp][] = [
			[{ $schema: "http://json-schema.org/draft-04/schema#" }, /draft other than 2020-12 and 7/],
			[{ $ref: "#/$defs/missing" }, /invalid schema: Unresolved/],
			[{ type: "strng" }, /invalid schema/],
			[{ minLength: -1 }, /invalid schema/],
			[{ pattern: "(" }, /invalid schema/],
			[{ properties: { a: 5 } }, /invalid schema/],
			[[{ type: "string" }], /JSON Schema object/],
			[null, /JSON Schema object/],
		];
		for (const [schema, error] of cases) {
			const parsed = parseDataSchema(schema);
			assert.equal(parsed.ok, false, JSON.stringify(schema));
			if (!parsed.ok) assert.match(parsed.error, error, JSON.stringify(schema));
		}
	});

	it("names an outside URL, also one reached through a relative reference under an outside $id", () => {
		for (const schema of [
			{ $ref: "https://example.com/x.json" },
			{ $id: "https://example.com/s.json", $ref: "other.json" },
			{ anyOf: [{ $ref: "http://example.com/a#/b" }] },
		]) {
			const parsed = parseDataSchema(schema);
			assert.equal(parsed.ok, false);
			if (!parsed.ok) assert.match(parsed.error, /outside URL \(https?:\/\/example\.com\//);
		}
	});

	it("a refusal names at most 10 violations and counts the rest", () => {
		const properties = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`f${i}`, { type: "string" }]));
		const check = createDataCheck("subagent_done", () => accepted({ type: "object", properties }));
		const data = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`f${i}`, i]));
		let error: unknown;
		try {
			check(data);
		} catch (caught) {
			error = caught;
		}
		const lines = violationLines(error);
		assert.equal(lines.length, 11, "10 violations and one count line");
		assert.equal(lines.at(-1), "- and 5 more");
		const second = check(data);
		assert.equal(second.kind, "data_error");
		if (second.kind === "data_error") assert.equal(violationLines(new Error(second.error)).length, 11);
	});

	it("one retry: the first failure throws, a second failure is a data error, matching data is accepted", () => {
		const check = createDataCheck("subagent_done", () => accepted({ type: "object", required: ["ok"] }));
		assert.deepEqual(check({ ok: 1 }), { kind: "accept" });
		assert.throws(() => check({}), /data does not match the launch schema:\n- data\.ok: /);
		assert.deepEqual(check({ ok: 2 }), { kind: "accept" }, "matching data after a refusal is accepted");
		const missing = check(undefined);
		assert.equal(missing.kind, "data_error", "missing data is a failure under a schema");
	});

	it("data over 32,000 characters as JSON is refused every time with a file hint; 32,000 is accepted", () => {
		const check = createDataCheck("subagent_done", () => undefined);
		const fits = "x".repeat(32_000 - 2); // JSON adds the two quotes
		assert.equal(JSON.stringify(fits).length, 32_000);
		assert.deepEqual(check(fits), { kind: "accept" });
		const over = `${fits}y`;
		for (let i = 0; i < 2; i++) {
			assert.throws(
				() => check(over),
				/32,001 characters as JSON; the limit is 32,000\. Write the data to a file, name the file in artifacts/,
			);
		}
	});

	it("without a launch schema any data is accepted", () => {
		const check = createDataCheck("subagent_done", () => undefined);
		assert.deepEqual(check({ any: ["thing"] }), { kind: "accept" });
		assert.deepEqual(check(undefined), { kind: "accept" });
	});

	it("reads the launch file from the environment; an unreadable file is a data error, not a crash", () => {
		const dir = createTestDir();
		const file = join(dir, "schema.json");
		writeFileSync(file, JSON.stringify({ type: "string" }));
		assert.equal(readLaunchDataSchema({}), undefined);
		assert.equal(readLaunchDataSchema({ [DATA_SCHEMA_ENV]: "" }), undefined);
		assert.equal(readLaunchDataSchema({ [DATA_SCHEMA_ENV]: file })?.ok, true);
		const missing = createDataCheck("subagent_done", () =>
			readLaunchDataSchema({ [DATA_SCHEMA_ENV]: join(dir, "gone.json") }),
		);
		const verdict = missing("x");
		assert.equal(verdict.kind, "data_error");
		if (verdict.kind === "data_error") assert.match(verdict.error, /launch schema not readable/);
	});
});

describe("subagent_done with a launch schema (D12)", () => {
	function withSchemaChild(run: (child: ReturnType<typeof loadPaneChild>) => Promise<void>) {
		return async () => {
			const dir = createTestDir();
			const file = join(dir, "schema.json");
			writeFileSync(file, JSON.stringify({ type: "object", required: ["verdict"] }));
			process.env[DATA_SCHEMA_ENV] = file;
			const child = loadPaneChild({ autoExit: true, pane: false });
			try {
				await run(child);
			} finally {
				delete process.env[DATA_SCHEMA_ENV];
				cleanupPaneChild(child.dir);
			}
		};
	}

	it(
		"the child sees the schema in the data parameter",
		withSchemaChild(async (child) => {
			const tool = child.tools.get("subagent_done");
			assert.match(
				tool.parameters.properties.data.description,
				/must match this JSON Schema: \{"type":"object","required":\["verdict"\]\}/,
			);
		}),
	);

	it(
		"an untyped call is not checked and records no data error",
		withSchemaChild(async (child) => {
			await child.tools.get("subagent_done").execute("u1", { data: { wrong: true } }, undefined, undefined, child.ctx);
			assert.equal(child.readExit()?.acceptedCall?.dataError, undefined);
		}),
	);

	it(
		"a second failing call ends the run and carries the data error in the exit record",
		withSchemaChild(async (child) => {
			const args = { outcome: "done", summary: "s", data: { wrong: true } };
			const done = (id: string) => child.tools.get("subagent_done").execute(id, args, undefined, undefined, child.ctx);
			await assert.rejects(done("c1"), /does not match the launch schema/);
			assert.equal(child.readExit(), null, "the refused call writes no exit record");
			await done("c2");
			const exit = child.readExit();
			assert.equal(exit?.acceptedCall?.toolCallId, "c2");
			assert.match(
				exit?.acceptedCall?.dataError ?? "",
				/data failed the launch schema twice:\n- data\.verdict: missing/,
			);
		}),
	);
});
