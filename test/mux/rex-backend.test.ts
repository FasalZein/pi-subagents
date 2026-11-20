import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getMuxBackend, muxSetupHint } from "../../src/mux/core.ts";
import { resolveRexPlacementPolicy, rexBackend } from "../../src/mux/rex.ts";
import { REX_CAPTURE_MAX_BYTES } from "../../src/mux/rex-cli.ts";
import { registerSetTabTitleTool } from "../../src/tools/set-tab-title.ts";
import { writeExecutable } from "../support/index.ts";
import {
	armRexCreateFault,
	dropRexBlock,
	FAKE_REX,
	FAKE_REX_PARENT,
	FAKE_REX_SESSION,
	readRexBlocks,
	readRexCalls,
} from "./fake-rex.ts";

const ENV_KEYS = [
	"PATH",
	"PI_SUBAGENT_MUX",
	"PI_SUBAGENT_REX_PLACEMENT",
	"FAKE_TERMINAL_STATE",
	"FAKE_REX_REVISION",
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
	"WEZTERM_UNIX_SOCKET",
] as const;
const FAKE_TMUX = "#!/bin/sh\nexit 0\n";
const LABEL = /pi-subagent-[0-9a-f-]{36}/;

let root = "";
let binDir = "";
let stateDir = "";
let saved = new Map<string, string | undefined>();

/**
 * Registers the fake rex env and state around each test of the calling describe.
 * Not at module level: test/test.ts imports every suite into one process, so a module-level hook
 * would wrap every test of the run and leave REX_* and a fake rex on PATH for other backends' tests.
 */
