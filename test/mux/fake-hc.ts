import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_TERMINAL_STATE_JS } from "./fake-terminal-state.ts";

/** The caller terminal of the parent Pi in the fake. */
export const FAKE_HC_CALLER = "t1";

/**
 * Stateful fake hc. It replays the shapes of the 2026-11-18 live checks
 * (live-hc-window-checks.md, "Shapes for fakes") for the subcommands that src/mux/herdr-core*.ts sends.
 * State in $FAKE_TERMINAL_STATE: term-<address>.json per terminal, events (one JSON object per
 * line: labels and the event line), calls (one line per hc call), requests (JSON-RPC requests).
 * "hc events" drops its stream when the file drop exists. Every call is also logged to $FAKE_MUX_LOG.
 */
export const FAKE_HC = `#!/usr/bin/env node
${FAKE_TERMINAL_STATE_JS}
const args = process.argv.slice(2);
fs.appendFileSync(path.join(S, "calls"), args.join(" ") + "\\n");
if (process.env.FAKE_MUX_LOG) fs.appendFileSync(process.env.FAKE_MUX_LOG, "hc " + args.join(" ") + "\\n");
const termFile = (address) => path.join(S, "term-" + address + ".json");
function terminal(address) {
  if (!fs.existsSync(termFile(address))) fail(JSON.stringify({ error: "no terminal " + JSON.stringify(address) }));
  return JSON.parse(fs.readFileSync(termFile(address), "utf8"));
}
function seq() {
  const counter = path.join(S, "seq");
  const value = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) + 1 : 220;
  fs.writeFileSync(counter, String(value));
  return value;
}
function emit(term, type, data) {
  const line = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { data, seq: seq(), terminal: term.address, type } });
  fs.appendFileSync(path.join(S, "events"), JSON.stringify({ labels: term.labels, line }) + "\\n");
}
function newTerminal(fields) {
  const counter = path.join(S, "next-terminal");
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 2;
  fs.writeFileSync(counter, String(n + 1));
  const address = "t" + n;
  for (const kind of ["screen", "pending", "submitted"]) fs.writeFileSync(file(kind, address), "");
  const term = { address, argv: [], cols: 200, created_ms: Date.now(), cwd: "/tmp", die_with_parent: false, exit_code: null,
    finished_ms: null, identity: "ghostty", keep: false, labels: {}, name: "", notify: true, parent: null, pid: 4242,
    reason: null, reported: false, rm: false, rows: 120, screen: "exact", signal: null, state: "live", status: null,
    status_ms: null, template: null, title: "", turn: 0, ...fields };
  fs.writeFileSync(termFile(address), JSON.stringify(term));
  emit(term, "created", term);
  return term;
}
function labelMatches(labels, filter) {
  const [key, ...rest] = filter.split("=");
  return (labels || {})[key] === rest.join("=");
}
function short(term) {
  return JSON.stringify({ address: term.address, agent: "sh", cwd: term.cwd, name: term.name, state: term.state, turn: 0 });
}
function flag(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
switch (args[0]) {
  case "events": {
    const filter = flag("--label");
    const matching = fs.readdirSync(S).filter((n) => n.startsWith("term-")).map((n) => JSON.parse(fs.readFileSync(path.join(S, n), "utf8")))
      .filter((t) => labelMatches(t.labels, filter));
    const eventsFile = path.join(S, "events");
    let offset = fs.existsSync(eventsFile) ? fs.statSync(eventsFile).size : 0;
    console.log(JSON.stringify({ channel: null, seq: 220, terminals: matching }));
    const timer = setInterval(() => {
      if (!fs.existsSync(S)) process.exit(0);
      const dropFile = path.join(S, "drop");
      if (fs.existsSync(dropFile)) { fs.rmSync(dropFile); process.exit(0); }
      // An armed race: the child writes its exit file and its terminal finishes while the watch listens.
      const vanish = path.join(S, "vanish-on-query");
      if (fs.existsSync(vanish)) {
        const armed = JSON.parse(fs.readFileSync(vanish, "utf8"));
        fs.rmSync(vanish);
        fs.writeFileSync(armed.path, armed.content);
        const term = terminal(armed.address);
        Object.assign(term, { state: "finished", exit_code: 1, reason: "exited", signal: null, finished_ms: Date.now() });
        fs.writeFileSync(termFile(term.address), JSON.stringify(term));
        emit(term, "finished", { exit_code: 1, finished_ms: term.finished_ms, reason: "exited", signal: null });
      }
      if (!fs.existsSync(eventsFile)) return;
      const text = fs.readFileSync(eventsFile, "utf8");
      const fresh = text.slice(offset);
      const end = fresh.lastIndexOf("\\n");
      if (end === -1) return;
      offset += end + 1;
      for (const raw of fresh.slice(0, end).split("\\n")) {
        const entry = JSON.parse(raw);
        if (labelMatches(entry.labels, filter)) console.log(entry.line);
      }
    }, 20);
    break;
  }
  case "connect": {
    let input = "";
    process.stdin.on("data", (chunk) => {
      input += chunk;
      const end = input.indexOf("\\n");
      if (end === -1) return;
      const request = JSON.parse(input.slice(0, end));
      fs.appendFileSync(path.join(S, "requests"), JSON.stringify(request) + "\\n");
      if (process.env.FAKE_MUX_LOG) fs.appendFileSync(process.env.FAKE_MUX_LOG, JSON.stringify(request) + "\\n");
      if (request.method !== "terminal.run") fail("fake hc: unsupported method " + request.method);
      const p = request.params;
      terminal(p.caller);
      const term = newTerminal({ argv: p.argv, cwd: p.cwd || "/tmp", labels: p.labels || {}, name: p.name, notify: !p.no_notify, parent: p.caller });
      fs.writeFileSync(file("program", term.address), JSON.stringify(p.argv));
      console.log(JSON.stringify({ id: request.id, jsonrpc: "2.0", result: term }));
      process.exit(0);
    });
    break;
  }
  case "run": {
    const separator = args.indexOf("--");
    terminal(flag("--parent"));
    const term = newTerminal({ argv: args.slice(separator + 1), cwd: flag("--cwd") || "/tmp", name: flag("--name"),
      notify: !args.includes("--no-notify"), parent: flag("--parent") });
    console.log(short(term));
    break;
  }
  case "send":
    typeText(args[1], args[2] + "\\n");
    console.log(JSON.stringify({ started: true, status: null, turn: 0 }));
    break;
  case "read":
    process.stdout.write(screen(args[1]));
    break;
  case "get":
    console.log(JSON.stringify(terminal(args[1])));
    break;
  case "kill": {
    const term = terminal(args[1]);
    if (term.state !== "finished") {
      Object.assign(term, { state: "finished", exit_code: 1, reason: "killed", signal: null, finished_ms: Date.now() });
      fs.writeFileSync(termFile(term.address), JSON.stringify(term));
      emit(term, "finished", { exit_code: 1, finished_ms: term.finished_ms, reason: "killed", signal: null });
    }
    break;
  }
  case "rm": {
    const term = terminal(args[1]);
    if (term.state !== "finished") fail(JSON.stringify({ error: "terminal is live" }));
    closeSurface(term.address);
    fs.rmSync(termFile(term.address));
    break;
  }
  case "label": {
    const term = terminal(args[1]);
    const [key, ...rest] = args[2].split("=");
    term.labels[key] = rest.join("=");
    fs.writeFileSync(termFile(term.address), JSON.stringify(term));
    if (term.address === "${FAKE_HC_CALLER}" && key === "pi-subagents.title") recordTitle(rest.join("="));
    console.log(JSON.stringify(term));
    break;
  }
  default:
    fail("fake hc: unsupported " + args.join(" "));
}
`;

