import { join } from "node:path";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { TIME_LIMIT_GUIDANCE, WRAP_UP_NOTICE } from "../../src/runtime/result-render.ts";
import { routeSubagentOutcome } from "../../src/runtime/result-router.ts";
import { publishedResultFields, publishRunResult, type WatchedEnd } from "../../src/runtime/run-result.ts";
import { buildCompletedSubagentResult } from "../../src/runtime/state.ts";
import { waitForSubagentResult } from "../../src/runtime/wait-result.ts";
import { registerSubagentMessageRenderers } from "../../src/tools/message-renderers.ts";
import { registerSubagentResumeTool } from "../../src/tools/resume-tool.ts";
import {
	markInitialPromptLaunchComplete,
	registerSubagentCoreTools,
	type SubagentToolRuntime,
} from "../../src/tools/subagent-tools.ts";
import {
	CALLER_PING_TOOL_NAME,
	SUBAGENT_DONE_TOOL_NAME,
	SUBAGENT_RESUME_TOOL_NAME,
	SUBAGENT_TOOL_NAME,
} from "../../src/tools/tool-names.ts";
import type { RunningSubagent, SubagentParamsInput, SubagentResult } from "../../src/types.ts";
import {
	afterEach,
	assert,
	createSessionFile,
	createTestDir,
	describe,
	it,
	resetSubagentStateForTest,
	rmSync,
} from "../support/index.ts";
import { assistant, toolCall, toolResult } from "../support/result-fixtures.ts";

/**
 * D14 through the registered TUI renderers: the detached message (message renderer) and the waiting
 * launch (subagent tool renderResult) show the published outcome and rendered text, not a second
 * verdict from the exit facts.
 */
const theme = {
	fg: (_tone: string, text: string) => text,
	bg: (_tone: string, text: string) => text,
	bold: (text: string) => text,
};
const WIDTH = 400;
const dirs: string[] = [];

function setup(entries: object[], overrides: Partial<RunningSubagent> = {}) {
	const root = createTestDir();
	dirs.push(root);
	const sessionFile = createSessionFile(root, entries);
	const store = new ResultStore(join(root, "results"), () => {});
	const reservation = store.reserve();
	return {
		id: reservation.runId,
		name: "worker",
		task: "Work",
		agent: "scout",
		mode: "background",
		phase: "running",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		resultTarget: { store, reservation, parentCwd: root, warnings: [] },
		...overrides,
	} as RunningSubagent;
}

function watchedEnd(overrides: Partial<WatchedEnd> = {}): WatchedEnd {
	return { exitCode: 0, operatorClosed: false, stopped: false, exitSignal: undefined, contextUsage: {}, ...overrides };
}

/** The watcher's result for a published end, with the legacy exit facts the watchers still carry. */
function watcherResult(running: RunningSubagent, end: WatchedEnd, legacy: Partial<SubagentResult>): SubagentResult {
	const published = publishRunResult(running, end)!;
	return {
		name: running.name,
		task: running.task,
		summary: published.summary,
		summarySource: published.summarySource,
		exitCode: end.exitCode,
		elapsed: 5,
		...legacy,
		...publishedResultFields(published),
	};
}

function messageRenderers() {
	const renderers = new Map<string, (...args: unknown[]) => { render(width: number): string[] }>();
	registerSubagentMessageRenderers(
		{ registerMessageRenderer: (name: string, renderer: never) => void renderers.set(name, renderer) } as never,
		(seconds) => `${seconds}s`,
	);
	return renderers;
}

/** The detached message the router sends, rendered by its registered message renderer. */
function renderedMessage(running: RunningSubagent, result: SubagentResult): { text: string; content: string } {
	const sent: Array<{ customType: string; content: string; details: unknown }> = [];
	routeSubagentOutcome({
		pi: { sendMessage: (message: never) => void sent.push(message) },
		running,
		result,
		updateWidget() {},
	} as never);
	assert.equal(sent.length, 1);
	const renderer = messageRenderers().get(sent[0].customType)!;
	return { text: renderer(sent[0], { expanded: true }, theme).render(WIDTH).join("\n"), content: sent[0].content };
}

