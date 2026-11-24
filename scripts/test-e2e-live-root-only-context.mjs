#!/usr/bin/env node
/**
 * Live test: root-only AGENTS.md blocks reach the root session only.
 *
 * Strategy:
 *   - Copy the owner's real ~/.pi/agent/AGENTS.md into the temp config dir
 *     (the original stays untouched); it wraps root-only text in
 *     <!-- pi-subagents:root-only --> ... <!-- /pi-subagents:root-only -->.
 *   - A probe extension, loaded in the parent and in the child, writes every
 *     provider request payload to the snapshots dir.
 *   - The parent launches one background child; the script checks what each
 *     provider request carried.
 *
 * Needs PI_SUBAGENT_LIVE_MODEL.
 */

import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	getAssistantTexts,
	getToolResults,
	listJsonlFiles,
	parseJsonl,
	runPi,
	setup,
	writeAgent,
} from "./live-test-common.mjs";

const ROOT_ONLY_TEXT = "I am a junior developer";
const SHARED_TEXT = "## Verification integrity";
const OPEN = "<!-- pi-subagents:root-only -->";

const ctx = setup("root-only");
const agentsMd = readFileSync(join(homedir(), ".pi", "agent", "AGENTS.md"), "utf8");
if (!agentsMd.includes(OPEN) || !agentsMd.includes(ROOT_ONLY_TEXT) || !agentsMd.includes(SHARED_TEXT)) {
	throw new Error("~/.pi/agent/AGENTS.md no longer holds the root-only block and shared section this test expects");
}
copyFileSync(join(homedir(), ".pi", "agent", "AGENTS.md"), join(ctx.configDir, "AGENTS.md"));

const probe = join(ctx.extensionsDir, "request-probe.ts");
writeFileSync(
	probe,
	`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let count = 0;
export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event) => {
    const who = process.env.PI_SUBAGENT_AGENT ? "child-" + process.env.PI_SUBAGENT_AGENT : "parent";
    const dir = ${JSON.stringify(ctx.snapshotsDir)};
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, who + "-" + process.pid + "-" + count++ + ".json"), JSON.stringify(event.payload));
  });
}
`,
	"utf8",
);

writeAgent(
	ctx.agentsDir,
	"root-only-child",
	{
		name: "root-only-child",
		description: "Live root-only context smoke test agent.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
		tools: "read",
		extensions: probe,
	},
	"Reply with exactly `ROOT_ONLY_CHILD_OK` and nothing else. Do not call tools.",
);

const prompt = [
	"Call subagent with name 'Root Only Child', agent 'root-only-child', title 'Root-only context', task 'Follow your exact built-in instructions.'.",
	"After the tool returns, reply with exactly 'TEST_ROOT_ONLY_DONE' and nothing else.",
	"Do not call any other tools.",
].join(" ");

let verified = false;
try {
	// The probe also loads in the parent, so the root's own requests are recorded.
	runPi(ctx, prompt, {}, ["-e", probe]);

	const parentFile = listJsonlFiles(ctx.sessionDir).find((file) =>
		getAssistantTexts(parseJsonl(file)).some((text) => text.includes("TEST_ROOT_ONLY_DONE")),
	);
	if (!parentFile) throw new Error("Could not find the parent session that finished.");
	const result = getToolResults(parseJsonl(parentFile), "subagent").find((r) => r.details?.agent === "root-only-child");
	if (result?.details?.status !== "completed")
		throw new Error(`Child did not complete: ${JSON.stringify(result?.details)}`);

	const requests = readdirSync(ctx.snapshotsDir).filter((name) => name.endsWith(".json"));
	const root = requests.filter((name) => name.startsWith("parent-"));
	const child = requests.filter((name) => name.startsWith("child-root-only-child-"));
	if (root.length === 0 || child.length === 0) throw new Error(`Missing provider requests: ${requests.join(", ")}`);
	const read = (name) => readFileSync(join(ctx.snapshotsDir, name), "utf8");
	for (const name of root) {
		const payload = read(name);
		if (!payload.includes(ROOT_ONLY_TEXT) || !payload.includes(SHARED_TEXT))
			throw new Error(`Root request ${name} lost AGENTS.md text`);
	}
	for (const name of child) {
		const payload = read(name);
		if (payload.includes(ROOT_ONLY_TEXT) || payload.includes("pi-subagents:root-only"))
			throw new Error(`Child request ${name} still carries the root-only block`);
		if (!payload.includes(SHARED_TEXT)) throw new Error(`Child request ${name} lost the shared AGENTS.md text`);
	}
	verified = true;
	console.log(
		`root-only context ok: ${root.length} root request(s) carry "${ROOT_ONLY_TEXT}" and "${SHARED_TEXT}"; ${child.length} child request(s) carry "${SHARED_TEXT}" and no root-only block (${result.details.id})`,
	);
} finally {
	ctx.cleanup();
}

if (!verified) process.exit(1);
