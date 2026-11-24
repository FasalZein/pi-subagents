import { mkdirSync, readdirSync } from "node:fs";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import {
	assert,
	createTestDir,
	describe,
	it,
	join,
	readFileSync,
	writeExecutable,
	writeFileSync,
	writeSubagentLaunchMetadataEntryForTest,
} from "../support/index.ts";
import { testResultsDir } from "../support/result-fixtures.ts";
import "../support/ambient-spawn-grant.ts";

// Fake herdr: logs every call; answers the availability probes and one tab or split surface.
const FAKE_HERDR = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_HERDR_LOG"
case "$*" in
  "status server --json")
    echo '{"status":"running","running":true,"compatible":true,"protocol":17,"version":"0.7.5"}'; exit 0 ;;
  "pane current --current")
    echo '{"id":"c","result":{"type":"pane_current","pane":{"pane_id":"w1:p1","tab_id":"w1:t1","workspace_id":"w1","cwd":"/parent","foreground_cwd":"/parent","focused":true}}}'; exit 0 ;;
  "pane layout"*)
    echo '{"id":"l","result":{"type":"pane_layout","layout":{"area":{"height":52,"width":120,"x":0,"y":0},"focused_pane_id":"w1:p1","panes":[{"focused":true,"pane_id":"w1:p1","rect":{"height":52,"width":120,"x":0,"y":0}}],"splits":[],"tab_id":"w1:t1","workspace_id":"w1","zoomed":false}}}'; exit 0 ;;
  "pane split"*)
    echo '{"id":"s","result":{"type":"pane_split","pane":{"pane_id":"w1:p2","tab_id":"w1:t1","workspace_id":"w1","cwd":"/child","focused":false}}}'; exit 0 ;;
  "tab create"*)
    echo '{"id":"t","result":{"type":"tab_created","tab":{"tab_id":"w1:t2","workspace_id":"w1","label":"Child","focused":false,"pane_count":1},"root_pane":{"pane_id":"w1:p2","tab_id":"w1:t2","workspace_id":"w1","cwd":"/child","focused":false}}}'; exit 0 ;;
  "tab list"*)
    echo '{"id":"tl","result":{"type":"tab_list","tabs":[{"tab_id":"w1:t1","workspace_id":"w1","label":"Parent","focused":true,"pane_count":1},{"tab_id":"w1:t2","workspace_id":"w1","label":"Child","focused":false,"pane_count":1}]}}'; exit 0 ;;
  "pane rename"*|"tab rename"*|"workspace rename"*)
    echo '{"id":"r","result":{"type":"renamed"}}'; exit 0 ;;
  "pane run"*|"pane send-text"*|"pane send-keys"*) exit 0 ;;
esac
echo '{"error":{"code":"unknown_command","message":"unsupported fake herdr command"}}'
exit 1
`;

describe("subagent_resume mux detection", () => {
	// Each Herdr availability probe blocks the parent on two CLI calls. 54d185f made 4 status probes on this
	// resume (measured with this test); the adapter refactor must not add one.
	it("probes Herdr availability no more often than the base on one interactive resume", async () => {
		const dir = createTestDir();
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		const logFile = join(dir, "herdr.log");
		writeFileSync(logFile, "");
		writeExecutable(binDir, "herdr", FAKE_HERDR);
		// The suite capsule root (test/support/capsule-root.ts) is removed at exit; the capsule holds the parent env.
		const suiteCapsuleRoot = process.env.PI_SUBAGENT_ENV_CAPSULE_DIR!;
		const capsulesBefore = readdirSync(suiteCapsuleRoot).length;
		// test/support/env.ts restores these tracked keys after each test.
		process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
		process.env.PI_SUBAGENT_MUX = "herdr";
		process.env.FAKE_HERDR_LOG = logFile;
		process.env.SHELL = "/bin/sh";
		process.env.HERDR_PANE_ID = "w1:p1";
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: "child-session", timestamp: new Date().toISOString(), cwd: dir })}\n`,
		);
		await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
			version: 1,
			timestamp: new Date().toISOString(),
			name: "resume-child",
			agent: "scout",
			mode: "interactive",
			sessionMode: "fork",
			parentClosePolicy: "terminate",
			async: true,
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: dir,
			cwd: dir,
			boundarySystemPrompt: false,
		});
		const running = await resumeSubagentSession(
			{
				resultsDir: testResultsDir(),
				parentSessionId: "test-parent",
				parent: { parentCwd: process.cwd(), warnings: [] },
				sessionFile,
				task: "Detection probe.",
			},
			{
				isMuxAvailable: () => true,
				getShellReadyDelayMs: () => 0,
				watchBackgroundSubagent: async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 }),
				watchSubagent: async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 }),
				getWatcherSignal: (_running: any, controller: AbortController) => controller.signal,
				startWidgetRefresh: () => {},
				getContextWindow: () => undefined,
				runningSubagents: new Map<string, any>(),
			},
		);
		assert.equal(running.surface, "w1:p2");
		assert.equal(readdirSync(suiteCapsuleRoot).length, capsulesBefore + 1, "the capsule lands in the suite root");
		const calls = readFileSync(logFile, "utf8").split("\n");
		assert.equal(calls.filter((line) => line === "status server --json").length, 4, calls.join("\n"));
	});
});
