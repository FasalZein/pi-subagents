import { herdrBackend } from "../../src/mux/herdr-backend.ts";
import { writeExecutable } from "../support/index.ts";
import { runMuxBackendContract } from "./backend-contract.ts";
import {
	FAKE_TERMINAL_STATE_JS,
	readRecordedTitles,
	readSubmittedCommands,
	seedCallerSurface,
} from "./fake-terminal-state.ts";

const CALLER_PANE = "0";

// Stateful fake herdr. It answers only the subcommands and argument positions that
// src/mux/herdr.ts sends for the explicit "right" placement policy, the split, the
// pane IO and the renames. Pane 0 is the caller pane in tab t0 of workspace w0.
// "pane run" submits its text; "pane send-keys <pane> Enter" submits Enter only.
const FAKE_HERDR = `#!/usr/bin/env node
${FAKE_TERMINAL_STATE_JS}
const args = process.argv.slice(2);
const reply = (result) => console.log(JSON.stringify({ id: "fake", result }));
const pane = (id) => ({ pane_id: id, tab_id: "t0", workspace_id: "w0" });
const command = args.slice(0, 2).join(" ");
switch (command) {
  case "status server":
    console.log(JSON.stringify({ status: "running", running: true, compatible: true, protocol: 14 }));
    break;
  case "pane current":
    reply({ type: "pane_current", pane: pane("${CALLER_PANE}") });
    break;
  case "pane split":
    if (args[3] !== "--direction" || !["right", "down"].includes(args[4])) fail("fake herdr: unsupported split " + args.join(" "));
    requireSurface(args[2]);
    reply({ type: "pane_split", pane: pane(newSurface()) });
    break;
  case "pane rename":
    requireSurface(args[2]);
    reply({ type: "ok" });
    break;
  case "tab rename":
    if (args[2] !== "t0") fail("fake herdr: unknown tab " + args[2]);
    recordTitle(args[3]);
    reply({ type: "ok" });
    break;
  case "workspace rename":
    if (args[2] !== "w0") fail("fake herdr: unknown workspace " + args[2]);
    recordTitle(args[3]);
    reply({ type: "ok" });
    break;
  case "pane run":
    typeText(args[2], args[3] + "\\n");
    break;
  case "pane send-keys":
    if (args[3] !== "Enter") fail("fake herdr: send-keys supports only Enter");
    typeText(args[2], "\\n");
    break;
  case "pane read":
    if (args.slice(3).join(" ") !== "--source recent --lines " + args[6] + " --format text") fail("fake herdr: unsupported read " + args.join(" "));
    process.stdout.write(screen(args[2]).split("\\n").slice(-Number(args[6])).join("\\n"));
    break;
  case "pane close":
    closeSurface(args[2]);
    reply({ type: "ok" });
    break;
  default:
    fail("fake herdr: unsupported " + args.join(" "));
}
`;

runMuxBackendContract({
	adapter: herdrBackend,
	installFake(binDir, stateDir) {
		writeExecutable(binDir, "herdr", FAKE_HERDR);
		seedCallerSurface(stateDir, CALLER_PANE);
		return {
			FAKE_TERMINAL_STATE: stateDir,
			HERDR_PANE_ID: CALLER_PANE,
			// The parent Pi of a test run can itself run in herdr; these replace its ids.
			HERDR_TAB_ID: "t0",
			HERDR_WORKSPACE_ID: "w0",
			// The explicit split policy needs no layout; herdr-placement tests pin the other policies.
			PI_SUBAGENT_HERDR_PLACEMENT: "right",
			// A parent Pi renames its tab and workspace; a subagent renames only its pane.
			PI_SUBAGENT_NAME: "",
			PI_SUBAGENT_SESSION: "",
		};
	},
	runtimeEnvKeys: ["HERDR_PANE_ID"],
	recordedTitles: readRecordedTitles,
	submittedCommands: readSubmittedCommands,
});
