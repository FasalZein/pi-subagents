import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { adoptVerifiedRuns } from "../../src/vf/run/adopt.ts";
import { waitForVerifiedRunResult } from "../../src/vf/run/client.ts";
import { verifiedRunsBaseDir } from "../../src/vf/run/launch.ts";
import type { VerifiedRunManifest } from "../../src/vf/run/types.ts";
import { readVerifiedRunManifest, writeVerifiedRunManifest } from "../../src/vf/run/types.ts";
import { verifiedRunNotice, verifiedRunToSubagentResult } from "../../src/vf/run/winner-result.ts";
import {
	assert,
	createTestDir,
	resetSubagentStateForTest,
	setRunningSubagentForTest,
	waitForSubagentForTest,
} from "../support/index.ts";
import { buildSupervisedRun, setupVerifiedRunFixture } from "../support/verified-runs.ts";

/**
 * D18 with D14: a verified fan-out winner goes through the one assembler and renderer. The text
 * stays within 1,900 characters, verifier footer included, and names the report file that keeps
 * the whole winner report and its provenance.
 */

const TEXT_LIMIT = 1900;
const RUN_ID = "vf-20261119-001655-abcd";

let dirs: string[] = [];
afterEach(() => {
	resetSubagentStateForTest();
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
		const result = verifiedRunToSubagentResult(
			manifest(winnerReport, true),
			dir,
			{ name: "vf-run", task: "t" },
			Date.now() - 5_000,
		);
		assert.ok(result.resultText.length <= TEXT_LIMIT, `text has ${result.resultText.length} characters`);
		assert.match(result.resultText, /verifier: winner staged/);
		assert.doesNotMatch(result.resultText, /END-OF-REPORT/);
		assert.ok(result.reportFile, "a report file is named");
		assert.ok(
			result.resultText.includes(result.reportFile) || result.resultText.includes("report: "),
			"the text names the report",
		);
		const report = readFileSync(result.reportFile, "utf8");
		assert.ok(report.startsWith(winnerReport), "the report keeps the whole winner report");
		assert.match(report, /git reset --hard 0123456789abcdef/);
		assert.equal(result.resultRunId, RUN_ID);
		assert.equal(result.exitCode, 0);
		assert.doesNotMatch(result.resultText, /Resume: pi --session/);
	});

	it("keeps the not-applied fact in the capped text", () => {
		const result = verifiedRunToSubagentResult(
			manifest("x".repeat(20_000), false),
			runDir(),
			{ name: "vf-run", task: "t" },
			Date.now(),
		);
		assert.ok(result.resultText.length <= TEXT_LIMIT);
		assert.match(result.resultText, /verifier: winner not applied/);
	});

	it("makes a retry's newer generation the run's current record and report", () => {
		const dir = runDir();
		// A real retry follows a failed verification: generation 1 fails, generation 2 has the winner.
		const failed = { ...manifest("unused", true), resultGeneration: 1 } as VerifiedRunManifest;
		failed.result = {
			...failed.result!,
			ok: false,
			selection: null,
			apply: null,
			failure: { code: "verifier-error", message: "generation 1 verifier failure" },
		} as never;
		const retried = { ...manifest("second generation report", true), resultGeneration: 2 } as VerifiedRunManifest;
		const first = verifiedRunToSubagentResult(failed, dir, { name: "vf-run", task: "t" }, Date.now());
		const second = verifiedRunToSubagentResult(retried, dir, { name: "vf-run", task: "t" }, Date.now());
		assert.notEqual(first.reportFile, second.reportFile);
		const current = verifiedRunNotice(retried, dir, { name: "vf-run", task: "t" }, Date.now(), "notice");
		assert.equal(current.reportFile, second.reportFile);
		assert.match(readFileSync(second.reportFile ?? "", "utf8"), /^second generation report/);
		assert.equal(current.resultOutcome, "done");
	});

	it("keeps generation 2 current when a generation 1 publication arrives after it", () => {
		const dir = runDir();
		const failed = { ...manifest("unused", true), resultGeneration: 1 } as VerifiedRunManifest;
		failed.result = {
			...failed.result!,
			ok: false,
			selection: null,
			apply: null,
			failure: { code: "verifier-error", message: "generation 1 verifier failure" },
		} as never;
		const winner = { ...manifest("generation 2 winner report", true), resultGeneration: 2 } as VerifiedRunManifest;
		const second = verifiedRunToSubagentResult(winner, dir, { name: "vf-run", task: "t" }, Date.now());
		verifiedRunToSubagentResult(failed, dir, { name: "vf-run", task: "t" }, Date.now());
		const current = verifiedRunNotice(winner, dir, { name: "vf-run", task: "t" }, Date.now(), "notice");
		assert.equal(current.reportFile, second.reportFile, "the current result stays generation 2");
		assert.match(readFileSync(current.reportFile ?? "", "utf8"), /^generation 2 winner report/);
	});

	it("returns the capped winner with its metadata from a direct wait", async () => {
		const dir = runDir();
		const result = {
			...verifiedRunToSubagentResult(
				manifest("w".repeat(20_000), true),
				dir,
				{ name: "vf-run", task: "t" },
				Date.now(),
			),
			deliveryId: `${RUN_ID}-g1`,
		};
		const running = {
			id: "vf-wait-1",
			name: "vf-run",
			task: "t",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "continue" as const,
			startTime: Date.now(),
			sessionFile: "",
			completionPromise: Promise.resolve(result),
		};
		setRunningSubagentForTest(running);
		const waited = await waitForSubagentForTest({ id: running.id });
		const text = (waited.content[0] as { text: string }).text;
		const details = waited.details as Record<string, unknown>;
		assert.ok(text.length <= TEXT_LIMIT);
		assert.match(text, /verifier: winner staged/);
		assert.equal(details.runId, RUN_ID);
		assert.equal(details.reportFile, result.reportFile);
		assert.equal(details.deliveryId, `${RUN_ID}-g1`);
	});
});

