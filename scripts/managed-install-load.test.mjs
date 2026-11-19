import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { managedInstallLoad } from "./managed-install-load.mjs";

// Explicit run only (needs the npm cache or the registry): node --test scripts/managed-install-load.test.mjs
describe("managed install load (T63)", () => {
	it("loads src/index.ts through Pi's loader after a managed npm install of the packed package", () => {
		const result = managedInstallLoad();
		assert.equal(result.step, "load", result.output);
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /extensions loaded: 1/);
	});
});
