import { homedir } from "node:os";
import { join } from "node:path";
// Pi's own read-tool resolver is the reference for the report locator (D14). It is not in the
// package exports, so the test imports the file.
import { resolveToCwd } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js";
import { assembleResult } from "../../src/runtime/result-assembler.ts";
import { CUT_MARK, type ReportStorage, type ResultRecord } from "../../src/runtime/result-record.ts";
import {
	FRAME_MAX_CHARS,
	RESULT_TEXT_MAX_CHARS,
	renderResult,
	shortestReadLocator,
	type VerifierFooter,
} from "../../src/runtime/result-render.ts";
import { SUBAGENT_DONE_TOOL_NAME } from "../../src/tools/tool-names.ts";
import { assert, describe, it } from "../support/index.ts";
import { assistant, facts, sessionHeader, syntheticReport, toolCall, toolResult } from "../support/result-fixtures.ts";

const HOME = homedir();
const CWD = "/tmp/parent-work";
const SESSION_FILE = "/tmp/sessions/child-session-file.jsonl";
const VERIFIER_FOOTER: VerifierFooter = { winner: "staged", detail: "attempt 2 of 3; full provenance in the report" };
const VERIFIER_LINE = "verifier: winner staged: attempt 2 of 3; full provenance in the report";
const WARNINGS = ["dropped missing extension: npm:pi-missing-ext", "context at 91% of the window"];

function recordFor(reportLength: number, typed: boolean, report: ReportStorage): ResultRecord {
	const text = syntheticReport(reportLength);
	const entries = typed
		? [
				sessionHeader(),
				assistant(text),
				toolCall(SUBAGENT_DONE_TOOL_NAME, { outcome: "partial", summary: text.slice(0, 1_500), data: { n: 1 } }, "c1"),
				toolResult(SUBAGENT_DONE_TOOL_NAME, "c1", "ok"),
			]
		: [sessionHeader(), assistant(text)];
	const { record } = assembleResult(
		facts(entries, {
			sessionFile: SESSION_FILE,
			acceptedCall: typed
				? {
						toolCallId: "c1",
						args: { outcome: "partial", summary: text.slice(0, 1_500) },
						dataError: "data/n: must be string",
					}
				: undefined,
			contextUsage: { tokens: 91_000, window: 100_000 },
			resume: { resumable: false, reason: "no-session child: its temporary session file was deleted" },
		}),
	);
	return { ...record, report };
}

/** The frame is the rendered text minus the summary line. */
function frameLength(text: string, summary: string): number {
	return text.length - summary.length;
}

function renderedSummary(text: string): string {
	return text
		.split("\n")
		.slice(1, -1)
		.join("\n")
		.split(/\n(?:run|resume): /)[0];
}

