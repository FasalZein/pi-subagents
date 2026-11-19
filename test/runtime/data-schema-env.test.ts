import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchBackgroundSubagent } from "../../src/launch/background.ts";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { restartSubagentForTimeoutWrapUp } from "../../src/runtime/timeout-wrap-up.ts";
import { DATA_SCHEMA_ENV } from "../../src/tools/data-schema.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	assert,
	createTestDir,
	describe,
	it,
	SESSION_HEADER,
	writeSubagentLaunchMetadataEntryForTest,
} from "../support/index.ts";
import { testResultsDir } from "../support/result-fixtures.ts";
import "../support/ambient-spawn-grant.ts";

// D12: the launch schema belongs to one run. The parent here is itself a typed child with its own
// schema file in its environment, and the persisted frontmatter env tries to set one too; a child it
// starts, resumes or restarts without a schema gets the variable empty. The probe records only whether
// the value is empty (T44: no environment on disk).
const PARENT_SCHEMA = "/parent/own-launch-schema.json";
const FORGED_ENV = `${DATA_SCHEMA_ENV}=/forged/frontmatter-schema.json`;

function useTypedParent() {
	const dir = createTestDir();
	const outFile = join(dir, "flags.json");
	const probe = join(dir, "probe.cjs");
	writeFileSync(
		probe,
		[
			"const fs = require('node:fs');",
			"fs.readFileSync(0);",
			`const value = process.env[${JSON.stringify(DATA_SCHEMA_ENV)}];`,
			`fs.writeFileSync(${JSON.stringify(outFile)}, value === "" ? "empty" : value === undefined ? "unset" : "set");`,
		].join("\n"),
	);
	const env: Record<string, string> = {
		[DATA_SCHEMA_ENV]: PARENT_SCHEMA,
		PI_SUBAGENT_PI_COMMAND: `${process.execPath} ${probe}`,
		PI_ARTIFACT_PROJECT_ROOT: join(dir, "artifacts"),
	};
	const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	return {
		dir,
		async childValue(): Promise<string> {
			for (let attempt = 0; attempt < 500; attempt++) {
				if (existsSync(outFile) && readFileSync(outFile, "utf8")) return readFileSync(outFile, "utf8");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error("the child did not write its flag");
		},
		restore() {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function writeChildSession(dir: string): string {
	const sessionFile = join(dir, "child.jsonl");
	writeFileSync(sessionFile, `${JSON.stringify({ ...SESSION_HEADER, id: "child-session", cwd: dir })}\n`);
	return sessionFile;
}

const metadata = (dir: string) => ({
	version: 1 as const,
	timestamp: new Date().toISOString(),
	name: "own-child",
	agent: "scout",
	mode: "background" as const,
	sessionMode: "lineage-only" as const,
	autoExit: true,
	parentClosePolicy: "terminate" as const,
	async: true,
	denyTools: [],
	noContextFiles: false,
	noSession: false,
	agentConfigDir: dir,
	cwd: dir,
	boundarySystemPrompt: false,
	env: FORGED_ENV,
});

const quietResult = async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 });

describe("launch schema environment (D12)", () => {
	it("launch: a schema-free child of a typed parent gets the variable empty, also against frontmatter env", async () => {
		const parent = useTypedParent();
		try {
			const cwd = parent.dir;
			mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
			writeFileSync(
				join(cwd, ".pi", "agents", "probe.md"),
				`---\nname: probe\nmode: background\nenv: ${FORGED_ENV}\n---\nProbe.\n`,
			);
			const parentSession = join(cwd, "parent.jsonl");
			writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);
			await launchBackgroundSubagent(
				{ name: "probe", title: "Probe", task: "Probe.", agent: "probe" },
				{
					cwd,
					sessionManager: {
						getSessionFile: () => parentSession,
						getSessionId: () => "parent-session-id",
						getLeafId: () => null,
					},
				},
				{ getContextWindow: () => undefined },
			);
			assert.equal(await parent.childValue(), "empty");
		} finally {
			parent.restore();
		}
	});

	it("resume: a typed child resuming its own schema-free child passes on no schema", async () => {
		const parent = useTypedParent();
		try {
			const sessionFile = writeChildSession(parent.dir);
			await writeSubagentLaunchMetadataEntryForTest(sessionFile, metadata(parent.dir));
			await resumeSubagentSession(
				{
					resultsDir: testResultsDir(),
					parent: { parentCwd: process.cwd(), warnings: [] },
					sessionFile,
					task: "Probe.",
				},
				{
					isMuxAvailable: () => true,
					getShellReadyDelayMs: () => 0,
					watchBackgroundSubagent: quietResult,
					watchSubagent: quietResult,
					getWatcherSignal: (_running: unknown, controller: AbortController) => controller.signal,
					startWidgetRefresh: () => {},
					getContextWindow: () => undefined,
					runningSubagents: new Map<string, RunningSubagent>(),
				},
			);
			assert.equal(await parent.childValue(), "empty");
		} finally {
			parent.restore();
		}
	});

	it("time-limit restart: the report-only continuation gets the variable empty", async () => {
		const parent = useTypedParent();
		try {
			const sessionFile = writeChildSession(parent.dir);
			const running = {
				id: "timeout-child",
				name: "own-child",
				task: "Do the long task",
				agent: "scout",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				async: true,
				autoExit: true,
				startTime: Date.now() - 8_000,
				sessionFile,
				timeoutBudget: { timeoutSeconds: 10 },
				timeoutWrapUp: { kind: "timeout", seconds: 10, threshold: 80 },
				launchMetadata: metadata(parent.dir),
			} as unknown as RunningSubagent;
			await restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 });
			assert.equal(await parent.childValue(), "empty");
		} finally {
			parent.restore();
		}
	});
});
