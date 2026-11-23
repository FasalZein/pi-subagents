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
	const id = entryId();
	const content = [{ type: "toolCall", id: callId, name, arguments: args }];
	// Each assistant message has its own time, as in Pi: it tells two uses of one call id apart.
	return { type: "message", id, message: { role: "assistant", content, stopReason: "toolUse", timestamp: n } };
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

describe("context fold safety: codemode launch scripts (owner rule 2026-11-23T11:58Z)", () => {
	const LAUNCH = [
		'const r = await tools.subagent({ children: [{ agent: "w", name: "one", task: "BRIEF-A" }, { agent: "w", name: "two", task: \'BRIEF-B\' }] });',
		"return await tools.subagent_wait({ runIds: r.children.map((c) => c.runId) });",
	].join("\n");
	const LAUNCH_CALLS = [
		{ id: "c1/1", name: "subagent", status: "ok" },
		{ id: "c1/2", name: "subagent_wait", status: "ok" },
	];

	interface ScriptCase {
		code?: string;
		calls?: Entry[];
		complete?: boolean;
		/** Runs whose result message a later completed request saw. */
		finished: Array<[string, string, string?]>;
	}

	/** A codemode script that launched A and B in one nested call, then its later results and a settle. */
	async function scriptSession(c: ScriptCase) {
		const entries: Entry[] = [user("go"), call("c1", "codemode", { code: c.code ?? LAUNCH })];
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
					content: [{ type: "text", text: `${A} ${C}` }],
					nestedCalls: { calls: c.calls ?? LAUNCH_CALLS, complete: c.complete ?? true },
				},
			),
			assistant(),
			user("later"),
			...c.finished.map(([id, name, path]) => resultMessage(done(id, name, path ?? report(name)), `REPORT-${name}`)),
			assistant(),
		);
		await h.settle();
		return { h, entries };
	}
	const original = (code = LAUNCH) => JSON.stringify(code).slice(1, -1);

	it("a launch-only script stays byte-identical until every run it started folds, then folds as a whole", async () => {
		const { h, entries } = await scriptSession({ finished: [[A, "one"]] });
		const partly = await h.request();
		assert.ok(partly.includes(original()), "one child still runs: the script is unchanged");
		entries.push(resultMessage(done(B, "two"), "REPORT-two"), assistant());
		await h.settle();
		const request = await h.request();
		assert.ok(!request.includes(original()));
		assert.doesNotMatch(request, /BRIEF-A|BRIEF-B/);
		assert.match(request, /Folded launch script of runs aaaa0001, bbbb0002\./);
	});

	it("the whole code becomes the stub lines, also for a report path with quotes", async () => {
		const path = join(createTestDir(), "O'Brien `x` ${y}.md");
		writeFileSync(path, "r");
		const other = report("two");
		const { h } = await scriptSession({
			finished: [
				[A, "one", path],
				[B, "two", other],
			],
		});
		const messages = JSON.parse(await h.request()) as Entry[];
		const code = messages
			.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
			.find((block: Entry) => block.name === "codemode")?.arguments.code;
		assert.equal(
			code,
			[
				"// Folded launch script of runs aaaa0001, bbbb0002.",
				`// [Folded subagent run aaaa0001 (one): done, report ${path}. Full result: subagent_wait({ runIds: ["aaaa0001"] })]`,
				`// [Folded subagent run bbbb0002 (two): done, report ${other}. Full result: subagent_wait({ runIds: ["bbbb0002"] })]`,
			].join("\n"),
		);
	});

	it("a script with any other call stays byte-identical, also when all its runs folded", async () => {
		// Review round 2: the launch builds its task; the only equal literal is the parent's own write.
		const code = `${LAUNCH.replace('"BRIEF-A"', '"BRIEF-" + "A"')}\nawait tools.write({ path: "notes.md", content: "BRIEF-A" });`;
		const calls = [...LAUNCH_CALLS, { id: "c1/3", name: "write", status: "ok" }];
		const { h } = await scriptSession({
			code,
			calls,
			finished: [
				[A, "one"],
				[B, "two"],
			],
		});
		assert.ok((await h.request()).includes(original(code)));
	});

	it("an incomplete call record, a failed call or a launch without its entry keeps the script full", async () => {
		for (const c of [
			{ complete: false },
			{ calls: [LAUNCH_CALLS[0], { id: "c1/2", name: "subagent_wait", status: "error" }] },
			{ calls: [...LAUNCH_CALLS, { id: "c1/3", name: "subagent", status: "ok" }] },
		]) {
			const { h } = await scriptSession({
				...c,
				finished: [
					[A, "one"],
					[B, "two"],
				],
			});
			assert.ok((await h.request()).includes(original()), JSON.stringify(c));
		}
	});

	it("the decision is frozen per occurrence: a later entry or a reused call id does not change it", async () => {
		const { h, entries } = await scriptSession({
			finished: [
				[A, "one"],
				[B, "two"],
			],
		});
		assert.doesNotMatch(await h.request(), /BRIEF-A/);
		// A reused outer and nested id in a later turn, before any settle.
		entries.push(user("again"), call("c1", "codemode", { code: "await tools.subagent({ task: 'BRIEF-C' })" }));
		await h.toolResult({
			toolName: "subagent",
			toolCallId: "c1/1",
			parentToolCallId: "c1",
			input: { agent: "w", name: "three", task: "BRIEF-C" },
			details: { id: C, status: "started" },
		});
		const request = await h.request();
		assert.doesNotMatch(request, /BRIEF-A/, "the folded script stays folded mid-turn");
		assert.match(request, /BRIEF-C/, "the new occurrence is not folded");
	});

	it("launch entries keep only run ids; a child session writes none", async () => {
		const { entries } = await scriptSession({ finished: [] });
		const launches = entries.filter((entry) => entry.customType === "subagent_context_fold_launch");
		assert.deepEqual(
			launches.map((entry) => entry.data),
			[{ callId: "c1", nestedId: "c1/1", runIds: [A, B] }],
		);
		const saved = process.env.PI_SUBAGENT_SESSION;
		process.env.PI_SUBAGENT_SESSION = "/tmp/child.jsonl";
		try {
			const child = await scriptSession({ finished: [] });
			assert.equal(child.entries.filter((entry) => entry.customType === "subagent_context_fold_launch").length, 0);
		} finally {
			if (saved === undefined) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = saved;
		}
	});
});
