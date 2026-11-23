import { symlinkSync } from "node:fs";
import { afterEach, beforeEach } from "node:test";
import { launchInteractiveSubagent } from "../../src/launch/interactive.ts";
import { coordinateSubagentLaunch } from "../../src/launch/launch-coordinator.ts";
import { LaunchUndo } from "../../src/launch/launch-undo.ts";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { restartSubagentForTimeoutWrapUp } from "../../src/runtime/timeout-wrap-up.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { FAKE_REX, FAKE_REX_PARENT, FAKE_REX_SESSION, readRexCalls } from "../mux/fake-rex.ts";
import {
	ASSISTANT_MSG,
	assert,
	createSessionFile,
	createTestDir,
	describe,
	it,
	join,
	MODEL_CHANGE,
	mkdirSync,
	readSubagentLaunchMetadataForTest,
	SESSION_HEADER,
	USER_MSG,
	writeExecutable,
	writeFileSync,
	writeSubagentLaunchMetadataEntryForTest,
} from "../support/index.ts";
import { testResultsDir } from "../support/result-fixtures.ts";

/** Every name that detection or placement reads; restored after each test. */
const ENV_KEYS = [
	"PATH",
	"PI_SUBAGENT_MUX",
	"PI_SUBAGENT_REX_PLACEMENT",
	"PI_ARTIFACT_PROJECT_ROOT",
	"FAKE_TERMINAL_STATE",
	"REX_SESSION",
	"REX_BLOCK",
	"REX_BIN_DIR",
	"HC_TERMINAL_ID",
	"HC_TERMINAL_SOCKET",
	"HERDR_PANE_ID",
	"CMUX_SOCKET_PATH",
	"TMUX",
	"ZELLIJ",
	"ZELLIJ_SESSION_NAME",
	"ZELLIJ_PANE_ID",
	"WEZTERM_UNIX_SOCKET",
	"PI_SUBAGENT_NAME",
	"PI_SUBAGENT_SESSION",
	"PI_SUBAGENT_SURFACE",
] as const;

let saved = new Map<string, string | undefined>();
let cwd = "";
let stateDir = "";

const creates = () =>
	readRexCalls(stateDir)
		.filter((call) => call[0] === "split" || (call[0] === "window" && call[1] === "new"))
		.map((call) => (call[0] === "split" ? "split" : "window new"));

function writeAgent(name: string, env?: string): void {
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	const lines = ["---", `name: ${name}`, "mode: interactive", "auto-exit: true"];
	if (env) lines.push(`env: ${env}`);
	writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), [...lines, "---", "Child."].join("\n"));
}