describe("result renderer: G1.3 bounded text", () => {
	const savedReport: ReportStorage = {
		saved: true,
		path: join(HOME, ".pi/artifacts/pi-subagents/results/r-0001/report-1.md"),
	};
	for (const length of [400, 3_572, 4_964, 29_993]) {
		for (const typed of [true, false]) {
			it(`a ${length}-character ${typed ? "typed" : "untyped"} report renders within the limits`, () => {
				const record = recordFor(length, typed, savedReport);
				const text = renderResult(record, {
					cwd: CWD,
					homeDir: HOME,
					warnings: WARNINGS,
					verifierFooter: VERIFIER_FOOTER,
					showContextUsage: true,
				});
				assert.ok(text.length <= RESULT_TEXT_MAX_CHARS, `length ${text.length}`);
				assert.ok(text.includes(record.summary), "the whole summary fits with a short locator");
				assert.ok(frameLength(text, record.summary) <= FRAME_MAX_CHARS, `frame ${frameLength(text, record.summary)}`);
				assert.match(text.split("\n")[0], typed ? / · partial · .* · typed · data error$/ : / · done · .* · untyped$/);
				assert.ok(text.includes("run: r-0001"));
				assert.ok(text.includes(VERIFIER_LINE), "the whole verifier footer fits with a short locator");
				assert.ok(text.includes("context: 91000/100000 tokens"), "the requested context line stays");
				assert.ok(text.includes("report: ~/.pi/artifacts/pi-subagents/results/r-0001/report-1.md"));
				assert.ok(!text.includes(SESSION_FILE), "no session path");
				assert.ok(!/--session|--resume|subagent_resume\(/.test(text), "no resume command line");
			});
		}
	}

	it("a 600-character report path keeps its whole locator and cuts the summary further", () => {
		const longDir = Array.from({ length: 12 }, (_, i) => `segment-${i}-${"d".repeat(40)}`).join("/");
		const path = join(HOME, longDir).slice(0, 600 - "/report.md".length) + "/report.md";
		assert.equal(path.length, 600);
		const record = recordFor(29_993, false, { saved: true, path });
		const options = { cwd: CWD, homeDir: HOME, warnings: WARNINGS, verifierFooter: VERIFIER_FOOTER };
		const text = renderResult(record, options);
		const locator = `~/${path.slice(HOME.length + 1)}`;
		assert.ok(text.includes(`report: ${locator}\n`), "the footer names the whole ~ locator");
		assert.ok(text.length <= RESULT_TEXT_MAX_CHARS, `length ${text.length}`);
		assert.ok(text.includes("\nverifier: winner staged"), "the verifier's staged fact is a required field (D18)");
		for (const warning of WARNINGS) assert.ok(!text.includes(warning), "warnings get no room beyond 400 characters");
		const summary = renderedSummary(text);
		assert.ok(frameLength(text, summary) <= FRAME_MAX_CHARS + locator.length, "only the locator widens the frame");
		assert.ok(summary.endsWith(CUT_MARK), "the summary is cut further with a cut mark");
		assert.ok(summary.length < record.summary.length);
		assert.equal(resolveToCwd(locator, CWD), path, "Pi's read tool resolves the locator");
	});

	it("report paths up to the macOS limit of 1,024 characters keep the text within 1,900", () => {
		for (let pathLength = 20; pathLength <= 1_024; pathLength += 41) {
			const path = `/${"p/".repeat(pathLength)}`.slice(0, pathLength - 3) + ".md";
			for (const reportLength of [1, 1_499, 1_500, 1_501, 29_993]) {
				const record = recordFor(reportLength, reportLength % 2 === 0, { saved: true, path });
				const text = renderResult(record, {
					cwd: CWD,
					homeDir: HOME,
					warnings: WARNINGS,
					verifierFooter: VERIFIER_FOOTER,
					showContextUsage: true,
				});
				assert.ok(text.length <= RESULT_TEXT_MAX_CHARS, `path ${pathLength}, report ${reportLength}: ${text.length}`);
				assert.ok(text.includes(`report: ${path}`), "the whole locator stays");
			}
		}
	});

	it("a report that was not saved says so and names no path", () => {
		const record = recordFor(3_572, true, { saved: false, error: "EACCES: permission denied" });
		const text = renderResult(record, { cwd: CWD, homeDir: HOME });
		assert.ok(text.includes("report not saved: EACCES: permission denied"));
		assert.ok(text.length <= RESULT_TEXT_MAX_CHARS);
	});

	it("each outcome word appears in the header", () => {
		const words = {
			done: "done",
			partial: "partial",
			blocked: "blocked",
			failed: "failed",
			timed_out: "timed out",
			cancelled: "cancelled",
		} as const;
		const base = recordFor(400, false, { saved: true, path: "/tmp/r.md" });
		for (const [outcome, word] of Object.entries(words)) {
			const text = renderResult({ ...base, outcome: outcome as ResultRecord["outcome"] }, { cwd: CWD, homeDir: HOME });
			assert.ok(text.split("\n")[0].includes(` · ${word} · `), outcome);
		}
	});
});

describe("result renderer: report locator (D14)", () => {
	const cases: Array<[string, string, string]> = [
		["a path under the home folder uses ~", join(HOME, "x/y/report.md"), "/somewhere/else/entirely/deep/down"],
		["a path under the working directory is relative", "/tmp/parent-work/results/r1/report.md", "/tmp/parent-work"],
		["a path near the working directory may climb", "/tmp/a/report.md", "/tmp/a/b"],
		["a path outside both stays absolute", "/r.md", "/tmp/parent-work/deep/folder/tree"],
	];
	for (const [label, path, cwd] of cases) {
		it(label, () => {
			const locator = shortestReadLocator(path, cwd, HOME);
			assert.equal(resolveToCwd(locator, cwd), path, "Pi's read tool resolves it back");
			const all = [
				path,
				`~/${path.slice(HOME.length + 1)}`,
				...(path.startsWith(`${cwd}/`) ? [path.slice(cwd.length + 1)] : []),
			];
			for (const form of all) {
				if (resolveToCwd(form, cwd) === path) assert.ok(locator.length <= form.length, `${locator} vs ${form}`);
			}
		});
	}

	it("a relative form that Pi would rewrite is not used", () => {
		const cwd = "/tmp/w";
		for (const path of ["/tmp/w/@notes/report.md", "/tmp/w/~cache/report.md"]) {
			const locator = shortestReadLocator(path, cwd, HOME);
			assert.equal(resolveToCwd(locator, cwd), path);
		}
	});
});

describe("result renderer: frame budget (D14)", () => {
	const path = `/${"r".repeat(196)}.md`;
	const warning = "w".repeat(400);
	const record = (): ResultRecord => ({ ...recordFor(1_500, true, { saved: true, path }), summary: "s".repeat(1_500) });

	it("a warning never widens the frame past 400 when the required fields fit", () => {
		assert.equal(path.length, 200);
		const text = renderResult(record(), { cwd: CWD, homeDir: HOME, warnings: [warning] });
		assert.ok(text.includes("s".repeat(1_500)), "the whole summary stays");
		assert.ok(frameLength(text, "s".repeat(1_500)) <= FRAME_MAX_CHARS, `frame ${frameLength(text, "s".repeat(1_500))}`);
	});

	it("a requested context-usage line is never dropped for warnings", () => {
		const text = renderResult(record(), { cwd: CWD, homeDir: HOME, warnings: [warning], showContextUsage: true });
		assert.ok(text.includes("context: 91000/100000 tokens"), text);
		assert.ok(frameLength(text, "s".repeat(1_500)) <= FRAME_MAX_CHARS);
	});

	// Review R2-1: a failed report write has no locator, so no D14 exception widens the frame.
	const saveError = `EACCES: permission denied, open '${HOME}/${"deep/".repeat(40)}report.md'`;
	const unsaved = () => ({ ...recordFor(1_500, true, { saved: false, error: saveError }), summary: "s".repeat(1_500) });

	it("a failed report write with every required field keeps the frame within 400", () => {
		const options = {
			cwd: CWD,
			homeDir: HOME,
			warnings: WARNINGS,
			verifierFooter: VERIFIER_FOOTER,
			showContextUsage: true,
		};
		const text = renderResult(unsaved(), options);
		assert.ok(frameLength(text, "s".repeat(1_500)) <= FRAME_MAX_CHARS, `frame ${frameLength(text, "s".repeat(1_500))}`);
		assert.ok(text.includes("s".repeat(1_500)), "the whole summary stays");
		assert.ok(text.includes("\nrun: r-0001 · report not saved: EACCES"), "the storage fact stays");
		assert.ok(text.includes("\nnot resumable: no-session child"), "the resume reason stays");
		assert.ok(text.includes("\nverifier: winner staged"), "the staged fact stays (D18)");
		assert.ok(text.includes("\ncontext: 91000/100000 tokens"));
	});

	it("a verifier text over 1,900 characters keeps the frame and the total within their caps", () => {
		const detail = `provenance ${"p".repeat(1_950)}`;
		for (const report of [
			{ saved: false as const, error: saveError },
			{ saved: true as const, path: "/tmp/r.md" },
		]) {
			const record = { ...recordFor(1_500, true, report), summary: "s".repeat(1_500) };
			const text = renderResult(record, {
				cwd: CWD,
				homeDir: HOME,
				verifierFooter: { winner: "not applied", detail },
				showContextUsage: true,
			});
			assert.ok(text.length <= RESULT_TEXT_MAX_CHARS, `length ${text.length}`);
			assert.ok(
				frameLength(text, "s".repeat(1_500)) <= FRAME_MAX_CHARS,
				`frame ${frameLength(text, "s".repeat(1_500))}`,
			);
			assert.ok(text.includes("\nverifier: winner not applied: provenance "), "the not-applied fact stays (D18)");
			assert.ok(text.includes("\ncontext: 91000/100000 tokens"));
		}
	});

	it("a watcher error that names the session file never reaches the text", () => {
		const error = `Invalid session JSONL at ${SESSION_FILE}:7: Unexpected end of JSON input`;
		const { record: failed } = assembleResult(
			facts([sessionHeader()], { sessionFile: SESSION_FILE, end: { kind: "failed", error, code: 1 } }),
		);
		const text = renderResult({ ...failed, report: { saved: true, path: "/tmp/r.md" } }, { cwd: CWD, homeDir: HOME });
		assert.ok(!text.includes(SESSION_FILE), text);
	});
});

// T88: a result says its run id once, shows the context line only near the window, and a resumable
// time-limit result names the resume call.
describe("T88 result footer", () => {
	const saved: ReportStorage = { saved: true, path: "/tmp/results/r-0001/report-1.md" };
	const base = (): ResultRecord => ({
		...recordFor(200, false, saved),
		resume: { resumable: true },
	});
	const loc = shortestReadLocator(saved.path, CWD, HOME);
	const render = (record: ResultRecord) => renderResult(record, { cwd: CWD, homeDir: HOME, showContextUsage: true });

	it("says the run id on one line with the report locator", () => {
		const text = render(base());
		assert.ok(text.includes(`\nrun: r-0001 · report: ${loc}`), text);
		assert.equal(text.match(/\brun: /g)?.length, 1, text);
	});

	it("drops the context line below 80% of the window and keeps it from 80%", () => {
		const below = render({ ...base(), contextUsage: { tokens: 79_999, window: 100_000 } });
		assert.ok(!below.includes("context: "), below);
		const near = render({ ...base(), contextUsage: { tokens: 80_000, window: 100_000 } });
		assert.ok(near.includes("\ncontext: 80000/100000 tokens"), near);
		const noWindow = render({ ...base(), contextUsage: { tokens: 900_000 } });
		assert.ok(!noWindow.includes("context: "), noWindow);
	});

	const wrapUp = { kind: "timeout" as const, seconds: 900, wrapUp: true };
	const resumeCall = 'subagent_resume({ runId: "r-0001" })';

	it("a resumable time-limit result names the resume call with its run id", () => {
		for (const record of [
			{ ...base(), timeLimit: wrapUp },
			{ ...base(), outcome: "timed_out" as const, timeLimit: { ...wrapUp, wrapUp: false } },
		]) {
			const text = render(record);
			assert.ok(text.includes(`\nresume: ${resumeCall} · report: ${loc}`), text);
			assert.ok(!text.includes("run: r-0001"), "the run id stays once");
		}
	});

	it("a time-limit result that cannot resume, or a result without a time limit, names no resume call", () => {
		const blocked = render({ ...base(), timeLimit: wrapUp, resume: { resumable: false, reason: "blocked" } });
		assert.ok(!blocked.includes("subagent_resume"), blocked);
		assert.ok(blocked.includes("\nrun: r-0001 · report: "), blocked);
		assert.ok(!render(base()).includes("subagent_resume"));
	});
});
