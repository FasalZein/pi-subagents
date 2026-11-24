import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
	buildSystemPrompt,
	normalizeBuildSystemPromptOptions,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import subagentsExtension from "../../src/subagents.ts";
import {
	installRootOnlyContextStrip,
	stripRootOnlyBlocks,
	stripRootOnlyProjectContext,
} from "../../src/tools/root-only-context.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	join,
	mkdirSync,
	resetSubagentStateForTest,
	writeFileSync,
} from "../support/index.ts";

// Contract (src/tools/root-only-context.ts, README "Root-only AGENTS.md text"): a block runs from a
// line holding only the opening marker to a line holding only the closing one; a child gets each
// context file without its blocks, whole lines removed and every other byte kept; markers out of
// order leave the file whole with one warning; the root's prompt is unchanged.
// Property list: reviewer report ~/.pi/artifacts/reviewer/root-only-strip-20261124.md, Q4 (1-8);
// 9 covers the sibling entry point that cleans an inherited project_context section.

const CASES = { testCases: 1000 };
type File = { path: string; content: string };

/** Independent oracle for "this line is a marker": only blanks around `<!--`, the name, `-->`. */
function markerKind(line: string): "open" | "close" | undefined {
	const body = line.replace(/^[ \t]+|[ \t]+$/g, "");
	if (!body.startsWith("<!--") || !body.endsWith("-->")) return undefined;
	const name = body.slice(4, -3).replace(/^[ \t]+|[ \t]+$/g, "");
	if (name === "pi-subagents:root-only") return "open";
	if (name === "/pi-subagents:root-only") return "close";
	return undefined;
}

const markerLine = (closing: boolean) =>
	gs.composite((tc) => {
		const ws = () => tc.draw(gs.sampledFrom(["", " ", "\t", "  "]));
		return `${ws()}<!--${ws()}${closing ? "/" : ""}pi-subagents:root-only${ws()}-->${ws()}`;
	});

// A line that is never a marker: prose, blanks, inline markers, and the halves of a marker.
const textLine = gs.oneOf(
	gs.text({ alphabet: "ab -<>!/`#:", maxSize: 12 }).map((text) => `x${text}`),
	gs.sampledFrom(["", " ", "\t", "<!-- ", "pi-subagents:root-only -->", "-->", "<!--"]),
	gs.composite((tc) => {
		const before = tc.draw(gs.sampledFrom(["`", "text ", "x"]));
		const after = tc.draw(gs.sampledFrom(["`", " text", "", "."]));
		return `${before}${tc.draw(markerLine(tc.draw(gs.booleans())))}${after}`;
	}),
	gs.composite((tc) => `${tc.draw(markerLine(tc.draw(gs.booleans())))} trailing`),
);

type Part = { kind: "segment"; lines: string[] } | { kind: "block"; open: string; lines: string[]; close: string };
type Doc = { text: string; kept: string; parts: Part[] };

/** A well-formed document from segments and blocks, and the text a child must get (the segments). */
const docs = gs.composite((tc): Doc => {
	const eol = tc.draw(gs.sampledFrom(["\n", "\r\n"]));
	const parts = tc.draw(
		gs.arrays(
			gs.oneOf(
				gs.arrays(textLine, { maxSize: 4 }).map((lines): Part => ({ kind: "segment", lines })),
				gs.composite(
					(inner): Part => ({
						kind: "block",
						open: inner.draw(markerLine(false)),
						lines: [...inner.draw(gs.arrays(textLine, { maxSize: 3 })), "BLOCK_SENTINEL"],
						close: inner.draw(markerLine(true)),
					}),
				),
			),
			{ maxSize: 6 },
		),
	);
	const flat = parts.flatMap((part) =>
		part.kind === "segment"
			? part.lines.map((line) => ({ line, kept: true }))
			: [part.open, ...part.lines, part.close].map((line) => ({ line, kept: false })),
	);
	// The last line may lack its line break; a kept last line then lacks it too.
	const bareLast = flat.length > 0 && tc.draw(gs.booleans());
	const withBreak = (line: string, i: number) => line + (bareLast && i === flat.length - 1 ? "" : eol);
	return {
		text: flat.map((item, i) => withBreak(item.line, i)).join(""),
		kept: flat.map((item, i) => (item.kept ? withBreak(item.line, i) : "")).join(""),
		parts,
	};
});

