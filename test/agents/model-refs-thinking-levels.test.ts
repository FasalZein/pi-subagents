import assert from "node:assert/strict";
import { describe, it } from "node:test";
// The test runs on the dev install, where the subpath resolves; the extension itself cannot import it.
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { PI_THINKING_LEVELS } from "../../src/agents/model-refs.ts";

describe("model ref thinking levels", () => {
	it("match Pi's MODEL_THINKING_LEVELS", () => {
		assert.deepEqual([...PI_THINKING_LEVELS], [...MODEL_THINKING_LEVELS]);
	});
});
