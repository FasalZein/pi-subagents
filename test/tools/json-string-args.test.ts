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

	it("parses launch children sent as a JSON string; a child's fields stay as sent", () => {
		const child = { name: "a", task: '{"b":1}' };
		assert.deepEqual(parseLaunchJsonFields({ children: JSON.stringify([child]) }), { children: [child] });
		const plain = { children: [child] };
		assert.equal(parseLaunchJsonFields(plain), plain);
	});
});
