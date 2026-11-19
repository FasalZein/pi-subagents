import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { RECORD_FILE } from "../../src/runtime/result-files.ts";
import type { ResultRecord } from "../../src/runtime/result-record.ts";
import type { VerifiedRunManifest } from "../../src/vf/run/types.ts";
import { verifiedRunToSubagentResult } from "../../src/vf/run/winner-result.ts";
import { assert, createTestDir } from "../support/index.ts";

/**
 * D18 with D14: a verified fan-out winner goes through the one assembler and renderer. The text
 * stays within 1,900 characters, verifier footer included, and names the report file that keeps
 * the whole winner report and its provenance.
 */

const TEXT_LIMIT = 1900;
const RUN_ID = "vf-20261119-001655-abcd";

let dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

function manifest(winnerReport: string, applied: boolean): VerifiedRunManifest {
	const repo = createTestDir();
	dirs.push(repo);
	return {
		runId: RUN_ID,
		state: "completed",
		createdAt: new Date().toISOString(),
		request: {
			name: "vf-run",
			agent: "worker",
			taskPrompt: "do the thing",
			sourceRepo: repo,
			baseCommit: "0123456789abcdef",
			candidateCount: 3,
			candidates: [],
		},
		result: {
			ok: true,
			selection: {
				winnerIndex: 2,
				winnerReport,
				winnerBranch: "vf/20261119-001655-abcd/w2",
				winnerSessionFile: join(repo, "w2.jsonl"),
				distinctCandidates: 3,
				winnerScore: 0.75,
				criteria: ["alignment", "evidence"],
				model: "mock-verifier",
				usage: { calls: 4, inputTokens: 100, outputTokens: 20 },
			},
			apply: applied ? { applied: true, code: "applied" } : { applied: false, code: "source-drift" },
		},
	} as unknown as VerifiedRunManifest;
}

function runDir(): string {
	const dir = createTestDir();
	dirs.push(dir);
	return dir;
}

describe("verified fan-out winner result", () => {
	it("caps a 20,000-character winner report and names the report file that keeps it whole", () => {
		const winnerReport = `${"Winner line with findings.\n".repeat(770)}END-OF-REPORT`;
		assert.ok(winnerReport.length >= 20_000);
		const dir = runDir();
		const result = verifiedRunToSubagentResult(manifest(winnerReport, true), dir, { name: "vf-run", task: "t" }, Date.now() - 5_000);
		assert.ok(result.resultText.length <= TEXT_LIMIT, `text has ${result.resultText.length} characters`);
		assert.match(result.resultText, /verifier: winner staged/);
		assert.doesNotMatch(result.resultText, /END-OF-REPORT/);
		assert.ok(result.reportFile, "a report file is named");
		assert.ok(result.resultText.includes(result.reportFile) || result.resultText.includes("report: "), "the text names the report");
		const report = readFileSync(result.reportFile, "utf8");
		assert.ok(report.startsWith(winnerReport), "the report keeps the whole winner report");
		assert.match(report, /git reset --hard 0123456789abcdef/);
		assert.equal(result.resultRunId, RUN_ID);
		assert.equal(result.exitCode, 0);
		assert.doesNotMatch(result.resultText, /Resume: pi --session/);
	});

	it("keeps the not-applied fact in the capped text", () => {
		const result = verifiedRunToSubagentResult(manifest("x".repeat(20_000), false), runDir(), { name: "vf-run", task: "t" }, Date.now());
		assert.ok(result.resultText.length <= TEXT_LIMIT);
		assert.match(result.resultText, /verifier: winner not applied/);
	});

	it("switches the run's record and report to the newer generation after a retry", () => {
		const dir = runDir();
		const first = verifiedRunToSubagentResult(manifest("first generation report", true), dir, { name: "vf-run", task: "t" }, Date.now());
		const second = verifiedRunToSubagentResult(manifest("second generation report", true), dir, { name: "vf-run", task: "t" }, Date.now());
		assert.notEqual(first.reportFile, second.reportFile);
		const record = JSON.parse(readFileSync(join(dir, "result", RECORD_FILE), "utf8")) as ResultRecord;
		assert.ok(record.report.saved);
		assert.equal(record.report.saved && record.report.path, second.reportFile);
		assert.match(readFileSync(second.reportFile ?? "", "utf8"), /^second generation report/);
		assert.match(record.summary, /second generation report/);
	});
});