const lines = (text: string) => text.split(/\r?\n/);
const strippedText = (text: string) => {
	const outcome = stripRootOnlyBlocks(text);
	assert.equal(outcome.kind, "stripped");
	return outcome.kind === "stripped" ? outcome.text : text;
};

type Handler = (event: unknown, ctx: unknown) => unknown;
function handlersOf(load: (pi: never) => void): Handler[] {
	const handlers: Handler[] = [];
	const noop = () => {};
	load({
		on: (event: string, handler: Handler) => event === "before_agent_start" && handlers.push(handler),
		registerTool: noop,
		registerCommand: noop,
		registerShortcut: noop,
		registerMessageRenderer: noop,
		registerFlag: noop,
		sendMessage: noop,
		sendUserMessage: noop,
		appendEntry: noop,
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: noop,
		getThinkingLevel: () => "low",
	} as never);
	return handlers;
}
function uiContext(notes: string[]) {
	return {
		cwd: "/repo",
		hasUI: true,
		mode: "print",
		ui: { setWidget() {}, setStatus() {}, notify: (message: string) => notes.push(message) },
		sessionManager: {
			getHeader: () => ({ id: "s", type: "session", timestamp: "", cwd: "/repo" }),
			getSessionId: () => "s",
			getSessionFile: () => undefined,
			getBranch: () => [],
			getEntries: () => [],
		},
	};
}
/** Run before_agent_start handlers over one options object, as Pi does; return the options and prompt. */
async function promptStart(handlers: Handler[], files: File[], ctx: unknown) {
	const options = normalizeBuildSystemPromptOptions({ cwd: "/repo", selectedTools: ["read"], contextFiles: files });
	for (const handler of handlers) {
		const result = (await handler(
			{
				type: "before_agent_start",
				prompt: "p",
				systemPromptOptions: options,
				get systemPrompt() {
					return buildSystemPrompt(options);
				},
			},
			ctx,
		)) as { systemPrompt?: string } | undefined;
		if (result?.systemPrompt !== undefined) options.forceSystemPrompt = result.systemPrompt;
	}
	return { options, prompt: buildSystemPrompt(options) };
}

/** A file whose marker lines form a random sequence; `wellFormed` is the oracle (open close)*. */
const markedFiles = gs.composite((tc) => {
	const kinds = tc.draw(gs.arrays(gs.booleans(), { maxSize: 5 }));
	const body = kinds.flatMap((closing) => [tc.draw(textLine), tc.draw(markerLine(closing))]);
	const content = `${[...body, tc.draw(textLine)].join("\n")}\n`;
	const wellFormed = /^(OC)*$/.test(kinds.map((closing) => (closing ? "C" : "O")).join(""));
	return { path: `/f/${tc.draw(gs.integers({ minValue: 0, maxValue: 3 }))}/AGENTS.md`, content, wellFormed };
});

afterEach(() => resetSubagentStateForTest());

