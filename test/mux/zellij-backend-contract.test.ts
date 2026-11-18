import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zellijBackend } from "../../src/mux/zellij.ts";
import { getZellijShellCommand } from "../../src/mux/zellij-runtime.ts";
import { writeExecutable } from "../support/index.ts";
import { runMuxBackendContract } from "./backend-contract.ts";
import {
	FAKE_TERMINAL_STATE_JS,
	readRecordedTitles,
	readSubmittedCommands,
	readTypedText,
	seedCallerSurface,
} from "./fake-terminal-state.ts";

const CALLER_PANE = "0";

// Stateful fake zellij. It answers only the subcommands and argument positions that
// src/mux/zellij.ts, zellij-runtime.ts and the floating path of zellij-placement.ts send.
// Pane 0 is the caller pane (ZELLIJ_PANE_ID). write-chars types into pending-N; "write 13"
// submits it. A pane started with "-- <argv>" stores that argv in program-N, apart from typed text.
const FAKE_ZELLIJ = `#!/usr/bin/env node
${FAKE_TERMINAL_STATE_JS}
const SESSION = process.env.FAKE_ZELLIJ_SESSION;
let args = process.argv.slice(2);
function panesJson() {
  const ids = fs.readdirSync(S).filter((name) => name.startsWith("screen-")).map((name) => Number(name.slice(7)));
  return JSON.stringify(ids.map((id) => ({ id, is_plugin: false, exited: false, title: "pane " + id })));
}
function paneArg(rest) {
  if (rest[0] !== "--pane-id") fail("fake zellij: " + args.join(" ") + " without --pane-id");
  return rest[1];
}
function newPane(rest) {
  const separator = rest.indexOf("--");
  const id = newSurface();
  if (separator !== -1) fs.writeFileSync(file("program", id), JSON.stringify(rest.slice(separator + 1)));
  console.log("terminal_" + id);
}
if (args[0] === "list-sessions" && args[1] === "--no-formatting") {
  console.log(SESSION + " [Created 1s ago]");
  process.exit(0);
}
if (args[0] === "--session") {
  if (args[1] !== SESSION) fail("fake zellij: unknown session " + args[1]);
  args = args.slice(2);
}
if (args[0] !== "action") fail("fake zellij: unsupported " + args.join(" "));
const rest = args.slice(2);
switch (args[1]) {
  case "list-panes":
    if (rest.join(" ") !== "--all --json" && rest.join(" ") !== "--json --geometry --state --tab")
      fail("fake zellij: unsupported list-panes " + rest.join(" "));
    console.log(panesJson());
    break;
  case "new-pane":
    if (rest.slice(0, 4).join(" ") === "--floating --pinned true --near-current-pane") {
      requireSurface(process.env.ZELLIJ_PANE_ID);
      newPane(rest);
    } else if (rest[0] === "--direction" && ["right", "down"].includes(rest[1])) {
      requireSurface(process.env.ZELLIJ_PANE_ID);
      newPane(rest);
    } else fail("fake zellij: unsupported new-pane " + rest.join(" "));
    break;
  case "rename-pane": {
    const pane = paneArg(rest);
    requireSurface(pane);
    if (pane === "${CALLER_PANE}") recordTitle(rest[2]);
    break;
  }
  case "write-chars":
    typeText(paneArg(rest), rest[2]);
    break;
  case "write":
    if (rest[2] !== "13") fail("fake zellij: write supports only 13");
    typeText(paneArg(rest), "\\n");
    break;
  case "dump-screen":
    process.stdout.write(screen(paneArg(rest)));
    break;
  case "close-pane":
    closeSurface(paneArg(rest));
    break;
  default:
    fail("fake zellij: unsupported " + args.join(" "));
}
`;

function stateId(surface: string): string {
	return surface.startsWith("pane:") ? surface.slice("pane:".length) : surface;
}

runMuxBackendContract({
	adapter: zellijBackend,
	installFake(binDir, stateDir) {
		writeExecutable(binDir, "zellij", FAKE_ZELLIJ);
		seedCallerSurface(stateDir, CALLER_PANE);
		// A per-run session name keeps the placement lock of this run apart from other runs.
		const session = `contract-${process.pid}-${Date.now()}`;
		return {
			FAKE_TERMINAL_STATE: stateDir,
			FAKE_ZELLIJ_SESSION: session,
			ZELLIJ: "0",
			ZELLIJ_SESSION_NAME: session,
			ZELLIJ_PANE_ID: CALLER_PANE,
			// Floating placement needs no attached client; zellij-placement and zellij-owned-placement tests pin the other policies.
			PI_SUBAGENT_ZELLIJ_PLACEMENT: "floating",
			SHELL: "/bin/sh",
		};
	},
	runtimeEnvKeys: ["ZELLIJ", "ZELLIJ_SESSION_NAME"],
	runtimeEnvKeysRule: "any-suffices",
	renamesWorkspace: false,
	recordedTitles: readRecordedTitles,
	submittedCommands: (stateDir, surface) => readSubmittedCommands(stateDir, stateId(surface)),
	directProgram: {
		checkExit: true,
		// node runs the private launcher script, which starts SHELL (/bin/sh here) with -c and the command.
		// Only the launcher script comes from the wrapper; the run in the contract proves that it runs the command.
		expectedProgram: (launch) => [
			process.execPath,
			"-e",
			getZellijShellCommand("")[2]!,
			"/bin/sh",
			"-c",
			launch.shellCommand,
		],
		startedProgram(stateDir, surface) {
			const path = join(stateDir, `program-${stateId(surface)}`);
			return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as string[]) : undefined;
		},
		typedText: (stateDir, surface) => readTypedText(stateDir, stateId(surface)),
	},
});
