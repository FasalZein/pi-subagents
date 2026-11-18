import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The owner's focused pane before any launch, and the pane of the parent's terminal. */
export const FAKE_APP_OWNER_PANE = "p627dda8b2366ab160aae04a634aec0e5";
export const FAKE_APP_PARENT_PANE = "pdfff0aa11bb22cc33dd44ee55ff66778";
/** The parent's space and tab ids, as the app labels a terminal it shows (live check L3). */
export const FAKE_APP_SPACE = "spff2f401c85e6fd680fa08cc937102c8f";
export const FAKE_APP_TAB = "tb475e0011223344556677889900aabbcc";

/**
 * Stateful fake herdr-app (0.1.16 window) beside the fake hc, on the same $FAKE_TERMINAL_STATE.
 * It replays the recorded shapes (live-hc-window-checks.md, "Shapes for fakes"): status, do pane.focus
 * (--terminal <address> or --pane <id>) and do terminal.keep --terminal <address> --place <p>.
 * terminal.keep takes the hc address only, splits the focused pane, moves focus to the new pane and sets
 * keep and the herdr.space/herdr.tab labels on the hc terminal (L1 to L3). Failure is {"error": "..."}
 * with exit 1. State: app-focus (focused pane), app-panes (terminal address to pane). Every call is
 * appended to "app-calls" as "herdr-app <args>", apart from the hc "calls" log. Failure injection:
 * the file fail-keep makes terminal.keep fail; FAKE_HERDR_APP_DELAY_MS delays every reply.
 */
export const FAKE_HERDR_APP = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const S = process.env.FAKE_TERMINAL_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(S, "app-calls"), "herdr-app " + args.join(" ") + "\\n");
const focusFile = path.join(S, "app-focus");
const panesFile = path.join(S, "app-panes");
const panes = fs.existsSync(panesFile) ? JSON.parse(fs.readFileSync(panesFile, "utf8")) : {};
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const pretty = (value) => JSON.stringify(value, null, 2);
function reply(value, code = 0) {
  const delay = Number(process.env.FAKE_HERDR_APP_DELAY_MS || 0);
  setTimeout(() => { console.log(pretty(value)); process.exit(code); }, delay);
}
function liveTerminal(address) {
  const file = path.join(S, "term-" + address + ".json");
  if (!fs.existsSync(file)) return undefined;
  const term = JSON.parse(fs.readFileSync(file, "utf8"));
  return term.state === "live" ? { term, file } : undefined;
}
const command = args[0] === "do" ? "do " + args[1] : args[0];
switch (command) {
  case "status":
    reply({ zoom: 0.8, font_size: 12.0, ui_font_size: 10.4, space: "${FAKE_APP_SPACE}", tab: "${FAKE_APP_TAB}",
      focused_pane: fs.readFileSync(focusFile, "utf8"), layout: "terminals", agent: null, floats: {}, overlays: [], errors: [] });
    break;
  case "do pane.focus": {
    const pane = flag("--pane") ?? panes[flag("--terminal")];
    if (!pane || !Object.values(panes).concat(["${FAKE_APP_OWNER_PANE}"]).includes(pane)) {
      reply({ error: "no pane for " + (flag("--pane") ?? flag("--terminal")) }, 1);
      break;
    }
    fs.writeFileSync(focusFile, pane);
    reply({ ok: true });
    break;
  }
  case "do terminal.keep": {
    const address = flag("--terminal");
    const live = liveTerminal(address);
    if (!live) { reply({ error: "no running terminal " + JSON.stringify(address) }, 1); break; }
    if (fs.existsSync(path.join(S, "fail-keep"))) { reply({ error: "split failed" }, 1); break; }
    const pane = "p" + address.padEnd(32, "0");
    panes[address] = pane;
    fs.writeFileSync(panesFile, JSON.stringify(panes));
    fs.writeFileSync(focusFile, pane);
    Object.assign(live.term, { keep: true, labels: { ...live.term.labels, "herdr.space": "${FAKE_APP_SPACE}", "herdr.tab": "${FAKE_APP_TAB}" } });
    fs.writeFileSync(live.file, JSON.stringify(live.term));
    reply({ pending: true, terminal: address, pane, tab: "${FAKE_APP_TAB}" });
    break;
  }
  default:
    reply({ error: "fake herdr-app: unsupported " + args.join(" ") }, 1);
}
`;

/** Seeds the app: the owner's pane is focused and the parent terminal has its own pane. */
export function seedFakeHerdrApp(stateDir: string, parent: string): void {
	writeFileSync(join(stateDir, "app-focus"), FAKE_APP_OWNER_PANE);
	writeFileSync(join(stateDir, "app-panes"), JSON.stringify({ [parent]: FAKE_APP_PARENT_PANE }));
}

export function readFakeAppCalls(stateDir: string): string[] {
	const file = join(stateDir, "app-calls");
	return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

export function readFakeAppFocus(stateDir: string): string {
	return readFileSync(join(stateDir, "app-focus"), "utf8");
}

export function fakeAppPaneOf(stateDir: string, address: string): string | undefined {
	const file = join(stateDir, "app-panes");
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>)[address] : undefined;
}
