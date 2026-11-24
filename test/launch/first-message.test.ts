import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Pi's own argv parsing and first-message assembly: the real collaborator that turns a child's
// prompt arguments into its first user message.
import { parseArgs } from "../../node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js";
import { processFileArguments } from "../../node_modules/@earendil-works/pi-coding-agent/dist/cli/file-processor.js";
import { buildInitialMessage } from "../../node_modules/@earendil-works/pi-coding-agent/dist/cli/initial-message.js";
import { assert, buildPiPromptArgsForTest, describe, it } from "../support/index.ts";

async function firstMessageFor(skills: string[]) {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagents-first-message-"));
	const taskPath = join(dir, "task.md");
	writeFileSync(taskPath, "Reply with exactly LIVE_A_OK.");
	const parsed = parseArgs(buildPiPromptArgsForTest(skills, `@${taskPath}`));
	const { text } = await processFileArguments(parsed.fileArgs, { autoResizeImages: false });
	const { initialMessage } = buildInitialMessage({ parsed, fileText: text });
	return { taskPath, initialMessage: initialMessage ?? "", laterMessages: parsed.messages };
}

describe("child first message", () => {
	// Requirement: a child reads its task file as its instruction, not as a file a user attached
	// (gpt children answered "What would you like me to do with the attached file?").
	for (const [label, skills] of [
		["launch without skills", []],
		["launch with skills", ["debugger", "pua"]],
	] as const) {
		it(`says after the task file that the file is the task: ${label}`, async () => {
			const { taskPath, initialMessage, laterMessages } = await firstMessageFor([...skills]);
			const fileBlock = `<file name="${taskPath}">\nReply with exactly LIVE_A_OK.\n</file>\n`;
			assert.ok(initialMessage.startsWith(fileBlock), initialMessage);
			const note = initialMessage.slice(fileBlock.length);
			assert.match(
				note,
				/\btask\b/i,
				`first message carries no line naming the file as the task: ${JSON.stringify(initialMessage)}`,
			);
			assert.deepEqual(
				laterMessages,
				skills.map((skill) => `/skill:${skill}`),
			);
		});
	}
});
