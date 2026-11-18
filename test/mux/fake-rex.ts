import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_TERMINAL_STATE_JS } from "./fake-terminal-state.ts";

/** The parent's Rex session and block in the fake (full prefixed ids, live check 5). */
export const FAKE_REX_SESSION = "session:01a1ee5a-f74b-7d23-9e37-4758ac006ffa";
export const FAKE_REX_PARENT = "block:01a1ee5a-f74c-7061-ad88-ff95d44ed323";

/**
 * Stateful fake rex. It replays only the shapes of the 2026-11-18 live checks
 * (live-rex-pane-checks.md, "Shapes for fakes", revision 16) for the subcommands that src/mux/rex*.ts sends,
 * and rejects any flag or value that those shapes do not show.
 * State in $FAKE_TERMINAL_STATE: rex-blocks.json and rex-windows.json (one session: the env's REX_SESSION,
 * first holding the env's REX_BLOCK), screen/pending/submitted files per block id (fake-terminal-state.ts),
 * rex-calls (one JSON argv per line). rex-fault (JSON, used once): {"command":"split"|"window",
 * "kind":"request-timeout"|"connect-timeout"|"dropped","creates":0|1|2} makes the next such create fail
 * as recorded in live check 13 after it created that many blocks with the label.
 * FAKE_REX_REVISION sets the api_revision of whoami (default 16). Every call is also logged to $FAKE_MUX_LOG.
 */
