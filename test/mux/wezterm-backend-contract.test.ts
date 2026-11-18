import { weztermBackend } from "../../src/mux/wezterm.ts";
import { writeExecutable } from "../support/index.ts";
import { runMuxBackendContract } from "./backend-contract.ts";
import {
	FAKE_TERMINAL_STATE_JS,
	readRecordedTitles,
	readSubmittedCommands,
	seedCallerSurface,
} from "./fake-terminal-state.ts";

// Stateful fake wezterm. It answers only the \`wezterm cli\` subcommands and argument
// positions that src/mux/wezterm.ts sends. Pane 0 is the caller pane (WEZTERM_PANE).
const FAKE_WEZTERM = `#!/usr/bin/env node
${FAKE_TERMINAL_STATE_JS}
const args = process.argv.slice(2);
if (args[0] !== "cli") fail("fake wezterm: unsupported " + args.join(" "));
const rest = args.slice(2);
const option = (name) => {
  const index = rest.indexOf(name);
  return index === -1 ? undefined : rest[index + 1];
};
switch (args[1]) {
  case "spawn":
    if (rest[0] !== "--cwd") fail("fake wezterm: spawn without --cwd");
    console.log(newSurface());
    break;
  case "split-pane": {
    if (!["--left", "--right", "--top", "--bottom"].includes(rest[0])) fail("fake wezterm: split-pane without direction");
    const from = option("--pane-id");
    if (from !== undefined) requireSurface(from);
    console.log(newSurface());
    break;
  }
  case "set-tab-title": {
    const pane = option("--pane-id");
    if (pane === undefined || pane === process.env.WEZTERM_PANE) recordTitle(rest[rest.length - 1]);
    else requireSurface(pane);
    break;
  }
  case "set-window-title":
    recordTitle(rest[rest.length - 1]);
    break;
  case "send-text":
    if (rest[0] !== "--pane-id" || rest[2] !== "--no-paste") fail("fake wezterm: unsupported send-text");
    typeText(rest[1], rest[3]);
    break;
  case "get-text":
    if (rest[0] !== "--pane-id") fail("fake wezterm: get-text without --pane-id");
    process.stdout.write(screen(rest[1]));
    break;
  case "kill-pane":
    if (rest[0] !== "--pane-id") fail("fake wezterm: kill-pane without --pane-id");
    closeSurface(rest[1]);
    break;
  default:
    fail("fake wezterm: unsupported " + args.join(" "));
}
`;

runMuxBackendContract({
	adapter: weztermBackend,
	installFake(binDir, stateDir) {
		writeExecutable(binDir, "wezterm", FAKE_WEZTERM);
		seedCallerSurface(stateDir, "0");
		return {
			FAKE_TERMINAL_STATE: stateDir,
			WEZTERM_UNIX_SOCKET: "fake-wezterm-socket",
			WEZTERM_PANE: "0",
		};
	},
	runtimeEnvKeys: ["WEZTERM_UNIX_SOCKET"],
	recordedTitles: readRecordedTitles,
	submittedCommands: readSubmittedCommands,
});
