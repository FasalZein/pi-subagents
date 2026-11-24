import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getSessionResultsDir } from "../../src/artifact-storage.ts";
import { RECORD_FILE, sessionResultStore } from "../../src/runtime/result-files.ts";
import { publishRunResult, type WatchedEnd } from "../../src/runtime/run-result.ts";
import { REPORT_FOLDER_PREFIX, renderLaunchReply } from "../../src/tools/launch-reply.ts";
import { launchedChildData } from "../../src/tools/launch-structured.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { assert, createTestDir, describe, it } from "../support/index.ts";
import { assistant, sessionHeader, toolCall, toolResult, user } from "../support/result-fixtures.ts";

// Owner decision 2026-11-24: the launch reply names, under each child line, the folder where the run's
// report lands, so a parent reads a result by path after a reopen or a compaction (no lookup tool).
// The expected folder is where publishRunResult actually wrote the report, not what the reply code says.

/** A run reserved in a parent session's results folder, as the background, pane and resume paths do. */
function reservedRun(cwd: string, mode: "background" | "interactive", name: string): RunningSubagent {
	const store = sessionResultStore(getSessionResultsDir(cwd, "parent-session"));
	const reservation = store.reserve();
	return {
		id: reservation.runId,
		name,
		task: "t",
		agent: "worker",
		mode,
		phase: { kind: "running" },
		parentClosePolicy: "terminate",
		startTime: Date.now(),
		sessionFile: join(cwd, `${name}.jsonl`),
		resultTarget: { store, reservation, parentCwd: cwd, warnings: [] },
	} as RunningSubagent;
}

/** Ends the run as its watcher does: typed (subagent_done) or untyped (final text only). */
function endRun(running: RunningSubagent, typed: boolean): string {
	const args = { outcome: "done", summary: `SUMMARY ${running.name}` };
	const entries = typed
		? [sessionHeader(), user("task"), toolCall("subagent_done", args, "d1"), toolResult("subagent_done", "d1", "ok")]
		: [sessionHeader(), user("task"), assistant(`ANSWER ${running.name}`)];
	writeFileSync(running.sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	const end: WatchedEnd = {
		exitCode: 0,
		operatorClosed: false,
		closedByPerson: false,
		stopped: false,
		exitSignal: typed ? ({ reason: "done", exitCode: 0, acceptedCall: { toolCallId: "d1", args } } as never) : null,
		contextUsage: {},
	};
	const published = publishRunResult(running, end);
	assert.ok(published?.record.report.saved, "the report was saved");
	return published.record.report.saved ? published.record.report.path : "";
}

/** The folder the reply names for each child, resolved as Pi's read tool resolves it. */
function namedFolders(text: string, cwd: string): string[] {
	return text
		.split("\n")
		.filter((line) => line.startsWith(REPORT_FOLDER_PREFIX))
		.map((line) => line.slice(REPORT_FOLDER_PREFIX.length))
		.map((locator) => (locator.startsWith("~/") ? join(homedir(), locator.slice(2)) : resolve(cwd, locator)));
}

describe("owner decision 2026-11-24: the launch reply names each run's report folder", () => {
	it("names, under each child line, the folder where a typed or untyped, background or pane run's report lands", () => {
		const cwd = createTestDir();
		const runs = [
			reservedRun(cwd, "background", "bg-typed"),
			reservedRun(cwd, "background", "bg-untyped"),
			reservedRun(cwd, "interactive", "pane-typed"),
			reservedRun(cwd, "interactive", "pane-untyped"),
		];
		const text = renderLaunchReply(
			runs,
			runs.map(() => null),
			[],
		);
		const lines = text.split("\n");
		for (const [index, running] of runs.entries())
			assert.ok(lines[index * 2]?.startsWith(`- ${running.name} `), `the folder line follows the child line: ${text}`);
		const folders = namedFolders(text, cwd);
		assert.equal(folders.length, runs.length);
		// Closure review P1: a codemode script gets the structured reply; each child carries the same folder.
		const structured = runs.map((running) => launchedChildData(running, "worker", false).reportFolder);
		assert.deepEqual(structured, folders, "the structured reply names the folder the text reply names");
		const reports = runs.map((running) => endRun(running, running.name.endsWith("-typed")));
		for (const [index, report] of reports.entries()) {
			assert.equal(dirname(report), folders[index], `${runs[index]?.name}: the report is in the named folder`);
			assert.ok(existsSync(report));
			assert.ok(existsSync(join(folders[index] ?? "", RECORD_FILE)), "the record is there too");
		}
	});

	it("names a verified run's generation folder, and says so when the run folder could not be created", () => {
		const cwd = createTestDir();
		const verified = { ...reservedRun(cwd, "background", "vf-run"), verifiedRunDir: join(cwd, "vf-runs", "abcd1234") };
		const noFolder = reservedRun(cwd, "background", "no-folder");
		const target = noFolder.resultTarget;
		assert.ok(target);
		noFolder.resultTarget = { ...target, reservation: { runId: target.reservation.runId, error: "EACCES" } };
		const text = renderLaunchReply([verified, noFolder], [null, null], []);
		assert.ok(text.includes(`${REPORT_FOLDER_PREFIX}`), text);
		// The generation folder is created at the first publish: the line says so (closure review P2).
		assert.match(text, /report folder: vf-runs\/abcd1234\/result \(created at its first report, g<n>\/report\.md\)/);
		// True for both parents: a waiting parent gets the result in the reply, another one by message.
		assert.match(
			text,
			/report folder: none \(the results folder failed; the result is kept only in this session's memory\)/,
		);
		assert.doesNotMatch(text, /arrives only as a message/);
		// The structured children carry the same facts: the verified folder, and null for none.
		assert.equal(launchedChildData(verified, "worker", false).reportFolder, join(cwd, "vf-runs", "abcd1234", "result"));
		assert.equal(launchedChildData(noFolder, "worker", false).reportFolder, null);
	});
});