describe("verified fan-out winner on adoption", () => {
	it("caps a 20,000-character winner on adoption and on re-adoption, and keeps the report out of a notice", async () => {
		const { repo, fakePi, captureDir, parent } = setupVerifiedRunFixture();
		dirs.push(parent);
		const artifactRoot = createTestDir();
		dirs.push(artifactRoot);
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir: dir } = buildSupervisedRun(
			repo,
			fakePi,
			captureDir,
			[
				{ marker: "VF-GOOD", change: "good change" },
				{ marker: "VF-MID", change: "mid change" },
			],
			{ baseDir: verifiedRunsBaseDir(repo), parentSessionId: "session-origin" },
		);
		await waitForVerifiedRunResult(dir, { timeoutMs: 120_000 });
		const finished = readVerifiedRunManifest(dir);
		const longReport = `${"Adopted winner line.\n".repeat(1_000)}END-OF-ADOPTED`;
		assert.ok(longReport.length >= 20_000);
		finished.result!.selection!.winnerReport = longReport;
		// Delayed adoption: the run ended ten minutes ago, one minute after it started.
		const ended = Date.now() - 600_000;
		finished.createdAt = new Date(ended - 60_000).toISOString();
		finished.result!.finishedAt = new Date(ended).toISOString();
		writeVerifiedRunManifest(dir, finished);

		const messages: Array<{ content: string; details: Record<string, unknown> }> = [];
		const sink = {
			sendMessage: (m: { content: string; details?: Record<string, unknown> }) =>
				messages.push({ content: m.content, details: m.details ?? {} }),
		};
		const stranger = await adoptVerifiedRuns(sink as never, repo, { sessionId: "session-stranger" });
		assert.equal(stranger.find((entry) => entry.runDir === dir)?.action, "awaiting-origin");
		assert.doesNotMatch(messages[0].content, /Adopted winner line/, "a notice holds no winner report");

		// An unconfirmed receipt leaves the winner adoptable again; both copies are capped.
		const first = await adoptVerifiedRuns(sink as never, repo, {
			sessionId: "session-origin",
			confirmPersisted: async () => false,
		});
		assert.equal(first.find((entry) => entry.runDir === dir)?.action, "unconfirmed");
		const again = await adoptVerifiedRuns(sink as never, repo, {
			sessionId: "session-origin",
			confirmPersisted: async () => true,
		});
		assert.equal(again.find((entry) => entry.runDir === dir)?.action, "delivered");
		const winners = messages.slice(1);
		assert.equal(winners.length, 2);
		// A replay of the same generation is the same delivery: same id, same report file, same text.
		assert.equal(winners[0].details.deliveryId, winners[1].details.deliveryId);
		assert.equal(winners[0].details.reportFile, winners[1].details.reportFile);
		assert.equal(winners[0].content, winners[1].content);
		// D13: the end and elapsed time are the run's, not the adoption's.
		assert.ok(Math.abs((winners[0].details.elapsed as number) - 60) < 2, `elapsed ${winners[0].details.elapsed}`);
		for (const message of winners) {
			assert.ok(message.content.length <= TEXT_LIMIT, `text has ${message.content.length} characters`);
			assert.match(message.content, /verifier: winner (staged|not applied)/);
			assert.doesNotMatch(message.content, /END-OF-ADOPTED/);
			assert.equal(typeof message.details.deliveryId, "string");
			assert.equal(message.details.verifiedRunId, finished.runId);
			assert.equal(message.details.runId, finished.runId);
			const reportFile = message.details.reportFile as string;
			assert.ok(message.content.includes("report: "), "the text names the report");
			assert.ok(readFileSync(reportFile, "utf8").startsWith(longReport), "the report keeps the whole winner report");
		}
		delete process.env.PI_ARTIFACT_PROJECT_ROOT;
	});
});