function context() {
	const parentSession = createSessionFile(cwd, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
	return {
		cwd,
		sessionManager: {
			getSessionFile: () => parentSession,
			getSessionId: () => "parent-session-id",
			getLeafId: () => "asst-001",
		},
	};
}

function coordinate(agent: string) {
	return coordinateSubagentLaunch({ name: `${agent}-child`, title: "Rex child", task: "Work", agent }, context(), {
		mode: "interactive",
		undo: new LaunchUndo(),
	});
}

describe("Rex placement at launch (T71, D28)", () => {
	beforeEach(() => {
		saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
		for (const key of ENV_KEYS) if (key !== "PATH") delete process.env[key];
		cwd = createTestDir();
		const binDir = join(cwd, "bin");
		stateDir = join(cwd, "state");
		mkdirSync(binDir);
		mkdirSync(stateDir);
		writeExecutable(binDir, "rex", FAKE_REX);
		symlinkSync(process.execPath, join(binDir, "node"));
		// No host PATH: an installed rex would get the real calls.
		process.env.PATH = `${binDir}:/usr/bin:/bin`;
		process.env.FAKE_TERMINAL_STATE = stateDir;
		process.env.REX_SESSION = FAKE_REX_SESSION;
		process.env.REX_BLOCK = FAKE_REX_PARENT;
		process.env.PI_SUBAGENT_MUX = "rex";
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
	});

	afterEach(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("stores window when neither the agent nor the parent sets the variable", async () => {
		writeAgent("plain");
		assert.equal((await coordinate("plain")).launchMetadata.rexPlacementPolicy, "window");
	});

	it("stores the parent default when the agent sets nothing", async () => {
		writeAgent("plain");
		process.env.PI_SUBAGENT_REX_PLACEMENT = "split";
		assert.equal((await coordinate("plain")).launchMetadata.rexPlacementPolicy, "split");
	});

	it("lets an agent env value override the parent default", async () => {
		writeAgent("splitter", "PI_SUBAGENT_REX_PLACEMENT=split");
		process.env.PI_SUBAGENT_REX_PLACEMENT = "window";
		assert.equal((await coordinate("splitter")).launchMetadata.rexPlacementPolicy, "split");
	});

	it("an unknown agent env value fails the launch with the Herdr-style error", async () => {
		writeAgent("bogus", "PI_SUBAGENT_REX_PLACEMENT=sideways");
		await assert.rejects(coordinate("bogus"), /Invalid PI_SUBAGENT_REX_PLACEMENT value "sideways"/);
		assert.deepEqual(creates(), []);
	});

	for (const [env, expected] of [
		[undefined, "window new"],
		["PI_SUBAGENT_REX_PLACEMENT=split", "split"],
	] as const) {
		it(`opens the child surface by the agent's placement (${env ?? "unset"}) under a window parent default`, async () => {
			writeAgent("child", env);
			process.env.PI_SUBAGENT_REX_PLACEMENT = "window";
			const running = await launchInteractiveSubagent(
				{ name: "rex-child", title: "Rex child", task: "Check placement.", agent: "child" },
				context(),
				{ getContextWindow: () => undefined, getShellReadyDelayMs: () => 0 },
			);
			assert.deepEqual(creates(), [expected]);
			assert.match(running.surface ?? "", /^block:/);
			const metadata = readSubagentLaunchMetadataForTest(running.sessionFile);
			assert.equal(metadata?.rexPlacementPolicy, expected === "split" ? "split" : "window");
		});
	}

	/** Resumes an interactive child whose launch stored the given env and policy; returns the create verbs. */
	/** Restarts the run for a timeout wrap-up, as wiring.ts does at the warning threshold. */
	async function wrapUp(running: RunningSubagent): Promise<void> {
		running.phase = { kind: "soft-limit", wrapUp: { wrapUp: { kind: "timeout", seconds: 60, threshold: 80 }, deadlineAt: 0 } };
		await restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 });
	}

	it("timeout wrap-up: the replacement keeps the agent's split under an invalid parent value", async () => {
		writeAgent("child", "PI_SUBAGENT_REX_PLACEMENT=split");
		process.env.PI_SUBAGENT_REX_PLACEMENT = "bogus";
		const running = await launchInteractiveSubagent(
			{ name: "rex-child", title: "Rex child", task: "Check placement.", agent: "child" },
			context(),
			{ getContextWindow: () => undefined, getShellReadyDelayMs: () => 0 },
		);
		await wrapUp(running);
		assert.deepEqual(creates(), ["split", "split"]);
	});

	it("timeout wrap-up after a resume: the replacement keeps the resumed run's policy, not the stored one", async () => {
		process.env.PI_SUBAGENT_REX_PLACEMENT = "window";
		const { running } = await resumeWith({ rexPlacementPolicy: "split" });
		process.env.PI_SUBAGENT_REX_PLACEMENT = "bogus";
		await wrapUp(running);
		assert.deepEqual(creates(), ["window new", "window new"]);
	});

	async function resumeWith(stored: {
		env?: string;
		rexPlacementPolicy?: "window" | "split";
	}): Promise<{ creates: string[]; running: RunningSubagent }> {
		const sessionFile = join(cwd, "child.jsonl");
		const header = { type: "session", version: 3, id: "child", timestamp: new Date().toISOString(), cwd };
		writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
		await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
			version: 1,
			timestamp: new Date().toISOString(),
			name: "rex-resume-child",
			mode: "interactive",
			sessionMode: "fork",
			autoExit: true,
			parentClosePolicy: "terminate",
			blocking: false,
			async: true,
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: cwd,
			cwd,
			boundarySystemPrompt: false,
			...stored,
		});
		const result = async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 });
		const running = await resumeSubagentSession(
			{ resultsDir: testResultsDir(), parent: { parentCwd: cwd, warnings: [] }, sessionFile, task: "resume" },
			{
				isMuxAvailable: () => true,
				getShellReadyDelayMs: () => 0,
				watchBackgroundSubagent: result,
				watchSubagent: result,
				getWatcherSignal: (_running: unknown, controller: AbortController) => controller.signal,
				startWidgetRefresh: () => {},
				getContextWindow: () => undefined,
				runningSubagents: new Map(),
			} as unknown as Parameters<typeof resumeSubagentSession>[1],
		);
		return { creates: creates(), running };
	}

	it("resume: the persisted agent env value wins over the current parent default", async () => {
		process.env.PI_SUBAGENT_REX_PLACEMENT = "window";
		const stored = { env: "PI_SUBAGENT_REX_PLACEMENT=split", rexPlacementPolicy: "split" } as const;
		assert.deepEqual((await resumeWith(stored)).creates, ["split"]);
	});

	it("resume: the current parent default wins over a persisted policy without agent env", async () => {
		process.env.PI_SUBAGENT_REX_PLACEMENT = "window";
		assert.deepEqual((await resumeWith({ rexPlacementPolicy: "split" })).creates, ["window new"]);
	});

	it("resume: the persisted policy applies when the parent sets nothing", async () => {
		assert.deepEqual((await resumeWith({ rexPlacementPolicy: "split" })).creates, ["split"]);
	});
});
