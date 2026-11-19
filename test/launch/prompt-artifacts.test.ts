import { statSync } from "node:fs";
import { dirname } from "node:path";
import { writeSystemPromptArtifact, writeTaskArtifact } from "../../src/launch/prompt-artifacts.ts";
import { assert, createTestDir, describe, it, join, readFileSync } from "../support/index.ts";

// Review b2 g4 P1: task and replacement system-prompt files were named by child name and second
// and truncated on write. A same-name sibling started in the same second replaced the file before
// the first child read it, so that child ran the sibling's task. Each launch must own its file.

function withArtifactRoot(dir: string): () => void {
	const saved = process.env.PI_ARTIFACT_PROJECT_ROOT;
	process.env.PI_ARTIFACT_PROJECT_ROOT = join(dir, "artifacts");
	return () => {
		if (saved === undefined) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
		else process.env.PI_ARTIFACT_PROJECT_ROOT = saved;
	};
}

const writers = [
	["task", writeTaskArtifact],
	["replacement system prompt", writeSystemPromptArtifact],
] as const;

describe("prompt artifact files", () => {
	for (const [label, write] of writers) {
		it(`gives each same-name sibling its own private ${label} file`, () => {
			const dir = createTestDir();
			const restore = withArtifactRoot(dir);
			try {
				const ctx = { cwd: dir, sessionManager: { getSessionId: () => "session-1" } };
				// Child A's file is written; its Pi process has not read it yet (delayed read).
				const first = write("Worker", "TASK-A", ctx);
				// Sibling B, same name, starts in the same second with a different text.
				const second = write("Worker", "TASK-B", ctx);
				assert.notEqual(first, second);
				// A's delayed read still gets A's own text.
				assert.equal(readFileSync(first, "utf8"), "TASK-A");
				assert.equal(readFileSync(second, "utf8"), "TASK-B");
				for (const file of [first, second]) {
					assert.equal(statSync(file).mode & 0o777, 0o600);
					assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
				}
			} finally {
				restore();
			}
		});
	}
});