/** The waiting launch reply, rendered by the registered subagent tool's renderResult. */
async function renderedWaitingLaunch(running: RunningSubagent, result: SubagentResult): Promise<string> {
	const reply = result.ping
		? await waitForSubagentResult({ id: running.id }, {
				findTrackedSubagent: () => ({ running: { ...running, completionPromise: Promise.resolve(result) } }),
				runningSubagents: new Map(),
				updateWidget() {},
			} as never)
		: await waitForSubagentResult({ id: running.id }, {
				findTrackedSubagent: () => ({ cached: buildCompletedSubagentResult(running, result) }),
			} as never);
	const tools = new Map<string, { renderResult: (...args: unknown[]) => { render(width: number): string[] } }>();
	registerSubagentCoreTools(
		{
			registerTool: (definition: never) => void tools.set((definition as { name: string }).name, definition),
			getThinkingLevel: () => "low",
		} as never,
		() => true,
		{} as SubagentToolRuntime,
	);
	const component = tools.get(SUBAGENT_TOOL_NAME)!.renderResult(reply, { expanded: true }, theme, { args: {} });
	return component.render(WIDTH).join("\n");
}

type Rendered = { render(width: number): string[] };
type RegisteredTool = {
	name: string;
	renderResult: (...args: unknown[]) => Rendered;
	// biome-ignore lint/suspicious/noExplicitAny: the tool reply shape is probed dynamically.
	execute: (...args: unknown[]) => Promise<any>;
};

function registeredTools(runtime: Partial<SubagentToolRuntime> = {}) {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool: (definition: RegisteredTool) => void tools.set(definition.name, definition),
		getThinkingLevel: () => "low",
	} as never;
	registerSubagentCoreTools(pi, () => true, runtime as SubagentToolRuntime);
	registerSubagentResumeTool(pi, () => true, {} as never, { mayLaunch: () => true });
	return tools;
}

function replyText(reply: { content: Array<{ type: string; text?: string }> }): string {
	return reply.content.map((block) => block.text ?? "").join("\n\n");
}

/** Every marker the returned text holds is shown by the renderer (differential check). */
function assertShowsMarkers(
	reply: { content: Array<{ type: string; text?: string }> },
	shown: string,
	markers: string[],
) {
	const returned = replyText(reply);
	for (const marker of markers) {
		assert.ok(returned.includes(marker), `returned text lacks ${marker}: ${returned}`);
		assert.ok(shown.includes(marker), `renderer omits ${marker}: ${shown}`);
	}
}

/**
 * The real launch tool over a fake runtime: each named child is a prepared running whose wait
 * reply comes from the given function; every child is blocking, so the launch waits for all.
 */
async function waitedLaunch(
	children: Array<{ running: RunningSubagent; reply: () => Promise<unknown> }>,
): Promise<{ reply: any; shown: string }> {
	const byName = new Map(children.map((entry) => [entry.running.name, entry]));
	const launch = async (params: SubagentParamsInput) => byName.get(params.name)!.running;
	const tools = registeredTools({
		loadAgentDefaults: () => ({ mode: "background", async: false }) as never,
		listLaunchableAgents: () => [],
		launchBackgroundSubagent: launch,
		launchSubagent: launch,
		// The wait replies come from getLaunchedSubagentResult; the watchers never settle here.
		watchBackgroundSubagent: () => new Promise(() => {}),
		watchSubagent: () => new Promise(() => {}),
		getWatcherSignal: (_running, controller) => controller.signal,
		wireSubagentSteerBack: () => {},
		startWidgetRefresh: () => {},
		getLaunchedSubagentResult: async (running: RunningSubagent) => byName.get(running.name)!.reply() as never,
	});
	const args = {
		children: children.map(({ running }) => ({ agent: "scout", name: running.name, title: "t", task: "Work" })),
	};
	const ctx = {
		hasUI: true,
		cwd: process.cwd(),
		sessionManager: { getSessionFile: () => null, getSessionId: () => "p" },
	};
	const tool = tools.get(SUBAGENT_TOOL_NAME)!;
	const reply = await tool.execute("call-1", args, undefined, undefined, ctx);
	const shown = tool.renderResult(reply, { expanded: true }, theme, { args }).render(WIDTH).join("\n");
	return { reply, shown };
}

