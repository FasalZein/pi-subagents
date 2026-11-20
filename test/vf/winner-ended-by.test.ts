import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { stopRunningSubagent } from "../../src/runtime/wiring.ts";
import type { RunningSubagent } from "../../src/types.ts";
import type { VerifiedRunManifest } from "../../src/vf/run/types.ts";
import { writeVerifiedRunManifest } from "../../src/vf/run/types.ts";
import { verifiedRunToSubagentResult } from "../../src/vf/run/winner-result.ts";
import { assert, createTestDir, resetSubagentStateForTest } from "../support/index.ts";

/**
 * T70 review P1s for a verified fan-out: a kill names who asked for it, also for an adopter that
 * reads the run folder later, and the winner's record lists the files the winner wrote.
 */
const RUN_ID = "vf-20261120-001655-abcd";
const WRITTEN_FILE_ENTRY = "pi-subagent-written-file";

let dirs: string[] = [];
afterEach(() => {
	resetSubagentStateForTest();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

function tempDir(): string {
	const dir = createTestDir();
	dirs.push(dir);
	return dir;
}

function baseManifest(repo: string): VerifiedRunManifest {
	return {
		runId: RUN_ID,
		state: "running",
		createdAt: new Date().toISOString(),
		lease: null,
		candidates: [],
		result: null,
		request: {
			name: "vf-run",
			agent: "worker",
			taskPrompt: "do the thing",
			sourceRepo: repo,
			baseCommit: "0123456789abcdef",
			candidateCount: 2,
			candidates: [],
		},
	} as unknown as VerifiedRunManifest;
}

describe("a verified fan-out record names its ender and its winner's files (T70 review)", () => {
	for (const [operator, expected] of [
		[true, "operator"],
		[false, "parent"],
	] as const) {
		it(`a kill by the ${expected} is recorded as ended by ${expected}; the outcome stays`, async () => {
			const runDir = tempDir();
			const manifest = baseManifest(tempDir());
			writeVerifiedRunManifest(runDir, manifest);
			const running = {
				id: RUN_ID,
				name: "vf-run",
				task: "t",
				agent: "worker",
				mode: "background",
				phase: "running",
				parentClosePolicy: "terminate",
				async: true,
				startTime: Date.now(),
				verifiedRunDir: runDir,
			} as unknown as RunningSubagent;
			await stopRunningSubagent(running, { operator });
			// The supervisor terminalizes the manifest; an adopter publishes from the run folder alone.
			const cancelled = { ...manifest, state: "cancelled" } as VerifiedRunManifest;
			const result = verifiedRunToSubagentResult(cancelled, runDir, { name: "vf-run", task: "t" }, Date.now());
			assert.equal(result.resultEndedBy, expected);
			assert.equal(result.resultOutcome, "failed", "winnerText keeps its outcome");
			assert.match(result.resultText.split("\n")[0], new RegExp(` · ended by ${expected}$`));
		});
	}

	it("the winner's record lists the files the winner wrote after its launch, not a losing attempt's", () => {
		const repo = tempDir();
		const session = (name: string, paths: string[]) => {
			const file = join(repo, name);
			const lines = [
				{ type: "session", id: "h", cwd: repo },
				...paths.map((path, i) => ({ type: "custom", id: `w${i}`, customType: WRITTEN_FILE_ENTRY, data: { path } })),
			];
			writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
			return file;
		};
		// Entry 1 of the winner session predates its launch (launchEntryCount 2).
		const loser = session("w1.jsonl", ["/repo/loser.md"]);
		const winner = session("w2.jsonl", ["/repo/seeded.md", "/repo/winner.md", "/repo/winner.md", "/repo/other.md"]);
		const winnerReport = "The winner report.";
		const manifest = {
			...baseManifest(repo),
			state: "completed",
			request: {
				...baseManifest(repo).request,
				candidates: [
					{ index: 1, sessionFile: loser, launchEntryCount: 1 },
					{ index: 2, sessionFile: winner, launchEntryCount: 2 },
				],
			},
			result: {
				ok: true,
				selection: {
					winnerIndex: 2,
					winnerReport,
					winnerBranch: "vf/w2",
					winnerSessionFile: winner,
					distinctCandidates: 2,
					winnerScore: 0.75,
					criteria: ["alignment"],
					model: "mock-verifier",
					usage: { calls: 1, inputTokens: 1, outputTokens: 1 },
				},
				apply: { applied: true, code: "applied" },
			},
		} as unknown as VerifiedRunManifest;
		const result = verifiedRunToSubagentResult(manifest, tempDir(), { name: "vf-run", task: "t" }, Date.now());
		const reportFile = result.reportFile;
		assert.ok(reportFile, "a report file is named");
		const record = JSON.parse(readFileSync(join(reportFile, "..", "record.json"), "utf8"));
		assert.deepEqual(record.artifacts, ["/repo/winner.md", "/repo/other.md"]);
		assert.ok(readFileSync(reportFile, "utf8").startsWith(winnerReport), "the report is unchanged");
		assert.equal(result.resultOutcome, "done");
	});
});
