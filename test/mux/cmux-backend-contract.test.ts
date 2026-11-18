import { cmuxBackend } from "../../src/mux/cmux.ts";
import { writeExecutable } from "../support/index.ts";
import { runMuxBackendContract } from "./backend-contract.ts";
import {
	FAKE_TERMINAL_STATE_JS,
	readRecordedTitles,
	readSubmittedCommands,
	seedCallerSurface,
} from "./fake-terminal-state.ts";

// Stateful fake cmux. It answers only the subcommands and argument positions that
// src/mux/cmux.ts and src/mux/cmux-surfaces.ts send. identify fails, so createSurface
// takes the new-surface path and skips the focus restore. surface:0 is the caller surface.
const FAKE_CMUX = `#!/usr/bin/env node
${FAKE_TERMINAL_STATE_JS}
const args = process.argv.slice(2);
const surfaceId = (ref) => (ref || "").replace(/^surface:/, "");
const created = (id) => console.log("surface:" + id + " pane:" + id);
switch (args[0]) {
  case "identify":
    process.exit(1);
  case "new-surface":
    created(newSurface());
    break;
  case "new-split":
    if (args[2] !== "--surface") fail("fake cmux: new-split without --surface");
    requireSurface(surfaceId(args[3]));
    created(newSurface());
    break;
  case "rename-tab":
    if (args[1] !== "--surface") fail("fake cmux: rename-tab without --surface");
    if (args[2] === process.env.CMUX_SURFACE_ID) recordTitle(args[3]);
    else requireSurface(surfaceId(args[2]));
    break;
  case "workspace-action":
    if (args[1] !== "--action" || args[2] !== "rename" || args[3] !== "--title") fail("fake cmux: unsupported workspace-action");
    recordTitle(args[4]);
    break;
  case "send":
    typeText(surfaceId(args[2]), args[3]);
    break;
  case "read-screen":
    process.stdout.write(screen(surfaceId(args[2])).split("\\n").slice(-Number(args[4])).join("\\n"));
    break;
  case "close-surface":
    closeSurface(surfaceId(args[2]));
    break;
  default:
    fail("fake cmux: unsupported " + args.join(" "));
}
`;

runMuxBackendContract({
	adapter: cmuxBackend,
	installFake(binDir, stateDir) {
		writeExecutable(binDir, "cmux", FAKE_CMUX);
		seedCallerSurface(stateDir, "0");
		return {
			FAKE_TERMINAL_STATE: stateDir,
			CMUX_SOCKET_PATH: "fake-cmux-socket",
			CMUX_SURFACE_ID: "surface:0",
		};
	},
	runtimeEnvKeys: ["CMUX_SOCKET_PATH"],
	recordedTitles: readRecordedTitles,
	submittedCommands: (stateDir, surface) => readSubmittedCommands(stateDir, surface.replace(/^surface:/, "")),
});