/** The wait reply for a published end, as the launch tool receives it. */
function publishedWait(running: RunningSubagent, result: SubagentResult) {
	return () =>
		result.ping
			? waitForSubagentResult({ id: running.id }, {
					findTrackedSubagent: () => ({ running: { ...running, completionPromise: Promise.resolve(result) } }),
					runningSubagents: new Map(),
					updateWidget() {},
				} as never)
			: waitForSubagentResult({ id: running.id }, {
					findTrackedSubagent: () => ({ cached: buildCompletedSubagentResult(running, result) }),
				} as never);
}

/** A wait interrupted by Esc (an aborted tool signal) while the child still runs. */
function interruptedWait(running: RunningSubagent) {
	const signal = AbortSignal.abort();
	return () =>
		waitForSubagentResult(
			{ id: running.id },
			{
				findTrackedSubagent: () => ({ running: { ...running, completionPromise: new Promise(() => {}) } }),
				runningSubagents: new Map(),
				updateWidget() {},
			} as never,
			signal,
		);
}

const ANSWER = "ANSWER-MARKER-7f3 the child's published answer.";
const QUESTION = "QUESTION-MARKER-c21 where is the key?";

function doneChild(name: string) {
	const running = setup(
		[
			toolCall(SUBAGENT_DONE_TOOL_NAME, { outcome: "done", summary: ANSWER }, `done-${name}`, "Pre-call text."),
			toolResult(SUBAGENT_DONE_TOOL_NAME, `done-${name}`, "ok"),
		],
		{ name },
	);
	return { running, result: watcherResult(running, watchedEnd(), {}) };
}

function pingChild(name: string) {
	const running = setup([toolCall(CALLER_PING_TOOL_NAME, { message: QUESTION }, `ping-${name}`)], { name });
	const result = watcherResult(running, watchedEnd({ ping: { message: QUESTION } }), {
		ping: { name, message: QUESTION },
	});
	return { running, result };
}