/** Seeds the caller terminal of the parent Pi. */
export function seedFakeHcCaller(stateDir: string): void {
	for (const kind of ["screen", "pending", "submitted"]) writeFileSync(join(stateDir, `${kind}-${FAKE_HC_CALLER}`), "");
	writeFileSync(
		join(stateDir, `term-${FAKE_HC_CALLER}.json`),
		JSON.stringify({ address: FAKE_HC_CALLER, labels: {}, state: "live", exit_code: null, signal: null, reason: null }),
	);
}

/** Ends a terminal with an exit code, as the launcher's exit would. emitEvent false loses the finished event. */
export function finishFakeTerminal(stateDir: string, address: string, exitCode: number, emitEvent = true): void {
	const path = join(stateDir, `term-${address}.json`);
	const term = JSON.parse(readFileSync(path, "utf8"));
	Object.assign(term, {
		state: "finished",
		exit_code: exitCode,
		reason: "exited",
		signal: null,
		finished_ms: Date.now(),
	});
	writeFileSync(path, JSON.stringify(term));
	if (!emitEvent) return;
	const data = { exit_code: exitCode, finished_ms: term.finished_ms, reason: "exited", signal: null };
	const line = JSON.stringify({
		jsonrpc: "2.0",
		method: "event",
		params: { data, seq: 900, terminal: address, type: "finished" },
	});
	appendFileSync(join(stateDir, "events"), `${JSON.stringify({ labels: term.labels, line })}\n`);
}

export function readFakeHcCalls(stateDir: string): string[] {
	const path = join(stateDir, "calls");
	return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

export function readFakeHcRequests(stateDir: string): Array<{ method: string; params: Record<string, unknown> }> {
	const path = join(stateDir, "requests");
	return existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
}