export const FAKE_REX = `#!/usr/bin/env node
${FAKE_TERMINAL_STATE_JS}
const args = process.argv.slice(2);
fs.appendFileSync(path.join(S, "rex-calls"), JSON.stringify(args) + "\\n");
if (process.env.FAKE_MUX_LOG) fs.appendFileSync(process.env.FAKE_MUX_LOG, "rex " + args.join(" ") + "\\n");
const SESSION = process.env.REX_SESSION;
const read = (name, init) => { const p = path.join(S, name); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : init(); };
const write = (name, value) => fs.writeFileSync(path.join(S, name), JSON.stringify(value));
let n = read("rex-seq", () => 1);
const uuid = () => { n += 1; write("rex-seq", n); return "01a1ee5b-1f99-7a29-88d3-" + String(n).padStart(12, "0"); };
const blockEntry = (id, label, windowId) => ({ block_id: id, label, creator_name: "com.superlogical.terminal",
  flavor: "com.superlogical.terminal.shell", host_id: "01a1ee5a-0000-7000-8000-000000000001", placement: "placed",
  window_id: windowId, owner: "client:01a1ee5a-0000-7000-8000-000000000002" });
const PARENT_WINDOW = "window:01a1ee5a-f771-7000-8000-000000000001";
const blocks = read("rex-blocks.json", () => [blockEntry(process.env.REX_BLOCK, "shell", PARENT_WINDOW)]);
const windows = read("rex-windows.json", () => [{ window_id: PARENT_WINDOW, label: "Window e2f635e3" }]);
const save = () => { write("rex-blocks.json", blocks); write("rex-windows.json", windows); };
function parse(list, values, bools) {
  const opts = {}, pos = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith("-")) { pos.push(a); continue; }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    if (values.includes(name)) opts[name] = eq === -1 ? list[++i] : a.slice(eq + 1);
    else if (bools.includes(name)) opts[name] = eq === -1 ? "true" : a.slice(eq + 1);
    else fail("Error: unknown flag: " + name);
  }
  return { opts, pos };
}
function requireSession(s) { if (s !== SESSION) fail("Error: session not found: " + s); }
function requireBlock(id) { if (!blocks.some((b) => b.block_id === id)) fail("Error: block not found: " + id); }
function addBlock(label, windowId) {
  const id = "block:" + uuid();
  blocks.push(blockEntry(id, label, windowId));
  for (const kind of ["screen", "pending", "submitted"]) fs.writeFileSync(file(kind, id), "");
  return id;
}
function takeFault(command) {
  const p = path.join(S, "rex-fault");
  if (!fs.existsSync(p)) return undefined;
  const fault = JSON.parse(fs.readFileSync(p, "utf8"));
  if (fault.command !== command) return undefined;
  fs.rmSync(p);
  return fault;
}
function failCreate(fault, method) {
  save();
  if (fault.kind === "dropped") process.exit(0);
  if (fault.kind === "connect-timeout") fail("Error: connecting to the server timed out after 1ns; increase --timeout: context deadline exceeded");
  fail("Error: " + method + " request timed out after 1ms; increase --timeout: context deadline exceeded");
}
const out = (value) => console.log(JSON.stringify(value));
const cmd = args[0] === "block" || args[0] === "window" || args[0] === "session" ? args[0] + " " + args[1] : args[0];
const rest = args.slice(cmd.includes(" ") ? 2 : 1);
switch (cmd) {
  case "whoami": {
    parse(rest, [], ["--json"]);
    out({ rex_version: "0.1.0-preview.20", api_revision: Number(process.env.FAKE_REX_REVISION || 16), exit_empty: false, session_count: 1 });
    break;
  }
  case "block ls": {
    const { opts } = parse(rest, ["-s"], ["--json"]);
    requireSession(opts["-s"]);
    out({ blocks });
    break;
  }
  case "block close": {
    const { opts, pos } = parse(rest, ["-s"], []);
    requireSession(opts["-s"]);
    for (const id of pos) {
      requireBlock(id);
      blocks.splice(blocks.findIndex((b) => b.block_id === id), 1);
      closeSurface(id);
    }
    for (let i = windows.length - 1; i >= 0; i--) if (!blocks.some((b) => b.window_id === windows[i].window_id)) windows.splice(i, 1);
    save();
    break;
  }
  case "split": {
    const { opts } = parse(rest, ["-s", "-b", "--split", "--label"], ["--json", "--focus"]);
    requireSession(opts["-s"]);
    requireBlock(opts["-b"]);
    if (!["right", "below", "left", "above"].includes(opts["--split"])) fail("Error: invalid --split: " + opts["--split"]);
    if (opts["--focus"] !== "false") fail("fake rex: a create must pass --focus=false");
    const windowId = blocks.find((b) => b.block_id === opts["-b"]).window_id;
    const fault = takeFault("split");
    if (fault) { for (let i = 0; i < fault.creates; i++) addBlock(opts["--label"], windowId); failCreate(fault, "session.new_split"); }
    const id = addBlock(opts["--label"], windowId);
    save();
    out({ anchor_id: opts["-b"], block_ids: [id], split_ids: ["split:" + uuid()], revision: n });
    break;
  }
  case "window new": {
    const { opts, pos } = parse(rest, ["-s"], ["--json", "--focus"]);
    requireSession(opts["-s"]);
    if (opts["--focus"] !== "false") fail("fake rex: a create must pass --focus=false");
    if (pos.length !== 1) fail("fake rex: window new takes one LABEL");
    const create = () => { const windowId = "window:" + uuid(); windows.push({ window_id: windowId, label: pos[0] }); return { windowId, id: addBlock("shell", windowId) }; };
    const fault = takeFault("window");
    if (fault) { for (let i = 0; i < fault.creates; i++) create(); failCreate(fault, "session.new_window"); }
    const { windowId, id } = create();
    save();
    out({ window_id: windowId, block_ids: [id], revision: n });
    break;
  }
  case "session inspect": {
    const { pos } = parse(rest, [], ["--json"]);
    requireSession(pos[0]);
    const view = (b) => { const { placement, window_id, ...rest } = b; return rest; };
    out({ revision: n, session_id: SESSION, label: "probe-t60", active_window_id: windows[0]?.window_id,
      windows: windows.map((w) => {
        const own = blocks.filter((b) => b.window_id === w.window_id);
        return { window_id: w.window_id, label: w.label, focused_block_id: own[0]?.block_id,
          layers: [{ layer_id: "layer:" + w.window_id.slice(7), kind: "tiled", bounds: [0, 0, 1, 1],
            layout: { rect: [0, 0, 1, 1], block_id: own[0]?.block_id }, blocks: own.map(view) }] };
      }), clients: [] });
    break;
  }
  case "send": {
    const { opts, pos } = parse(rest, ["-s", "-b"], []);
    requireSession(opts["-s"]);
    requireBlock(opts["-b"]);
    if (pos.length !== 1) fail("fake rex: send takes one TEXT");
    typeText(opts["-b"], pos[0]);
    break;
  }
  case "send-key": {
    const { opts, pos } = parse(rest, ["-s", "-b"], []);
    requireSession(opts["-s"]);
    requireBlock(opts["-b"]);
    if (pos.length !== 1 || pos[0] !== "enter") fail("fake rex: send-key takes the key enter");
    typeText(opts["-b"], "\\n");
    break;
  }
  case "capture": {
    const { opts } = parse(rest, ["-s", "-b"], ["--trim", "--unwrap"]);
    requireSession(opts["-s"]);
    requireBlock(opts["-b"]);
    process.stdout.write(screen(opts["-b"]));
    break;
  }
  default:
    fail("fake rex: unsupported " + args.join(" "));
}
`;

/** The argv of every rex call that the fake saw, in order. */
export function readRexCalls(stateDir: string): string[][] {
	const path = join(stateDir, "rex-calls");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as string[]);
}

/** Arms the next create of one kind to fail as live check 13 recorded, after it created `creates` labeled blocks. */
export function armRexCreateFault(
	stateDir: string,
	fault: { command: "split" | "window"; kind: "request-timeout" | "connect-timeout" | "dropped"; creates: number },
): void {
	writeFileSync(join(stateDir, "rex-fault"), JSON.stringify(fault));
}

/** The fake's blocks, as rex block ls --json shows them. */
export function readRexBlocks(stateDir: string): { block_id: string; label: string; window_id: string }[] {
	const path = join(stateDir, "rex-blocks.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
}

/** Removes a block from the fake without a close call: the parent block that the operator closed. */
export function dropRexBlock(stateDir: string, blockId: string): void {
	const path = join(stateDir, "rex-blocks.json");
	const blocks = existsSync(path)
		? (JSON.parse(readFileSync(path, "utf8")) as { block_id: string }[])
		: [{ block_id: blockId }];
	writeFileSync(path, JSON.stringify(blocks.filter((block) => block.block_id !== blockId)));
}