function useFakeRex(): void {
	beforeEach(() => {
		saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
		for (const key of ENV_KEYS) if (key !== "PATH") delete process.env[key];
		root = mkdtempSync(join(tmpdir(), "rex-backend-"));
		binDir = join(root, "bin");
		stateDir = join(root, "state");
		mkdirSync(binDir);
		mkdirSync(stateDir);
		writeExecutable(binDir, "rex", FAKE_REX);
		// No host PATH: an installed rex would win over REX_BIN_DIR and get the real calls. The fakes need node.
		symlinkSync(process.execPath, join(binDir, "node"));
		process.env.PATH = `${binDir}:/usr/bin:/bin`;
		process.env.FAKE_TERMINAL_STATE = stateDir;
		process.env.REX_SESSION = FAKE_REX_SESSION;
		process.env.REX_BLOCK = FAKE_REX_PARENT;
	});

	afterEach(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
}

/** The calls after the first n, as "verb" strings plus their argv. */
const callsFrom = (n: number) => readRexCalls(stateDir).slice(n);
const verb = (call: string[]) =>
	["block", "window", "session"].includes(call[0]!) ? `${call[0]} ${call[1]}` : call[0]!;
const isCreate = (call: string[]) => verb(call) === "split" || verb(call) === "window new";
const flagValue = (call: string[], flag: string) => call[call.indexOf(flag) + 1];

describe("Rex detection (T48, D28, D29)", () => {
	useFakeRex();

	it("finds rex on PATH and accepts revision 16", () => {
		assert.equal(getMuxBackend(), "rex");
		assert.deepEqual(readRexCalls(stateDir)[0], ["whoami", "--json"]);
	});

	it("finds rex in REX_BIN_DIR when it is not on PATH", () => {
		const binOnly = join(root, "rex-bin");
		mkdirSync(binOnly);
		writeExecutable(binOnly, "rex", FAKE_REX);
		rmSync(join(binDir, "rex"));
		process.env.REX_BIN_DIR = binOnly;
		assert.equal(getMuxBackend(), "rex");
		assert.deepEqual(readRexCalls(stateDir)[0], ["whoami", "--json"], "the REX_BIN_DIR fake answered");
		delete process.env.REX_BIN_DIR;
		assert.equal(rexBackend.isAvailable(), false, "no rex on PATH and no REX_BIN_DIR");
	});

	for (const revision of ["13", "17"]) {
		it(`revision ${revision} makes the backend unavailable with the hint`, () => {
			process.env.FAKE_REX_REVISION = revision;
			assert.equal(rexBackend.isAvailable(), false);
			assert.equal(getMuxBackend(), null);
			assert.match(muxSetupHint(), new RegExp(`Rex API revision ${revision} is not supported.*revision 16`));
			process.env.PI_SUBAGENT_MUX = "rex";
			assert.equal(getMuxBackend(), null);
			assert.match(muxSetupHint(), new RegExp(`revision ${revision}`));
		});
	}

	it("comes before tmux in the detection order, and a forced available backend wins", () => {
		writeExecutable(binDir, "tmux", FAKE_TMUX);
		process.env.TMUX = "fake-tmux-socket";
		assert.equal(getMuxBackend(), "rex");
		process.env.PI_SUBAGENT_MUX = "tmux";
		assert.equal(getMuxBackend(), "tmux");
	});
});

describe("Rex launch (T48, D28)", () => {
	useFakeRex();

	it("split placement: splits right of the parent twice, then opens a window; every create names the parent's session", async () => {
		process.env.PI_SUBAGENT_REX_PLACEMENT = "split";
		const first = await rexBackend.createSurface("One");
		const second = await rexBackend.createSurface("Two");
		const third = await rexBackend.createSurface("Three");
		assert.equal(new Set([first, second, third]).size, 3);
		const creates = readRexCalls(stateDir).filter(isCreate);
		assert.deepEqual(creates.map(verb), ["split", "split", "window new"]);
		for (const call of creates) {
			assert.equal(flagValue(call, "-s"), FAKE_REX_SESSION);
			assert.ok(call.includes("--focus=false"));
		}
		for (const call of creates.slice(0, 2)) {
			assert.equal(flagValue(call, "-b"), FAKE_REX_PARENT);
			assert.equal(flagValue(call, "--split"), "right");
			assert.match(flagValue(call, "--label")!, LABEL);
		}
		assert.match(creates[2]![4]!, LABEL, "the window carries the launch label");
		const thirdBlock = readRexBlocks(stateDir).find((block) => block.block_id === third);
		assert.equal(thirdBlock?.label, "shell", "the window's one block is labeled shell");
	});

	it("sends the command as one line of text, then Enter as a key", async () => {
		const child = await rexBackend.createSurface("Child");
		const before = readRexCalls(stateDir).length;
		rexBackend.sendCommand(child, "echo launched");
		assert.deepEqual(callsFrom(before), [
			["send", "-s", FAKE_REX_SESSION, "-b", child, "echo launched"],
			["send-key", "-s", FAKE_REX_SESSION, "-b", child, "enter"],
		]);
		const afterSend = readRexCalls(stateDir).length;
		assert.throws(() => rexBackend.sendCommand(child, "echo one\necho two"), /one line/);
		assert.deepEqual(callsFrom(afterSend), [], "a multi-line command sends nothing");
	});
});

describe("Rex placement (T71, D28)", () => {
	useFakeRex();

	/** Each child is a new window of the parent's session, labeled with the launch label; no split, focus unchanged. */
	async function assertEveryChildInNewWindow(open: (name: string) => Promise<string>): Promise<void> {
		const children = [await open("One"), await open("Two"), await open("Three")];
		assert.equal(new Set(children).size, 3);
		const creates = readRexCalls(stateDir).filter(isCreate);
		assert.deepEqual(creates.map(verb), ["window new", "window new", "window new"]);
		for (const call of creates) {
			assert.deepEqual(call.slice(0, 4), ["window", "new", "-s", FAKE_REX_SESSION]);
			assert.match(call[4] ?? "", LABEL, "the window carries the launch label");
			assert.ok(call.includes("--focus=false"));
		}
		const own = readRexBlocks(stateDir).filter((block) => children.includes(block.block_id));
		const windows = new Set(own.map((block) => block.window_id));
		assert.equal(windows.size, 3, "each child has its own window");
	}

	it("unset: every child opens in its own new window of the parent's session", async () => {
		await assertEveryChildInNewWindow((name) => rexBackend.createSurface(name));
	});

	it("window: every child opens in its own new window", async () => {
		process.env.PI_SUBAGENT_REX_PLACEMENT = "window";
		await assertEveryChildInNewWindow((name) => rexBackend.createSurface(name));
	});

	it("the placement in the create options wins over the parent env", async () => {
		process.env.PI_SUBAGENT_REX_PLACEMENT = "split";
		await assertEveryChildInNewWindow((name) => rexBackend.createSurface(name, { rex: { policy: "window" } }));
	});

	it("split in the create options keeps the D28 split rule over a window parent env", async () => {
		process.env.PI_SUBAGENT_REX_PLACEMENT = "window";
		for (const name of ["One", "Two", "Three"]) await rexBackend.createSurface(name, { rex: { policy: "split" } });
		assert.deepEqual(readRexCalls(stateDir).filter(isCreate).map(verb), ["split", "split", "window new"]);
	});

	it("an unknown value in the create options fails before any create", async () => {
		const policy = "tab" as unknown as "window";
		await assert.rejects(
			rexBackend.createSurface("Bad", { rex: { policy } }),
			/Invalid PI_SUBAGENT_REX_PLACEMENT value "tab"/,
		);
		assert.ok(!readRexCalls(stateDir).some(isCreate), "no create after an unknown value");
	});

	it("an unknown value fails before any create and names the variable", async () => {
		process.env.PI_SUBAGENT_REX_PLACEMENT = "tab";
		await assert.rejects(rexBackend.createSurface("Bad"), /Invalid PI_SUBAGENT_REX_PLACEMENT value "tab"/);
		assert.ok(!readRexCalls(stateDir).some(isCreate), "no create after an unknown value");
	});

	it("resolves values like the Herdr variable: trimmed, case-insensitive, empty is the default", () => {
		assert.equal(resolveRexPlacementPolicy(undefined), "window");
		assert.equal(resolveRexPlacementPolicy(""), "window");
		assert.equal(resolveRexPlacementPolicy(" Split "), "split");
		assert.equal(resolveRexPlacementPolicy("WINDOW"), "window");
		assert.throws(() => resolveRexPlacementPolicy("right"), /Expected window or split/);
	});
});

describe("Rex lost create (T48, D28)", () => {
	useFakeRex();
	beforeEach(() => {
		process.env.PI_SUBAGENT_REX_PLACEMENT = "split";
	});

	it("a split with a request timeout uses the one block with its label; no second create", async () => {
		armRexCreateFault(stateDir, { command: "split", kind: "request-timeout", creates: 1 });
		const before = readRexCalls(stateDir).length;
		const child = await rexBackend.createSurface("Lost");
		const calls = callsFrom(before);
		assert.deepEqual(calls.map(verb), ["block ls", "split", "block ls"]);
		const label = flagValue(calls[1]!, "--label");
		const labeled = readRexBlocks(stateDir).filter((block) => block.label === label);
		assert.deepEqual(
			labeled.map((block) => block.block_id),
			[child],
		);
	});

	for (const creates of [0, 2]) {
		it(`a split with a request timeout and ${creates} labeled blocks fails with the label; nothing is sent, closed or created`, async () => {
			armRexCreateFault(stateDir, { command: "split", kind: "request-timeout", creates });
			const before = readRexCalls(stateDir).length;
			const error = await rexBackend.createSurface("Lost").then(
				() => assert.fail("the launch must fail"),
				(reason: Error) => reason,
			);
			const calls = callsFrom(before);
			assert.deepEqual(calls.map(verb), ["block ls", "split", "block ls"]);
			const label = flagValue(calls[1]!, "--label")!;
			assert.ok(error.message.includes(label), error.message);
			assert.equal(readRexBlocks(stateDir).filter((block) => block.label === label).length, creates);
		});
	}

	it("a connect timeout is not looked up", async () => {
		armRexCreateFault(stateDir, { command: "split", kind: "connect-timeout", creates: 0 });
		const before = readRexCalls(stateDir).length;
		await assert.rejects(rexBackend.createSurface("Lost"), /connecting to the server timed out/);
		assert.deepEqual(callsFrom(before).map(verb), ["block ls", "split"]);
	});

	async function fillParentWindow(): Promise<void> {
		await rexBackend.createSurface("Split One");
		await rexBackend.createSurface("Split Two");
	}

	it("a dropped window reply uses the one window with the label and its one block", async () => {
		await fillParentWindow();
		armRexCreateFault(stateDir, { command: "window", kind: "dropped", creates: 1 });
		const before = readRexCalls(stateDir).length;
		const child = await rexBackend.createSurface("Window");
		assert.deepEqual(callsFrom(before).map(verb), ["block ls", "window new", "session inspect"]);
		const block = readRexBlocks(stateDir).find((entry) => entry.block_id === child);
		assert.equal(block?.label, "shell");
	});

	for (const creates of [0, 2]) {
		it(`a dropped window reply with ${creates} labeled windows fails with the label; nothing is sent, closed or created`, async () => {
			await fillParentWindow();
			armRexCreateFault(stateDir, { command: "window", kind: "dropped", creates });
			const before = readRexCalls(stateDir).length;
			const error = await rexBackend.createSurface("Window").then(
				() => assert.fail("the launch must fail"),
				(reason: Error) => reason,
			);
			const calls = callsFrom(before);
			assert.deepEqual(calls.map(verb), ["block ls", "window new", "session inspect"]);
			assert.ok(error.message.includes(calls[1]![4]!), error.message);
		});
	}
});

describe("Rex title (D10)", () => {
	useFakeRex();

	it("set_tab_title reports unavailable, as on cf6dbf4 where no backend served a Rex session", async () => {
		const saved = process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
		process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = "1";
		try {
			let tool: { execute(id: string, params: { title: string }): Promise<unknown> } | undefined;
			registerSetTabTitleTool({
				registerTool: (definition: typeof tool) => {
					tool = definition;
				},
			} as never);
			assert.ok(tool, "the opt-in registers set_tab_title");
			const before = readRexCalls(stateDir).length;
			const result = (await tool.execute("call", { title: "Phase 2" })) as {
				content: { text: string }[];
				details: { error?: string; title?: string };
			};
			// cf6dbf4 (src/tools/set-tab-title.ts): text "Terminal multiplexer not available. <hint>", details.error "mux not available".
			const text = result.content[0]?.text ?? "";
			assert.match(text, /^Terminal multiplexer not available\./);
			assert.doesNotMatch(text, /Title set to/);
			assert.deepEqual(result.details, { error: "mux not available" });
			assert.ok(
				callsFrom(before).every((call) => verb(call) === "whoami"),
				"no rename call reaches rex",
			);
		} finally {
			if (saved === undefined) delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
			else process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = saved;
		}
	});
});

describe("Rex parent block (T48, D28)", () => {
	useFakeRex();

	/** No call other than a block list names the parent's block, except as the anchor of a create on a live parent. */
	function assertParentUntouched(from: number): void {
		for (const call of callsFrom(from)) {
			if (verb(call) === "block ls" || verb(call) === "whoami") continue;
			assert.ok(!call.includes(FAKE_REX_PARENT), `a call targets the parent block: ${call.join(" ")}`);
		}
	}

	it("never sends to, captures or closes the parent's own block", async () => {
		const before = readRexCalls(stateDir).length;
		assert.throws(() => rexBackend.sendCommand(FAKE_REX_PARENT, "echo no"), /parent's own Rex block/);
		assert.throws(() => rexBackend.readScreen(FAKE_REX_PARENT, 5), /parent's own Rex block/);
		await assert.rejects(rexBackend.readScreenAsync(FAKE_REX_PARENT, 5), /parent's own Rex block/);
		await assert.rejects(async () => rexBackend.closeSurface(FAKE_REX_PARENT), /parent's own Rex block/);
		assert.equal(rexBackend.renameCurrentTab, undefined);
		assert.equal(rexBackend.renameWorkspace, undefined);
		assert.deepEqual(callsFrom(before), []);
	});

	it("a stale parent: no create, send or close targets it", async () => {
		dropRexBlock(stateDir, FAKE_REX_PARENT);
		const before = readRexCalls(stateDir).length;
		await assert.rejects(rexBackend.createSurface("Stale"), /no longer exists/);
		assert.throws(() => rexBackend.createSplit("Stale", "right"), /no longer exists/);
		assert.throws(() => rexBackend.sendCommand(FAKE_REX_PARENT, "echo no"), /parent's own Rex block/);
		await assert.rejects(async () => rexBackend.closeSurface(FAKE_REX_PARENT), /parent's own Rex block/);
		assert.ok(!callsFrom(before).some(isCreate), "no create after a stale parent");
		assertParentUntouched(before);
	});
});

describe("Rex capture cap (T48, D28)", () => {
	useFakeRex();

	it("cuts a capture over 256 KB to the last lines, from a whole line, on both paths", async () => {
		const child = await rexBackend.createSurface("Long");
		const lines = Array.from({ length: 40_000 }, (_, index) => `line ${index} ${"x".repeat(20)}`);
		const text = `${lines.join("\n")}\n`;
		assert.ok(Buffer.byteLength(text) > 4 * REX_CAPTURE_MAX_BYTES);
		writeFileSync(join(stateDir, `screen-${child}`), text);
		const lastThree = `${lines.slice(-2).join("\n")}\n`;
		assert.equal(rexBackend.readScreen(child, 3), lastThree);
		assert.equal(await rexBackend.readScreenAsync(child, 3), lastThree);
		for (const all of [rexBackend.readScreen(child, 1e6), await rexBackend.readScreenAsync(child, 1e6)]) {
			assert.ok(Buffer.byteLength(all) <= REX_CAPTURE_MAX_BYTES, `${Buffer.byteLength(all)} bytes`);
			assert.ok(text.endsWith(all), "the capture is a tail of the scrollback");
			assert.match(all, /^line \d+ x{20}\n/, "the capture starts at a whole line");
		}
	});
});
