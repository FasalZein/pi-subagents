import { randomUUID } from "node:crypto";
import { REX_PANE_IDENTITY } from "../launch/child-env.ts";
import type { MuxBackendAdapter, SurfaceSplitDirection } from "./backend.ts";
import { tailLines } from "./core.ts";
import { createOscWorkReporter } from "./osc-work-record.ts";
import {
	RexCallError,
	resolveRexBinary,
	rexAsync,
	rexCaptureAsync,
	rexCaptureSync,
	rexRevisionAccepted,
	rexRevisionAcceptedAsync,
	rexRevisionHint,
	rexSync,
} from "./rex-cli.ts";

/** Prefix of the label that each child create carries; the rest is unique to the launch (D28). */
const LABEL_PREFIX = "pi-subagent-";
/** Where a new child opens (D28, T71): its own new window (default), or the split rule below. */
export type RexPlacementPolicy = "window" | "split";

export interface RexPlacementContext {
	policy?: RexPlacementPolicy;
}

/** Same rule as PI_SUBAGENT_HERDR_PLACEMENT: trimmed, case-insensitive, empty means the default, else an error. */
export function resolveRexPlacementPolicy(value = process.env.PI_SUBAGENT_REX_PLACEMENT): RexPlacementPolicy {
	const policy = value?.trim().toLowerCase() || "window";
	if (policy === "window" || policy === "split") return policy;
	throw new Error(`Invalid PI_SUBAGENT_REX_PLACEMENT value "${value}". Expected window or split.`);
}

/** With the split policy: child splits beside the parent per window; later children open in a new window (D28). */
const SPLITS_PER_WINDOW = 2;
/** rex split --split values; right and below are the live-checked ones. */
const SPLIT_SIDE: Record<SurfaceSplitDirection, string> = { right: "right", down: "below", left: "left", up: "above" };

interface RexBlock {
	block_id: string;
	label?: string;
	window_id?: string;
}

interface RexWindow {
	label?: string;
	layers?: { blocks?: { block_id: string }[] }[];
}

function parentSession(): string {
	const session = process.env.REX_SESSION;
	if (!session) throw new Error("REX_SESSION not set");
	return session;
}

function parentBlock(): string {
	const block = process.env.REX_BLOCK;
	if (!block) throw new Error("REX_BLOCK not set");
	return block;
}

/** A child block; no send, capture or close ever targets the parent's own block (D28). */
function childBlock(surface: string): string {
	if (surface === process.env.REX_BLOCK) throw new Error(`refusing to target the parent's own Rex block ${surface}`);
	return surface;
}

function listBlocks(session: string): RexBlock[] {
	return (JSON.parse(rexSync(["block", "ls", "-s", session, "--json"])) as { blocks?: RexBlock[] }).blocks ?? [];
}

/** The parent's block in its session; a stale parent fails before any create (D28). */
function liveParent(session: string, blocks: RexBlock[] = listBlocks(session)): RexBlock {
	const parent = blocks.find((block) => block.block_id === parentBlock());
	if (!parent)
		throw new Error(`the parent's Rex block ${parentBlock()} no longer exists in ${session}; no child was opened`);
	return parent;
}

type ChildCreate = { kind: "split"; anchor: string; side: string } | { kind: "window" };

function createArgs(create: ChildCreate, session: string, label: string): string[] {
	if (create.kind === "split") {
		return [
			"split",
			"-s",
			session,
			"-b",
			create.anchor,
			"--split",
			create.side,
			"--focus=false",
			"--label",
			label,
			"--json",
		];
	}
	return ["window", "new", "-s", session, label, "--focus=false", "--json"];
}

/** A request timeout can leave a live block; a connect timeout creates nothing (live check 13). */
function isRequestTimeout(error: unknown): boolean {
	return (
		error instanceof RexCallError &&
		!/connecting to the server timed out/.test(error.stderr) &&
		/request timed out/.test(error.stderr)
	);
}

/** Blocks that carry the label: for a split the block's own label; for a window its label and its blocks. */
function blocksWithLabel(create: ChildCreate, session: string, label: string): { found: number; blocks: string[] } {
	if (create.kind === "split") {
		const blocks = listBlocks(session)
			.filter((block) => block.label === label)
			.map((block) => block.block_id);
		return { found: blocks.length, blocks };
	}
	const inspect = JSON.parse(rexSync(["session", "inspect", session, "--json"])) as { windows?: RexWindow[] };
	const windows = (inspect.windows ?? []).filter((window) => window.label === label);
	if (windows.length !== 1) return { found: windows.length, blocks: [] };
	const blocks = (windows[0]!.layers ?? []).flatMap((layer) => (layer.blocks ?? []).map((block) => block.block_id));
	return { found: blocks.length, blocks };
}

