import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerContextFold } from "../../src/runtime/context-fold.ts";
import { assert, createTestDir, describe, it } from "../support/index.ts";

// Review round 1 (reviewer/context-fold-settle-gpt-2026-11-23-090148.md): each case is a sequence
// that folded something unsafe or missed a used run. Principle (owner, no regressions): when the
// fold cannot prove an item safe, it stays full. The hooks run as Pi calls them: tool_result,
// agent_settled, then context on the messages Pi builds from the branch.

type Entry = Record<string, unknown>;
type Handler = (event: unknown, ctx: unknown) => unknown;

const A = "aaaa0001";
const B = "bbbb0002";
const C = "cccc0003";

let n = 0;
const entryId = () => `s${++n}`;

function harness(entries: Entry[], api = "anthropic-messages") {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", id: entryId(), customType, data });
		},
	};
	registerContextFold(pi as never);
	const ctx = { sessionManager: { getBranch: () => entries, getEntries: () => entries }, model: { api } };
	const emit = async (name: string, event: unknown) => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) result = (await handler(event, ctx)) ?? result;
		return result;
	};
	/** The messages Pi builds from the branch: message entries and custom messages. */
	const messages = () =>
		entries.flatMap((entry) =>
			entry.type === "message"
				? [entry.message]
				: entry.type === "custom_message"
					? [
							{
								role: "custom",
								customType: entry.customType,
								content: entry.content,
								display: true,
								details: entry.details,
								timestamp: 1,
							},
						]
					: [],
		);
	return {
		settle: () => emit("agent_settled", { type: "agent_settled", aborted: false }),
		toolResult: (event: Entry) => emit("tool_result", { type: "tool_result", isError: false, content: [], ...event }),
		/** The provider messages after the context hook, as JSON. */
		async request(): Promise<string> {
			const list = messages();
			const result = (await emit("context", { type: "context", messages: list })) as
				| { messages?: unknown[] }
				| undefined;
			return JSON.stringify(result?.messages ?? list);
		},
		folds: () => entries.filter((entry) => entry.customType === "subagent_context_fold").length,
	};
}

/** A saved report file; the fold needs it on disk at the settle. */
function report(name: string): string {
	const path = join(createTestDir(), `${name}.md`);
	writeFileSync(path, `# ${name}\n`);
	return path;
}

const user = (text: string): Entry => ({ type: "message", id: entryId(), message: { role: "user", content: text } });
const assistant = (stopReason = "stop"): Entry => ({
	type: "message",
	id: entryId(),
	message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason },
});
function resultMessage(details: Entry, content: string): Entry {
	return { type: "custom_message", id: entryId(), customType: "subagent_result", content, display: true, details };
}
function call(callId: string, name: string, args: Entry): Entry {
	return {
		type: "message",
		id: entryId(),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name, arguments: args }],
			stopReason: "toolUse",
		},
	};
}
function reply(callId: string, toolName: string, details: Entry, extra: Entry = {}): Entry {
	return {
		type: "message",
		id: entryId(),
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName,
			content: [{ type: "text", text: "r" }],
			details,
			...extra,
		},
	};
}
const done = (id: string, name: string, reportFile = report(name)) => ({
	id,
	name,
	status: "completed",
	outcome: "done",
	reportFile,
});

describe("context fold safety: what folds at a settle", () => {
	it("an errored or aborted request is no proof of use; the next completed request is", async () => {
		const entries = [user("go"), resultMessage(done(A, "one"), "REPORT-A"), assistant("error"), assistant("aborted")];
		const h = harness(entries);
		await h.settle();
		assert.equal(h.folds(), 0);
		assert.match(await h.request(), /REPORT-A/);
		entries.push(user("again"), assistant());
		await h.settle();
		assert.equal(h.folds(), 1);
		assert.doesNotMatch(await h.request(), /REPORT-A/);
	});

	it("a verified-run provenance notice and a verified run's result never fold", async () => {
		const notice = resultMessage({ provenance: true, id: A, verifiedRunId: `vr-${A}`, sessionId: "s" }, "NOTICE-TEXT");
		const verified = resultMessage({ ...done(B, "two"), verifiedRunId: `vr-${B}` }, "VERIFIED-REPORT");
		const entries = [user("go"), notice, verified, assistant()];
		const h = harness(entries);
		await h.settle();
		assert.equal(h.folds(), 0);
		const request = await h.request();
		assert.match(request, /NOTICE-TEXT/);
		assert.match(request, /VERIFIED-REPORT/);
	});

	it("a run whose report file is not on disk stays full", async () => {
		const missing = join(createTestDir(), "gone.md");
		const entries = [user("go"), resultMessage(done(A, "one", missing), "REPORT-A"), assistant()];
		const h = harness(entries);
		await h.settle();
		assert.equal(h.folds(), 0);
		assert.match(await h.request(), /REPORT-A/);
	});

	it("a wait reply's record.report.path is the stub's report path", async () => {
		const path = report("one");
		const entries = [
			user("go"),
			call("l1", "subagent", { agent: "w", name: "one", task: "BRIEF-A" }),
			reply("l1", "subagent", { id: A, name: "one", status: "started" }),
			call("w1", "subagent_wait", { runIds: [A] }),
			reply("w1", "subagent_wait", {
				status: "complete",
				results: [{ runId: A, name: "one", text: "R", record: { outcome: "done", report: { saved: true, path } } }],
			}),
			assistant(),
		];
		const h = harness(entries);
		await h.settle();
		const request = await h.request();
		assert.doesNotMatch(request, /BRIEF-A/);
		assert.ok(request.includes(`report ${path}.`), "the stub names the saved report");
		assert.match(request, /"text":"r"/, "the wait reply stays full");
	});

	it("a forked child transcript reopened as a plain session never folds", async () => {
		const entries = [
			user("parent work"),
			resultMessage(done(A, "one"), "REPORT-A"),
			assistant(),
			{
				type: "custom",
				id: entryId(),
				customType: "subagent_context_fold",
				data: { runs: [{ id: A, name: "one", outcome: "done", report: "/r", foldedAt: 10 }] },
			},
			{ type: "custom", id: entryId(), customType: "pi-subagents_launch_metadata", data: { version: 1 } },
			user("child task"),
			assistant(),
		];
		const h = harness(entries);
		await h.settle();
		assert.equal(h.folds(), 1, "no new fold entry");
		assert.match(await h.request(), /REPORT-A/, "inherited folds do not apply");
	});
});

