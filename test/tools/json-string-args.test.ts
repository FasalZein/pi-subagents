import { parseJsonContainer, parseLaunchJsonFields } from "../../src/tools/json-string-args.ts";
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

	// D05 (owner 2026-11-20T12:00Z): only children is parsed; a JSON string anywhere else keeps its type.
	it("parses launch children only; a schema string, in a child or top-level, stays a string", () => {
		const schema = JSON.stringify({ type: "object" });
		const child = { name: "a", schema };
		assert.deepEqual(parseLaunchJsonFields({ children: JSON.stringify([child]) }), { children: [child] });
		const native = { children: [child] };
		assert.equal(parseLaunchJsonFields(native), native, "a native list is the same object");
		const single = { name: "a", schema, task: '{"x":1}' };
		assert.equal(parseLaunchJsonFields(single), single, "the top-level form is not parsed");
		assert.equal(parseLaunchJsonFields("text"), "text");
	});
});
