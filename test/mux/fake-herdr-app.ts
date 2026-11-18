import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The owner's focused pane before any launch, in its own tab, and the pane of the parent's terminal. */
export const FAKE_APP_OWNER_PANE = "p627dda8b2366ab160aae04a634aec0e5";
export const FAKE_APP_OWNER_TAB = "tb02a560c441c7d2599bf7d23482208dc3";
export const FAKE_APP_PARENT_PANE = "pdfff0aa11bb22cc33dd44ee55ff66778";
/** The parent's space and tab ids, as the app labels a terminal it shows (live check L3). */
export const FAKE_APP_SPACE = "spff2f401c85e6fd680fa08cc937102c8f";
export const FAKE_APP_TAB = "tb475e0011223344556677889900aabbcc";

/**
 * Stateful fake herdr-app (0.1.16 window) beside the fake hc, on the same $FAKE_TERMINAL_STATE.
 * It replays the recorded shapes (live-hc-window-checks.md, "Shapes for fakes"): status, do pane.focus
 * (--terminal <address> or --pane <id>) and do terminal.keep --terminal <address> --place <p>.
 * terminal.keep takes the hc address only, splits the focused pane into that pane's tab, moves focus to
 * the new pane and sets keep and the herdr.space/herdr.tab labels on the hc terminal (L1 to L3); status
 * shows the tab of the focused pane. Failure is {"error": "..."} with exit 1.
 * State: app-focus (focused pane), app-panes (terminal address to pane), app-tabs (pane to tab).
 * Every call is appended to "app-calls" as "herdr-app <args>", apart from the hc "calls" log.
 * Failure injection (files): fail-keep makes terminal.keep fail; focus-no-ok makes pane.focus --terminal
 * exit 0 without ok: true; fail-restore makes pane.focus --pane fail. FAKE_HERDR_APP_DELAY_MS delays
 * every reply. The status/focus pair is not atomic, like two separate app calls.
 * The idea of a stateful focus fake with injected focus failures comes from upstream PR #33
 * (test/support/herdr-app-fake.ts, modes steal-focus and status-fail-once).
 */
export const FAKE_HERDR_APP = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const S = process.env.FAKE_TERMINAL_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(S, "app-calls"), "herdr-app " + args.join(" ") + "\\n");
const focusFile = path.join(S, "app-focus");
const panesFile = path.join(S, "app-panes");
const tabsFile = path.join(S, "app-tabs");
const panes = JSON.parse(fs.readFileSync(panesFile, "utf8"));
const tabs = JSON.parse(fs.readFileSync(tabsFile, "utf8"));
const has = (name) => fs.existsSync(path.join(S, name));
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
  case "status": {
    const focused = fs.readFileSync(focusFile, "utf8");
    reply({ zoom: 0.8, font_size: 12.0, ui_font_size: 10.4, space: "${FAKE_APP_SPACE}", tab: tabs[focused],
      focused_pane: focused, layout: "terminals", agent: null, floats: {}, overlays: [], errors: [] });
    break;
  }
  case "do pane.focus": {
    const byPane = flag("--pane");
    const pane = byPane ?? panes[flag("--terminal")];
    if (!pane || !(pane in tabs)) { reply({ error: "no pane for " + (byPane ?? flag("--terminal")) }, 1); break; }
    if (byPane && has("fail-restore")) { reply({ error: "focus refused" }, 1); break; }
    fs.writeFileSync(focusFile, pane);
    reply(!byPane && has("focus-no-ok") ? {} : { ok: true });
    break;
  }
  case "do terminal.keep": {
    const address = flag("--terminal");
    const live = liveTerminal(address);
    if (!live) { reply({ error: "no running terminal " + JSON.stringify(address) }, 1); break; }
    if (has("fail-keep")) { reply({ error: "split failed" }, 1); break; }
    const tab = tabs[fs.readFileSync(focusFile, "utf8")];
    const pane = "p" + address.padEnd(32, "0");
    panes[address] = pane;
    tabs[pane] = tab;
    fs.writeFileSync(panesFile, JSON.stringify(panes));
    fs.writeFileSync(tabsFile, JSON.stringify(tabs));
    fs.writeFileSync(focusFile, pane);
    Object.assign(live.term, { keep: true, labels: { ...live.term.labels, "herdr.space": "${FAKE_APP_SPACE}", "herdr.tab": tab } });
    fs.writeFileSync(live.file, JSON.stringify(live.term));
    reply({ pending: true, terminal: address, pane, tab });
    break;
  }
  default:
    reply({ error: "fake herdr-app: unsupported " + args.join(" ") }, 1);
}
`;

/** Seeds the app: the owner's pane is focused in its own tab and the parent terminal has a pane in FAKE_APP_TAB. */
export function seedFakeHerdrApp(stateDir: string, parent: string): void {
	writeFileSync(join(stateDir, "app-focus"), FAKE_APP_OWNER_PANE);
	writeFileSync(join(stateDir, "app-panes"), JSON.stringify({ [parent]: FAKE_APP_PARENT_PANE }));
	writeFileSync(
		join(stateDir, "app-tabs"),
		JSON.stringify({ [FAKE_APP_OWNER_PANE]: FAKE_APP_OWNER_TAB, [FAKE_APP_PARENT_PANE]: FAKE_APP_TAB }),
	);
}

/** Shows one more terminal in the app, in its own pane and tab. */
export function addFakeAppPane(stateDir: string, address: string, pane: string, tab: string): void {
	const read = (name: string) => JSON.parse(readFileSync(join(stateDir, name), "utf8")) as Record<string, string>;
	writeFileSync(join(stateDir, "app-panes"), JSON.stringify({ ...read("app-panes"), [address]: pane }));
	writeFileSync(join(stateDir, "app-tabs"), JSON.stringify({ ...read("app-tabs"), [pane]: tab }));
}

export function readFakeAppCalls(stateDir: string): string[] {
	const file = join(stateDir, "app-calls");
	return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

export function readFakeAppFocus(stateDir: string): string {
	return readFileSync(join(stateDir, "app-focus"), "utf8");
}

export function fakeAppPaneOf(stateDir: string, address: string): string | undefined {
	return (JSON.parse(readFileSync(join(stateDir, "app-panes"), "utf8")) as Record<string, string>)[address];
}

export function fakeAppTabOf(stateDir: string, pane: string): string | undefined {
	return (JSON.parse(readFileSync(join(stateDir, "app-tabs"), "utf8")) as Record<string, string>)[pane];
}
