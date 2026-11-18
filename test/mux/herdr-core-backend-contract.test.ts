import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { herdrCoreBackend } from "../../src/mux/herdr-core.ts";
import { writeExecutable } from "../support/index.ts";
import { runMuxBackendContract } from "./backend-contract.ts";
import { FAKE_HC, FAKE_HC_CALLER, seedFakeHcCaller } from "./fake-hc.ts";
import { readRecordedTitles, readSubmittedCommands, readTypedText } from "./fake-terminal-state.ts";

runMuxBackendContract({
	adapter: herdrCoreBackend,
	installFake(binDir, stateDir) {
		writeExecutable(binDir, "hc", FAKE_HC);
		seedFakeHcCaller(stateDir);
		return {
			FAKE_TERMINAL_STATE: stateDir,
			HC_TERMINAL_ID: FAKE_HC_CALLER,
			HC_TERMINAL_SOCKET: join(stateDir, "hc.sock"),
			HC_SCOPE: "contract",
			SHELL: "/bin/sh",
		};
	},
	runtimeEnvKeys: ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"],
	renamesWorkspace: false,
	recordedTitles: readRecordedTitles,
	submittedCommands: readSubmittedCommands,
	directProgram: {
		checkExit: true,
		// No shell: the launcher argv is the terminal's program as it is.
		expectedProgram: (launch) => [...launch.launcherArgv],
		startedProgram(stateDir, surface) {
			const path = join(stateDir, `program-${surface}`);
			return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as string[]) : undefined;
		},
		typedText: readTypedText,
		vanishDuringLivenessQuery(stateDir, surface, file) {
			writeFileSync(join(stateDir, "vanish-on-query"), JSON.stringify({ address: surface, ...file }));
		},
	},
});
