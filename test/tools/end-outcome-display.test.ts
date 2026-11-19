import { join } from "node:path";
import { ResultStore } from "../../src/runtime/result-files.ts";
import { TIME_LIMIT_GUIDANCE, WRAP_UP_NOTICE } from "../../src/runtime/result-render.ts";
import { routeSubagentOutcome } from "../../src/runtime/result-router.ts";
import { publishedResultFields, publishRunResult, type WatchedEnd } from "../../src/runtime/run-result.ts";
import { buildCompletedSubagentResult } from "../../src/runtime/state.ts";
import { waitForSubagentResult } from "../../src/runtime/wait-result.ts";
import { registerSubagentMessageRenderers } from "../../src/tools/message-renderers.ts";
import { registerSubagentCoreTools, type SubagentToolRuntime } from "../../src/tools/subagent-tools.ts";
import { CALLER_PING_TOOL_NAME, SUBAGENT_DONE_TOOL_NAME, SUBAGENT_TOOL_NAME } from "../../src/tools/tool-names.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";
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
		executionState: "running",
		deliveryState: "detached",
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
		formatElapsed: String,
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
			timeoutWrapUpMode: true,
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
