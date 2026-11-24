import { routeSubagentOutcome } from "../../src/runtime/result-router.ts";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import {
	MAX_SPAWN_WIDTH,
	claimSpawnWidthSlot,
	getEffectiveSpawnWidthLimit,
	getLiveSlotCount,
	initializeSpawnWidthForSession,
	releaseSpawnWidthSlot,
	renderSpawnWidthRefusal,
	resetSpawnWidthForTest,
	tryAcquireSlots,
} from "../../src/runtime/spawn-width.ts";
import { registerSubagentCoreTools, type SubagentToolRuntime } from "../../src/tools/subagent-tools.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";
import {
	afterEach,
	assert,
	describe,
	it,
	resetSubagentStateForTest,
	setRunningSubagentForTest,
} from "../support/index.ts";

function makeRunning(id: string): RunningSubagent {
	return {
		id,
		name: id,
		task: "Task",
		title: "Task",
		agent: "worker",
		mode: "background",
		phase: { kind: "running" },
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile: `/tmp/${id}.jsonl`,
	};
}

function makeResult(): SubagentResult {
	return {
		name: "worker",
		task: "Task",
		summary: "Done",
		summarySource: "subagent",
		exitCode: 0,
		elapsed: 1,
	};
}

function registerToolWithRuntime(runtimeOverrides: Partial<SubagentToolRuntime> = {}) {
	const tools = new Map<string, any>();
	const runtime: SubagentToolRuntime = {
		loadAgentDefaults: () => ({ spawning: true }),
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		launchBackgroundSubagent: async (params) => makeRunning(params.name),
		launchSubagent: async (params) => makeRunning(params.name),
		watchBackgroundSubagent: async () => new Promise<SubagentResult>(() => {}),
		watchSubagent: async () => new Promise<SubagentResult>(() => {}),
		getWatcherSignal: (_running, controller) => controller.signal,
		wireSubagentSteerBack: () => {},
		startWidgetRefresh: () => {},
		getLaunchedSubagentResult: async () => ({ content: [{ type: "text", text: "started" }], details: {} }),
		muxUnavailableResult: () => ({ content: [{ type: "text", text: "mux" }], details: {} }),
		listLaunchableAgents: () => [],
		...runtimeOverrides,
	};
	registerSubagentCoreTools(
		{
			registerTool(definition: any) {
				tools.set(definition.name, definition);
				return definition;
			},
			getThinkingLevel: () => "low",
		} as any,
		() => true,
		runtime,
	);
	return tools.get("subagent");
}

function toolContext(hasUI = false) {
	return {
		hasUI,
		cwd: process.cwd(),
		sessionManager: {
			getSessionFile: () => "/tmp/parent.jsonl",
			getSessionId: () => "parent",
		},
	};
}

/**
 * The next step of a refusal without a wait tool (owner 2026-11-24): end the turn; a holder's end
 * frees its slots and its result arrives as a message. The refusal names no tool the fork lacks.
 */
const END_TURN =
	/end this turn \(a codemode script returns\); when (one of the runs [\w, -]+|a started child) ends it frees its slots and its result arrives as a message that starts your next turn/;

function assertNoWaitTool(text: string): void {
	assert.doesNotMatch(text, /subagent_wait/);
}

/** Claims one slot for a running run with this id, as a launched child holds it. */
function holdSlot(id: string): void {
	const slot = tryAcquireSlots(1, null);
	assert.ok(slot);
	claimSpawnWidthSlot(makeRunning(id), slot);
}

/** A verified fan-out agent: each child costs three spawn slots. */
const verifiedAgent = () => ({ spawning: true, llmAsVerifier: true, llmAsVerifierCandidates: 3 }) as never;

const child = (name: string) => ({
	name,
	task: `Task for ${name}`,
	title: `Title for ${name}`,
	agent: "worker-a",
});