describe("context fold safety: what the provider gets", () => {
	it("folds only for the Anthropic messages and OpenAI Responses APIs", async () => {
		for (const [api, folds] of [
			["anthropic-messages", true],
			["openai-responses", true],
			["bedrock-converse-stream", false],
			["google-generative-ai", false],
			["openai-completions", false],
		] as const) {
			const entries = [user("go"), resultMessage(done(A, "one"), "REPORT-A"), assistant()];
			const h = harness(entries, api);
			await h.settle();
			assert.equal(!/REPORT-A/.test(await h.request()), folds, api);
		}
	});

	it("a grouped message with an unidentified member stays full", async () => {
		const grouped = resultMessage(
			{
				results: [
					{ customType: "subagent_result", content: "REPORT-A", details: done(A, "one") },
					{ customType: "subagent_result", content: "REPORT-X", details: { name: "x" } },
				],
			},
			"REPORT-A\n\nREPORT-X",
		);
		const h = harness([user("go"), grouped, assistant()]);
		await h.settle();
		assert.match(await h.request(), /REPORT-A\\n\\nREPORT-X/);
	});

	it("an empty children list in either form is the top-level single form", async () => {
		for (const children of [[], "[]"]) {
			const entries = [
				user("go"),
				call("l1", "subagent", { agent: "w", name: "one", task: "BRIEF-A", children }),
				reply("l1", "subagent", done(A, "one")),
				assistant(),
			];
			const h = harness(entries);
			await h.settle();
			assert.doesNotMatch(await h.request(), /BRIEF-A/, JSON.stringify(children));
		}
	});

	it("pairs each launch call with the reply of its own turn, not a later call with the same id", async () => {
		const entries = [
			user("go"),
			call("x", "subagent", { agent: "w", name: "one", task: "BRIEF-A" }),
			reply("x", "subagent", done(A, "one")),
			assistant(),
			user("more"),
			call("x", "subagent", { agent: "w", name: "three", task: "BRIEF-C" }),
			reply("x", "subagent", { id: C, name: "three", status: "started" }),
			assistant(),
		];
		const h = harness(entries);
		await h.settle();
		const request = await h.request();
		assert.doesNotMatch(request, /BRIEF-A/, "the used run's brief folds");
		assert.match(request, /BRIEF-C/, "the running run's brief stays");
	});
});

describe("context fold safety: codemode launch scripts", () => {
	const CODE = [
		"const r = await tools.subagent({ children: [",
		'  { agent: "w", name: "one", task: "BRIEF-A" },',
		'  { agent: "w", name: "two", task: `BRIEF-B` },',
		"] });",
		'await tools.write({ path: "notes.md", content: "KEEP-THIS" });',
		"return r.children[0].runId;",
	].join("\n");

	async function script(code: string, output: string) {
		const entries: Entry[] = [user("go"), call("c1", "codemode", { code })];
		const h = harness(entries);
		// The nested launch as Pi runs it: its own tool_result with the parent call id.
		await h.toolResult({
			toolName: "subagent",
			toolCallId: "c1/1",
			parentToolCallId: "c1",
			input: {
				children: [
					{ agent: "w", name: "one", task: "BRIEF-A" },
					{ agent: "w", name: "two", task: "BRIEF-B" },
				],
			},
			details: {
				status: "started",
				children: [
					{ id: A, status: "started" },
					{ id: B, status: "started" },
				],
			},
		});
		entries.push(
			reply(
				"c1",
				"codemode",
				{},
				{
					content: [{ type: "text", text: output }],
					nestedCalls: { calls: [{ id: "c1/1", name: "subagent", status: "ok" }], complete: true },
				},
			),
			assistant(),
			user("later"),
			resultMessage(done(A, "one"), "REPORT-A"),
			assistant(),
		);
		await h.settle();
		return h.request();
	}

	it("replaces only the folded run's task literal; the running sibling's task and other code stay", async () => {
		// The output names only A, and an unrelated id; neither decides what folds.
		const request = await script(CODE, `${A} ${C}`);
		assert.doesNotMatch(request, /BRIEF-A/);
		assert.match(request, /BRIEF-B/);
		assert.match(request, /KEEP-THIS/);
		assert.match(request, /Folded subagent run aaaa0001/);
	});

	it("leaves the script full when the folded task is not in the code verbatim", async () => {
		const built = CODE.replace('task: "BRIEF-A"', 'task: "BRIEF-" + "A"');
		const request = await script(built, A);
		assert.match(request, /BRIEF-\\" \+ \\"A/);
		assert.match(request, /KEEP-THIS/);
	});
});
