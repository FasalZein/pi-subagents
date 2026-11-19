import { createDataCheck, DATA_MAX_CHARS } from "../../src/tools/data-schema.ts";
import { parseJsonContainer, parseJsonFields, parseLaunchJsonFields } from "../../src/tools/json-string-args.ts";
import { assert, describe, it } from "../support/index.ts";

// T64: the expected values follow the brief's rule: a string that parses as a JSON object or array is
// that value; any other value is unchanged. Scalars stay strings so a string schema still gets a string.
describe("JSON string arguments (T64)", () => {
	it("parses a string that holds a JSON object or array, with surrounding whitespace", () => {
		assert.deepEqual(parseJsonContainer('{"verdict":"approve","findings":0}'), { verdict: "approve", findings: 0 });
		assert.deepEqual(parseJsonContainer(' \n["a.md", "b.md"]\n'), ["a.md", "b.md"]);
		assert.deepEqual(parseJsonContainer("{}"), {});
	});

	it("leaves non-JSON strings, JSON scalars and non-strings unchanged", () => {
		for (const value of [
			"verdict: approve",
			"{not json",
			"[1,",
			"42",
			"true",
			"null",
			'"x"',
			"",
			42,
			null,
			undefined,
		]) {
			assert.equal(parseJsonContainer(value), value, JSON.stringify(value));
		}
		const object = { a: 1 };
		assert.equal(parseJsonContainer(object), object);
	});

	it("parses only the named fields and returns the same object when nothing changed", () => {
		const args = { data: '{"a":1}', summary: '{"b":2}' };
		assert.deepEqual(parseJsonFields(args, ["data"]), { data: { a: 1 }, summary: '{"b":2}' });
		assert.deepEqual(args.data, '{"a":1}', "the input is not modified");
		const plain = { data: { a: 1 }, summary: "s" };
		assert.equal(parseJsonFields(plain, ["data", "artifacts"]), plain);
		assert.equal(parseJsonFields("text", ["data"]), "text");
	});

	it("parses launch children and each child's schema", () => {
		const schema = { type: "object" };
		const child = { name: "a", schema: JSON.stringify(schema) };
		assert.deepEqual(parseLaunchJsonFields({ children: JSON.stringify([child]) }), {
			children: [{ name: "a", schema }],
		});
		assert.deepEqual(parseLaunchJsonFields({ children: [child] }), { children: [{ name: "a", schema }] });
		const plain = { children: [{ name: "a", schema }] };
		assert.equal(parseLaunchJsonFields(plain), plain);
	});

	it("the data size limit counts the parsed JSON, not the string the model sent", () => {
		const check = createDataCheck("subagent_done", undefined);
		const value = { text: "x".repeat(DATA_MAX_CHARS - 100) };
		const padded = JSON.stringify(value, null, 2).replace("{", `{${" ".repeat(200)}`);
		assert.ok(padded.length > DATA_MAX_CHARS, "the sent string is over the limit");
		assert.deepEqual(check(parseJsonContainer(padded)), { kind: "accept" });
		const over = JSON.stringify({ text: "x".repeat(DATA_MAX_CHARS) });
		assert.throws(() => check(parseJsonContainer(over)), /the limit is 32,000/);
	});
});