describe("root-only strip properties", () => {
	it("P1 model: the output is exactly the segments, in order, with no block text", () =>
		hegel.test((tc) => {
			const doc = tc.draw(docs, "doc");
			const out = strippedText(doc.text);
			assert.equal(out, doc.kept);
			assert.ok(!out.includes("BLOCK_SENTINEL"));
		}, CASES));

	it("P2 identity: text without a marker line comes back byte for byte", () =>
		hegel.test((tc) => {
			const text = tc.draw(
				gs.oneOf(
					gs.text({ maxSize: 60 }),
					gs.arrays(textLine, { maxSize: 6 }).map((ls) => ls.join("\n")),
				),
				"text",
			);
			tc.assume(lines(text).every((line) => markerKind(line) === undefined));
			assert.deepEqual(stripRootOnlyBlocks(text), { kind: "stripped", text });
		}, CASES));

	it("P3 idempotence: stripping the output again changes nothing", () =>
		hegel.test((tc) => {
			const out = strippedText(tc.draw(docs, "doc").text);
			assert.equal(strippedText(out), out);
		}, CASES));

	it("P4 no marker line survives a well-formed input", () =>
		hegel.test((tc) => {
			const out = strippedText(tc.draw(docs, "doc").text);
			assert.deepEqual(
				lines(out).filter((line) => markerKind(line) !== undefined),
				[],
			);
		}, CASES));

	it("P5 classification: malformed exactly when markers are not (open close)*; then whole, one warning", async () =>
		hegel.testAsync(async (tc) => {
			const file = tc.draw(markedFiles, "file");
			assert.equal(stripRootOnlyBlocks(file.content).kind, file.wellFormed ? "stripped" : "malformed");
			const notes: string[] = [];
			const handlers = handlersOf((pi) => installRootOnlyContextStrip(pi));
			const first = await promptStart(handlers, [{ ...file }], uiContext(notes));
			await promptStart(handlers, [{ ...file }], uiContext(notes));
			if (file.wellFormed) assert.equal(notes.length, 0);
			else {
				assert.equal(first.options.contextFiles[0]?.content, file.content);
				assert.equal(notes.length, 1);
				assert.ok(notes[0]?.includes(file.path));
			}
		}, CASES));

	it("P6 per-file independence: a file list strips like each file alone", async () =>
		hegel.testAsync(async (tc) => {
			const files = tc
				.draw(gs.arrays(markedFiles, { maxSize: 4 }), "files")
				.map(({ path, content }, i) => ({ path: `${path}${i}`, content }));
			const handlers = handlersOf((pi) => installRootOnlyContextStrip(pi));
			const together = await promptStart(
				handlers,
				files.map((file) => ({ ...file })),
				uiContext([]),
			);
			for (const [index, file] of files.entries()) {
				const alone = await promptStart(
					handlersOf((pi) => installRootOnlyContextStrip(pi)),
					[{ ...file }],
					uiContext([]),
				);
				assert.equal(together.options.contextFiles[index]?.content, alone.options.contextFiles[0]?.content);
			}
		}, CASES));

	it("P7 root invariance: the root extension leaves Pi's prompt as Pi builds it", async () => {
		const configDir = join(createTestDir(), "agent-root");
		mkdirSync(join(configDir, "agents"), { recursive: true });
		writeFileSync(
			join(configDir, "agents", "scout.md"),
			"---\nname: scout\ndescription: Map\nmode: background\n---\n\nbody.",
		);
		const saved = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = configDir;
		try {
			await hegel.testAsync(
				async (tc) => {
					const files = tc.draw(
						gs.oneOf(
							docs.map((doc) => [{ path: "/g/AGENTS.md", content: doc.text }]),
							gs.arrays(markedFiles, { maxSize: 3 }),
						),
						"files",
					);
					const handlers = handlersOf((pi) => subagentsExtension(pi));
					assert.ok(handlers.length > 0);
					const run = await promptStart(
						handlers,
						files.map(({ path, content }) => ({ path, content })),
						uiContext([]),
					);
					// The agent index is the root's own section; compare everything else.
					const plain = buildSystemPrompt(
						normalizeBuildSystemPromptOptions({
							cwd: "/repo",
							selectedTools: ["read"],
							contextFiles: files.map(({ path, content }) => ({ path, content })),
						}),
					);
					const projectContext = (prompt: string) =>
						prompt.slice(prompt.indexOf("<project_context>"), prompt.indexOf("</project_context>"));
					assert.equal(projectContext(run.prompt), projectContext(plain));
					resetSubagentStateForTest();
				},
				{ testCases: 200 },
			);
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
		}
	});

	it("P8 line safety: a marker inside a line of prose or inline code is kept as text", () =>
		hegel.test((tc) => {
			const doc = tc.draw(docs, "doc");
			const out = strippedText(doc.text);
			const inline = doc.parts
				.flatMap((part) => (part.kind === "segment" ? part.lines : []))
				.filter((line) => line.includes("pi-subagents:root-only"));
			const outLines = lines(out);
			for (const line of inline) assert.ok(outLines.includes(line), line);
		}, CASES));

	it("P9 inherited section: cleaning a rendered project_context equals rendering the cleaned files", () =>
		hegel.test((tc) => {
			const files = tc.draw(gs.arrays(markedFiles, { maxSize: 4 }), "files");
			const render = (list: Array<{ path: string; content: string }>) =>
				buildSystemPrompt(
					normalizeBuildSystemPromptOptions({ cwd: "/repo", selectedTools: ["read"], contextFiles: list }),
				);
			const cleaned = files.map(({ path, content }) => {
				const outcome = stripRootOnlyBlocks(content);
				return { path, content: outcome.kind === "stripped" ? outcome.text : content };
			});
			assert.equal(stripRootOnlyProjectContext(render(files)), render(cleaned));
		}, CASES));
});