/**
 * One create, never retried (C5). When its reply is lost (request timeout, or no block id in the reply),
 * the label is looked up once in the parent's session; exactly one match is used, otherwise the launch
 * fails and names the label, and nothing is sent, closed or created.
 */
function createChild(create: ChildCreate): string {
	const session = parentSession();
	const label = `${LABEL_PREFIX}${randomUUID()}`;
	let reply: string;
	try {
		reply = rexSync(createArgs(create, session, label));
	} catch (error) {
		if (!isRequestTimeout(error)) throw error;
		reply = "";
	}
	let created: string | undefined;
	try {
		created = (JSON.parse(reply) as { block_ids?: string[] }).block_ids?.[0];
	} catch {
		created = undefined;
	}
	if (created) return created;
	const { found, blocks } = blocksWithLabel(create, session, label);
	if (blocks.length === 1 && found === 1) return blocks[0]!;
	const what = create.kind === "split" ? "blocks" : "windows or blocks";
	throw new Error(
		`Rex ${create.kind} create got no reply; ${found} ${what} carry the label ${label} in ${session}, so the launch fails without a retry`,
	);
}

function captureArgs(surface: string): string[] {
	return ["capture", "-s", parentSession(), "-b", childBlock(surface), "--trim", "--unwrap"];
}

/** The launch check of isAvailable, asynchronous, so the status reporter follows the launch decision (D29, D30). */
async function rexUsable(): Promise<boolean> {
	if (!process.env.REX_SESSION || !process.env.REX_BLOCK) return false;
	const binary = resolveRexBinary();
	return binary !== undefined && (await rexRevisionAcceptedAsync(binary));
}

/** Rex (the rex CLI inside a Rex block), revision 16 (D28). */
export const rexBackend: MuxBackendAdapter = {
	id: "rex",
	isAvailable: () => {
		if (!process.env.REX_SESSION || !process.env.REX_BLOCK) return false;
		const binary = resolveRexBinary();
		return binary !== undefined && rexRevisionAccepted(binary);
	},
	setupHint: () =>
		rexRevisionHint() ?? "Start pi in a Rex block (REX_SESSION and REX_BLOCK set), with rex on PATH or in REX_BIN_DIR.",
	// window (default): a new window per child. split: a split right of the parent while its window holds
	// fewer than SPLITS_PER_WINDOW children, else a new window.
	createSurface: async (_name, options) => {
		const policy = resolveRexPlacementPolicy(options?.rex?.policy ?? process.env.PI_SUBAGENT_REX_PLACEMENT);
		const session = parentSession();
		const blocks = listBlocks(session);
		const parent = liveParent(session, blocks);
		if (policy === "window") return createChild({ kind: "window" });
		const splits = blocks.filter(
			(block) => block.window_id === parent.window_id && block.label?.startsWith(LABEL_PREFIX),
		).length;
		return createChild(
			splits < SPLITS_PER_WINDOW ? { kind: "split", anchor: parent.block_id, side: "right" } : { kind: "window" },
		);
	},
	resolveRexPlacementPolicy: (value) => resolveRexPlacementPolicy(value),
	createSplit: (_name, direction, fromSurface) => {
		const anchor = fromSurface ?? liveParent(parentSession()).block_id;
		return createChild({ kind: "split", anchor, side: SPLIT_SIDE[direction] });
	},
	// One line of text, then Enter as a key (D28); an empty command presses Enter only.
	sendCommand: (surface, command) => {
		const block = childBlock(surface);
		if (/[\r\n]/.test(command)) throw new Error("Rex sends one line of text; the command has a line break");
		if (command) rexSync(["send", "-s", parentSession(), "-b", block, command]);
		rexSync(["send-key", "-s", parentSession(), "-b", block, "enter"]);
	},
	readScreen: (surface, lines) => tailLines(rexCaptureSync(captureArgs(surface)), lines),
	readScreenAsync: async (surface, lines) => tailLines(await rexCaptureAsync(captureArgs(surface)), lines),
	closeSurface: async (surface) => {
		await rexAsync(["block", "close", "-s", parentSession(), childBlock(surface)]);
	},
	// No rename ability: both would act on the parent's block or session, which no call targets (D28, T48),
	// so set_tab_title reports unavailable rather than a title it did not set (D10).
	paneIdentity: REX_PANE_IDENTITY,
	connectWorkReporter: (session) => createOscWorkReporter(session, "rex", rexUsable),
};
