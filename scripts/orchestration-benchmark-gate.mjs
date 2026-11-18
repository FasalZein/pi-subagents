#!/usr/bin/env node
/**
 * Gate run of the orchestration benchmark (G2.1): 3 scenarios x 2 models x 3 repetitions.
 *
 *   BENCH_MODEL_1=<ref> BENCH_MODEL_2=<ref> node scripts/orchestration-benchmark-gate.mjs \\
 *     start --set baseline --checkout <detached clean worktree> --thinking high
 *   BENCH_MODEL_1=<ref> BENCH_MODEL_2=<ref> node scripts/orchestration-benchmark-gate.mjs \\
 *     report --set baseline
 *
 * start: launches one detached job runner (it survives the calling session) that
 *   runs the pending samples one at a time through the launcher; its log is
 *   <set folder>/jobs.log. Rerunning start runs only samples without a verdict.
 *   A second start while a runner is alive exits without starting another.
 * run: the job runner itself (start calls it).
 * report: writes <set folder>/report.md from every record in the set folder.
 *
 * Model refs come only from the environment; logs and the report name them
 * "model 1" and "model 2". Samples run one at a time: the launcher's known
 * limits forbid parallel jobs on one checkout.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	MODEL_ENV,
	modelOfRef,
	pendingSamples,
	samplePlan,
} from "./orchestration-benchmark/baseline-plan.mjs";
import {
	renderReport,
	summarize,
} from "./orchestration-benchmark/baseline-report.mjs";
import {
	acquireClaim,
	releaseClaim,
} from "./orchestration-benchmark/claim.mjs";

const SELF = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = dirname(SELF);
const LAUNCHER = join(SCRIPTS_DIR, "orchestration-benchmark.mjs");
const OUT_ROOT = join(
	homedir(),
	".pi",
	"artifacts",
	"pi-subagents",
	"benchmark",
);

function fail(message) {
	console.error(message);
	process.exit(1);
}

function parseCli() {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			set: { type: "string" },
			checkout: { type: "string" },
			thinking: { type: "string" },
		},
	});
	const [command] = positionals;
	if (!["start", "run", "report"].includes(command))
		fail("usage: start | run | report (see the file header)");
	// Same rule as the launcher's --set: the folder cannot leave the fixed root.
	if (!values.set || !/^[a-z0-9-]+$/.test(values.set))
		fail("--set must be a plain lower-case name");
	const models = MODEL_ENV.map((name, index) => {
		const ref = process.env[name]?.trim();
		if (!ref) fail(`set ${name}`);
		return { label: `model ${index + 1}`, ref };
	});
	if (command !== "report" && (!values.checkout || !values.thinking))
		fail("--checkout and --thinking are required");
	return {
		command,
		setDir: join(OUT_ROOT, values.set),
		set: values.set,
		checkout: values.checkout && realpathSync(resolve(values.checkout)),
		thinking: values.thinking,
		models,
	};
}

function readRecords(setDir) {
	if (!existsSync(setDir)) return [];
	return readdirSync(setDir)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.flatMap((file) => {
			try {
				return [
					{
						file,
						record: JSON.parse(readFileSync(join(setDir, file), "utf8")),
					},
				];
			} catch {
				return [{ file, record: null }];
			}
		});
}

const log = (text) => console.log(`${new Date().toISOString()} ${text}`);

function start(cli) {
	mkdirSync(cli.setDir, { recursive: true, mode: 0o700 });
	const logFd = openSync(join(cli.setDir, "jobs.log"), "a", 0o600);
	const child = spawn(
		process.execPath,
		[
			SELF,
			"run",
			"--set",
			cli.set,
			"--checkout",
			cli.checkout,
			"--thinking",
			cli.thinking,
		],
		{ detached: true, stdio: ["ignore", logFd, logFd] },
	);
	child.unref();
	console.log(
		`started job runner pid ${child.pid}; log ${join(cli.setDir, "jobs.log")}`,
	);
}

function run(cli) {
	mkdirSync(cli.setDir, { recursive: true, mode: 0o700 });
	const lockPath = join(cli.setDir, "runner.lock");
	const claim = acquireClaim(lockPath);
	if ("busy" in claim) {
		log(`runner not started: ${claim.busy}`);
		return;
	}
	const release = () => releaseClaim(lockPath, claim.token);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
		process.on(signal, () => {
			release();
			process.exit(1);
		});
	try {
		const commit = execFileSync(
			"git",
			["-C", cli.checkout, "rev-parse", "HEAD"],
			{ encoding: "utf8" },
		).trim();
		const harness = execFileSync(
			"git",
			["-C", SCRIPTS_DIR, "rev-parse", "HEAD"],
			{ encoding: "utf8" },
		).trim();
		const plan = samplePlan(cli.models);
		const records = readRecords(cli.setDir)
			.map(({ record }) => record)
			.filter(Boolean);
		const pending = pendingSamples(plan, records, {
			commit,
			thinking: cli.thinking,
		});
		log(
			`runner pid ${process.pid}: harness ${harness}, measured ${commit}; ${plan.length - pending.length} of ${plan.length} finished, ${pending.length} to run`,
		);
		for (const [index, sample] of pending.entries()) {
			log(
				`[${index + 1}/${pending.length}] start ${sample.scenario} rep ${sample.rep} ${sample.label}`,
			);
			const result = spawnSync(
				process.execPath,
				[
					LAUNCHER,
					"--set",
					cli.set,
					"--checkout",
					cli.checkout,
					"--scenario",
					sample.scenario,
					"--rep",
					String(sample.rep),
					"--thinking",
					cli.thinking,
				],
				{
					stdio: ["ignore", "inherit", "inherit"],
					env: { ...process.env, PI_SUBAGENT_LIVE_MODEL: sample.ref },
				},
			);
			log(
				`[${index + 1}/${pending.length}] end ${sample.scenario} rep ${sample.rep} ${sample.label}: exit ${result.status ?? result.signal}`,
			);
		}
		const left = pendingSamples(
			plan,
			readRecords(cli.setDir)
				.map(({ record }) => record)
				.filter(Boolean),
			{ commit, thinking: cli.thinking },
		);
		log(
			`runner done: ${plan.length - left.length} of ${plan.length} finished, ${left.length} without a verdict`,
		);
	} finally {
		release();
	}
}

function report(cli) {
	const labels = new Map(
		cli.models.map(({ label, ref }) => [modelOfRef(ref), label]),
	);
	const summary = summarize(
		readRecords(cli.setDir),
		(model) => labels.get(model) ?? null,
	);
	const text = renderReport(summary, {
		harnessCommit: execFileSync(
			"git",
			["-C", SCRIPTS_DIR, "rev-parse", "HEAD"],
			{ encoding: "utf8" },
		).trim(),
		generatedAt: new Date().toISOString(),
		expected: samplePlan(cli.models).length,
	});
	const path = join(cli.setDir, "report.md");
	writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
	console.log(
		`wrote ${path}: ${summary.counted.length} counted, ${summary.notCounted.length} not counted`,
	);
}

const cli = parseCli();
({ start, run, report })[cli.command](cli);