describe("published text displays (B1 review)", () => {
	afterEach(() => {
		resetSubagentStateForTest();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("shows the child's answer in a waiting resume reply with a leading notice block", async () => {
		const { running, result } = doneChild("resumed-worker");
		const waited = await publishedWait(running, result)();
		// A reply whose first text block is a notice before the result block.
		const reply = {
			...waited,
			content: [{ type: "text", text: "notice: context at 91% of the window" }, ...waited.content],
		};
		const shown = registeredTools()
			.get(SUBAGENT_RESUME_TOOL_NAME)!
			.renderResult(reply, { expanded: true }, theme, { args: {} })
			.render(WIDTH)
			.join("\n");
		assertShowsMarkers(reply, shown, ["notice: context at 91% of the window", ANSWER]);
	});

	it("shows each published answer and the ping question of a waiting multi-child launch", async () => {
		markInitialPromptLaunchComplete();
		const done = doneChild("answer-worker");
		const ping = pingChild("ask-worker");
		const { reply, shown } = await waitedLaunch([
			{ running: done.running, reply: publishedWait(done.running, done.result) },
			{ running: ping.running, reply: publishedWait(ping.running, ping.result) },
		]);
		assert.equal(reply.details.status, "batch");
		assertShowsMarkers(reply, shown, [ANSWER, QUESTION]);
	});

	it("shows an interrupted sibling wait as interrupted, not completed, in the reply and the renderer", async () => {
		markInitialPromptLaunchComplete();
		const done = doneChild("finish-worker");
		const waiting = setup([], { name: "wait-worker" });
		const { reply, shown } = await waitedLaunch([
			{ running: done.running, reply: publishedWait(done.running, done.result) },
			{ running: waiting, reply: interruptedWait(waiting) },
		]);
		const text = replyText(reply);
		// The typed reply: the interrupted child holds no finished report.
		assert.equal(reply.details.children[1].status, "interrupted", JSON.stringify(reply.details.children[1]));
		assert.match(text, /Waiting for sub-agent "wait-worker" was interrupted\./);
		assert.doesNotMatch(text, /each report follows below/);
		assert.match(shown, /wait-worker \(scout\) — interrupted/);
		assert.doesNotMatch(shown, /wait-worker \(scout\) — completed/);
		assert.ok(shown.includes(ANSWER), shown);
	});
});

const DONE_CALL = [
	toolCall(SUBAGENT_DONE_TOOL_NAME, { outcome: "done", summary: "All work finished." }, "done-1", "Here is the work."),
	toolResult(SUBAGENT_DONE_TOOL_NAME, "done-1", "ok"),
];

describe("end outcome displays (T09 fix round 1)", () => {
	afterEach(() => {
		resetSubagentStateForTest();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("shows a hard time-limit kill as timed out with its guidance on both carriers", async () => {
		const running = setup([assistant("Partial work.")]);
		const result = watcherResult(running, watchedEnd({ exitCode: 1, timedOut: { kind: "timeout", seconds: 60 } }), {
			timedOut: "timeout",
			timedOutAfter: 60,
		});
		const message = renderedMessage(running, result);
		const waiting = await renderedWaitingLaunch(running, result);
		for (const shown of [message.text, waiting]) {
			assert.match(shown, /✗ worker \(scout\) — timed out/);
			assert.doesNotMatch(shown, /— failed|— completed/);
			assert.ok(shown.replace(/\s+/g, " ").includes(TIME_LIMIT_GUIDANCE.replace(/\s+/g, " ")), shown);
		}
	});

	it("shows a finished report-only wrap-up as timed out with its notice, not completed", async () => {
		const running = setup(DONE_CALL, {
			timeoutWrapUp: { kind: "timeout", seconds: 100, threshold: 80 },
			phase: "wrapping-up",
		});
		const result = watcherResult(running, watchedEnd(), { timeoutWrapUp: running.timeoutWrapUp });
		for (const shown of [renderedMessage(running, result).text, await renderedWaitingLaunch(running, result)]) {
			assert.match(shown, /worker \(scout\) — timed out/);
			assert.doesNotMatch(shown, /— completed/);
			assert.ok(shown.replace(/\s+/g, " ").includes(WRAP_UP_NOTICE.replace(/\s+/g, " ")), shown);
		}
	});

	it("shows a stopped run that exited 0 as cancelled with its rendered record", async () => {
		const running = setup(DONE_CALL);
		const result = watcherResult(running, watchedEnd({ stopped: true }), { error: "cancelled" });
		for (const shown of [renderedMessage(running, result).text, await renderedWaitingLaunch(running, result)]) {
			assert.match(shown, /✗ worker \(scout\) — cancelled/);
			assert.match(shown, /worker · scout · cancelled · /);
		}
	});

	it("renders a waiting single ping and a detached ping as blocked with the rendered record", async () => {
		const message = "Need the API key location.";
		const running = setup([toolCall(CALLER_PING_TOOL_NAME, { message }, "ping-1")]);
		const result = watcherResult(running, watchedEnd({ ping: { message } }), {
			ping: { name: running.name, message },
		});
		const waiting = await renderedWaitingLaunch(running, result);
		const detached = renderedMessage(running, result);
		for (const shown of [waiting, detached.text]) {
			assert.match(shown, /\? worker \(scout\) — blocked/);
			assert.match(shown, /worker · scout · blocked · /);
			assert.ok(shown.includes(message));
		}
		assert.equal(detached.content, result.resultText);
	});
});
