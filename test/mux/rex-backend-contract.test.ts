import { join } from "node:path";
import { rexBackend } from "../../src/mux/rex.ts";
import { writeExecutable } from "../support/index.ts";
import { runMuxBackendContract } from "./backend-contract.ts";
import { FAKE_REX, FAKE_REX_PARENT, FAKE_REX_SESSION } from "./fake-rex.ts";
import { readRecordedTitles, readSubmittedCommands } from "./fake-terminal-state.ts";

runMuxBackendContract({
	adapter: rexBackend,
	installFake(binDir, stateDir) {
		writeExecutable(binDir, "rex", FAKE_REX);
		return {
			FAKE_TERMINAL_STATE: stateDir,
			REX_SESSION: FAKE_REX_SESSION,
			REX_BLOCK: FAKE_REX_PARENT,
			// A directory without rex: the PATH checks must not find a REX_BIN_DIR of the host.
			REX_BIN_DIR: join(stateDir, "no-rex"),
			SHELL: "/bin/sh",
		};
	},
	runtimeEnvKeys: ["REX_SESSION", "REX_BLOCK"],
	renamesTab: false,
	renamesWorkspace: false,
	recordedTitles: readRecordedTitles,
	submittedCommands: readSubmittedCommands,
});