describe("spawn width semaphore", () => {
	afterEach(() => resetSubagentStateForTest());

	it("counts leased slots, and a lease gives back only its own slots, once", () => {
		const first = tryAcquireSlots(2, 3);
		assert.ok(first);
		assert.equal(getLiveSlotCount(), 2);
		assert.equal(tryAcquireSlots(2, 3), null);
		const part = first.split(1);
		part.release();
		part.release();
		assert.equal(getLiveSlotCount(), 1, "a second release of the same lease frees nothing");
		const second = tryAcquireSlots(2, 3);
		assert.ok(second);
		assert.equal(getLiveSlotCount(), 3);
		first.release();
		assert.equal(getLiveSlotCount(), 2, "the other holder keeps its slots");
		second.release();
		assert.equal(getLiveSlotCount(), 0);
	});

	it("answers who holds a slot from the owner map across claim, release and reset (ticket G)", () => {
		const holdersText = () => renderSpawnWidthRefusal("subagent", [1], 1, { launchesWait: false });
		const first = makeRunning("owner-a");
		const firstLease = tryAcquireSlots(1, null);
		assert.ok(firstLease);
		claimSpawnWidthSlot(first, firstLease);
		assert.equal(getLiveSlotCount(), 1);
		assert.match(holdersText(), /held by owner-a\)/);

		releaseSpawnWidthSlot(first);
		assert.equal(getLiveSlotCount(), 0);
		assert.doesNotMatch(holdersText(), /held by/);
		const other = tryAcquireSlots(1, null);
		assert.ok(other);
		releaseSpawnWidthSlot(first);
		assert.equal(getLiveSlotCount(), 1, "a second release of the same owner frees nothing");
		other.release();

		claimSpawnWidthSlot(first, tryAcquireSlots(1, null) ?? assert.fail("slot"));
		resetSpawnWidthForTest();
		assert.equal(getLiveSlotCount(), 0);
		assert.doesNotMatch(holdersText(), /held by/);
		const second = makeRunning("owner-b");
		claimSpawnWidthSlot(second, tryAcquireSlots(1, null) ?? assert.fail("slot"));
		releaseSpawnWidthSlot(first);
		assert.equal(getLiveSlotCount(), 1, "the reset dropped the old owner, so its release frees nothing");
		assert.match(holdersText(), /held by owner-b\)/);
	});

	it("applies the width backstop to configured and unlimited sessions", () => {
		process.env.PI_SUBAGENT_SPAWN_WIDTH = "99";
		initializeSpawnWidthForSession();
		assert.equal(getEffectiveSpawnWidthLimit(), MAX_SPAWN_WIDTH);

		delete process.env.PI_SUBAGENT_SPAWN_WIDTH;
		initializeSpawnWidthForSession();
		assert.equal(getEffectiveSpawnWidthLimit(), MAX_SPAWN_WIDTH);
		assert.ok(tryAcquireSlots(MAX_SPAWN_WIDTH, getEffectiveSpawnWidthLimit()));
		assert.equal(tryAcquireSlots(1, getEffectiveSpawnWidthLimit()), null);
	});

	it("returns a recoverable refusal with a kill remedy at the live limit", async () => {
		process.env.PI_SUBAGENT_SPAWN_WIDTH = "1";
		initializeSpawnWidthForSession();
		// T89b: a run with an id holds the slot; a kill cannot name a launch that is still starting.
		holdSlot("busy-a");
		let launches = 0;
		const tool = registerToolWithRuntime({
			launchBackgroundSubagent: async (params) => {
				launches++;
				return makeRunning(params.name);
			},
		});

		const result = await tool.execute("call-1", { children: [child("worker-a")] }, undefined, undefined, toolContext());
		assert.match(result.content[0].text, /Spawn width limit reached \(1\/1 slots busy, held by busy-a\)/);
		assert.match(result.content[0].text, /subagent_kill/);
		assert.equal(launches, 0);
	});

	it("rejects an oversized batch before launching or acquiring slots", async () => {
		process.env.PI_SUBAGENT_SPAWN_WIDTH = "2";
		initializeSpawnWidthForSession();
		let launches = 0;
		const tool = registerToolWithRuntime({
			launchBackgroundSubagent: async (params) => {
				launches++;
				return makeRunning(params.name);
			},
		});

		const result = await tool.execute(
			"call-2",
			{ children: [child("worker-a"), child("worker-b"), child("worker-c")] },
			undefined,
			undefined,
			toolContext(),
		);
		assert.match(result.content[0].text, /batch of 3.*width limit.*2/i);
		assert.equal(launches, 0);
		assert.equal(getLiveSlotCount(), 0);
	});

	it("rolls back reservations for children that were not launched", async () => {
		process.env.PI_SUBAGENT_SPAWN_WIDTH = "3";
		initializeSpawnWidthForSession();
		let launches = 0;
		const tool = registerToolWithRuntime({
			launchBackgroundSubagent: async (params) => {
				launches++;
				if (launches === 2) throw new Error("launch failed");
				return makeRunning(params.name);
			},
		});

		// D16 (T28): a later child's failure is an error result that names the started child, not a throw.
		const result = await tool.execute(
			"call-3",
			{ children: [child("worker-a"), child("worker-b"), child("worker-c")] },
			undefined,
			undefined,
			toolContext(),
		);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /launch failed/);
		assert.equal(launches, 2);
		assert.equal(getLiveSlotCount(), 1);
	});

	/** A refusal in a TUI parent by default (results arrive as messages); hasUI false: every launch waits. */
	async function launchRefusal(
		width: string,
		batch: string[],
		overrides: Partial<SubagentToolRuntime> = {},
		hasUI = true,
	) {
		process.env.PI_SUBAGENT_SPAWN_WIDTH = width;
		initializeSpawnWidthForSession();
		const tool = registerToolWithRuntime(overrides);
		const result = await tool.execute(
			"call-r",
			{ children: batch.map(child) },
			undefined,
			undefined,
			toolContext(hasUI),
		);
		assert.equal(result.isError, true, "the refusal stays an error result");
		return result.content[0].text as string;
	}

	const NO_REST_PROMISE = /launch the rest/;
	const REPEAT = /repeat while it is refused/;

	it("names the busy runs and says to end the turn when a launch finds every slot busy", async () => {
		holdSlot("busy-a");
		holdSlot("busy-b");
		const text = await launchRefusal("2", ["worker-a"]);
		assert.match(text, /held by busy-a, busy-b/);
		assert.match(text, END_TURN);
		assertNoWaitTool(text);
		assert.match(text, REPEAT);
		assert.match(text, /auto-exit: false keep their slot until the pane closes/);
	});

	it("names the holder and the end-turn step for an oversized batch", async () => {
		holdSlot("busy-a");
		const text = await launchRefusal("3", ["worker-a", "worker-b", "worker-c", "worker-d"]);
		assert.match(text, /one of the runs busy-a ends/);
		assert.match(text, END_TURN);
		assertNoWaitTool(text);
		assert.match(text, /batch of 4 subagents exceeds the spawn width limit of 3/);
		assert.match(text, /The first 2 children \(2 slots\) fit now/);
	});

	it("does not promise that one wait admits the rest of a batch", async () => {
		const text = await launchRefusal("1", ["worker-a", "worker-b", "worker-c"]);
		assert.match(text, /The first 1 child \(1 slot\) fits now/);
		assert.doesNotMatch(text, NO_REST_PROMISE);
		assert.match(text, REPEAT);
	});

	it("counts fit-now children by their slot costs", async () => {
		const text = await launchRefusal("3", ["worker-a", "worker-b", "worker-c", "worker-d"], {
			loadAgentDefaults: verifiedAgent,
		});
		assert.match(text, /The first 1 child \(3 slots\) fits now/);
	});

	it("says a child wider than the whole limit never starts, and names no end-turn step", async () => {
		const text = await launchRefusal("2", ["worker-a"], { loadAgentDefaults: verifiedAgent });
		assert.match(text, /needs 3 slots, more than the whole limit of 2/);
		assert.doesNotMatch(text, END_TURN);
	});

	it("names no end-turn step for a slot that a still-starting launch holds, and says to retry", async () => {
		assert.ok(tryAcquireSlots(1, null));
		const text = await launchRefusal("1", ["worker-a"]);
		assert.doesNotMatch(text, END_TURN, "no run with a result message holds the slot");
		assertNoWaitTool(text);
		assert.match(text, /still starting/);
		assert.match(text, /Retry the refused call after that launch replies/);
	});

	it("names only the holders with a run id when a starting launch also holds a slot", async () => {
		holdSlot("busy-a");
		assert.ok(tryAcquireSlots(1, null));
		const text = await launchRefusal("2", ["worker-a"]);
		assert.match(text, /held by busy-a\)/);
		assert.match(text, END_TURN);
		assert.match(text, /still starting/);
	});

	// Review of 4f7000d (P1): a parent whose launches wait (pi -p, a background coordinator, no UI)
	// has no later turn and gets no result message, so its refusal never says to end the turn.
	const WAITING = /Launches in this session wait: .*Do not end your turn: when (it|that call) returns, /;
	it("in a session whose launches wait, tells the parent to retry after the fit-now launch returns, not to end its turn", async () => {
		const text = await launchRefusal("2", ["worker-a", "worker-b", "worker-c"], {}, false);
		assert.match(text, /The first 2 children \(2 slots\) fit now/);
		assert.match(text, WAITING);
		assert.match(text, /call subagent again with the children that have not started/);
		assert.doesNotMatch(text, END_TURN);
		assert.doesNotMatch(text, /end this turn|arrives as a message/);
		assertNoWaitTool(text);
	});

	it("in a session whose launches wait, names the holders of another waiting call and the retry after it", async () => {
		holdSlot("busy-a");
		const text = await launchRefusal("1", ["worker-a"], {}, false);
		assert.match(text, /the runs busy-a belong to another call of yours that waits for them/);
		assert.match(text, WAITING);
		assert.doesNotMatch(text, /end this turn/);
	});

	it("tells a refused resume in a session whose launches wait to retry after the waiting call returns", async () => {
		process.env.PI_SUBAGENT_SPAWN_WIDTH = "1";
		initializeSpawnWidthForSession();
		holdSlot("busy-a");
		await assert.rejects(
			resumeSubagentSession(
				{
					resultsDir: "/tmp/t89b-results",
					parent: { parentCwd: process.cwd(), warnings: [] },
					sessionFile: "/tmp/t89b-missing-session.jsonl",
					mode: "background",
					launchesWait: true,
				} as never,
				{ runningSubagents: new Map() } as never,
			),
			(error: Error) => {
				assert.match(error.message, WAITING);
				assert.match(error.message, /call subagent_resume again/);
				assert.doesNotMatch(error.message, /end this turn/);
				return true;
			},
		);
	});

	it("tells a refused resume to end the turn and retry the resume", async () => {
		process.env.PI_SUBAGENT_SPAWN_WIDTH = "1";
		initializeSpawnWidthForSession();
		holdSlot("busy-a");
		await assert.rejects(
			resumeSubagentSession(
				{
					resultsDir: "/tmp/t89b-results",
					parent: { parentCwd: process.cwd(), warnings: [] },
					sessionFile: "/tmp/t89b-missing-session.jsonl",
					mode: "background",
				} as never,
				{ runningSubagents: new Map() } as never,
			),
			(error: Error) => {
				assert.match(error.message, END_TURN);
				assertNoWaitTool(error.message);
				assert.match(error.message, /call subagent_resume again/);
				assert.doesNotMatch(error.message, /launch again/);
				assert.match(error.message, /auto-exit: false keep their slot until the pane closes/);
				return true;
			},
		);
	});

	it("releases a claimed slot through the completion routing path", () => {
		const slot = tryAcquireSlots(1, 1);
		assert.ok(slot);
		const running = makeRunning("completed-child");
		claimSpawnWidthSlot(running, slot);
		setRunningSubagentForTest(running);
		routeSubagentOutcome({
			pi: { sendMessage() {} },
			running,
			result: makeResult(),
			updateWidget: () => {},
		});
		assert.equal(getLiveSlotCount(), 0);
	});
});
