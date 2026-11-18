#!/usr/bin/env node
/**
 * Gate run of the orchestration benchmark (G2.1): 3 scenarios x 2 models x 3 repetitions.
 *
 *   BENCH_MODEL_1=<ref> BENCH_MODEL_2=<ref> node scripts/orchestration-benchmark-gate.mjs \\
 *     start --set baseline --checkout <detached clean worktree> --thinking high
 *   node scripts/orchestration-benchmark-gate.mjs report --set baseline
 *
 * start: launches one detached job runner (it survives the calling session) that
 *   runs the pending samples one at a time through the launcher; its log is
 *   <set folder>/jobs.log. Rerunning start runs only samples without a verdict.
 *   A second start while a runner is alive exits without starting another.
 * run: the job runner itself (start calls it). It asks the launcher (--plan) for
 *   each sample's full key, writes the plan to <set folder>/gate-plan.jsonl
 *   (key ids, labels, file names; no model ref) and queues the samples the
 *   launcher would run.
 * report: writes <set folder>/report.md from the top-level records of the
 *   planned keys in gate-plan.jsonl.
 *
 * Model refs come only from the environment; logs, the plan and the report name
 * them "model 1" and "model 2". Samples run one at a time: the launcher's known
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
	assertDistinctKeys,
	MODEL_ENV,
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
import { sampleKeyId } from "./orchestration-benchmark/record.mjs";

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
			// Default "" so the name check below also rejects a missing --set.
			set: { type: "string", default: "" },
			checkout: { type: "string" },
			thinking: { type: "string" },
		},
	});
	const [command] = positionals;
	if (!["start", "run", "report"].includes(command))
		fail("usage: start | run | report (see the file header)");
	// Same rule as the launcher's --set: the folder cannot leave the fixed root.
	if (!/^[a-z0-9-]+$/.test(values.set))
		fail("--set must be a plain lower-case name");
	// The report labels models from the run's plan file, so it needs no model refs.
	let models = [];
	if (command !== "report") {
		models = MODEL_ENV.map((name, index) => {
			const ref = process.env[name]?.trim();
			if (!ref) fail(`set ${name}`);
			return { label: `model ${index + 1}`, ref };
		});
		if (!values.checkout || !values.thinking)
			fail("--checkout and --thinking are required");
	}
	return {
		command,
		setDir: join(OUT_ROOT, values.set),
		set: values.set,
		checkout: values.checkout && realpathSync(resolve(values.checkout)),
		thinking: values.thinking,
		models,
	};
}

const PLAN_FILE = "gate-plan.jsonl";

/** Top-level JSON files of the set folder; subfolders (superseded runs) are not read. */
function readRecords(setDir) {
	if (!existsSync(setDir)) return [];
	return readdirSync(setDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => entry.name)
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

const launcherArgs = (cli, sample) => [
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
];
const launcherEnv = (sample) => ({
	...process.env,
	PI_SUBAGENT_LIVE_MODEL: sample.ref,
});

/** Each planned sample with the launcher's full key and file name (launcher --plan). */
function planSamples(cli) {
	const planned = samplePlan(cli.models).map((sample) => {
		const result = spawnSync(
			process.execPath,
			[...launcherArgs(cli, sample), "--plan"],
			{ encoding: "utf8", env: launcherEnv(sample) },
		);
		// The launcher's errors carry a safe message (no model ref).
		if (result.status !== 0)
			throw new Error(
				`launcher --plan failed for ${sample.scenario} rep ${sample.rep} ${sample.label}: ${result.stderr.trim()}`,
			);
		const { key, file } = JSON.parse(result.stdout.trim().split("\n").at(-1));
		return { ...sample, key, file };
	});
	assertDistinctKeys(planned);
	return planned;
}

function writePlan(setDir, planned) {
	const text = planned
		.map(({ key, file, label, scenario, rep }) =>
			JSON.stringify({ keyId: sampleKeyId(key), file, label, scenario, rep }),
		)
		.join("\n");
	const path = join(setDir, PLAN_FILE);
	writeFileSync(`${path}.tmp`, `${text}\n`, { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
}

function readPlan(setDir) {
	const path = join(setDir, PLAN_FILE);
	if (!existsSync(path)) fail(`${path} is missing: run start first`);
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

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
		const plan = planSamples(cli);
		writePlan(cli.setDir, plan);
		const readText = (file) => {
			const path = join(cli.setDir, file);
			return existsSync(path) ? readFileSync(path, "utf8") : null;
		};
		const pending = pendingSamples(plan, readText);
		log(
			`runner pid ${process.pid}: harness ${harness}, measured ${commit}; ${plan.length - pending.length} of ${plan.length} finished, ${pending.length} to run`,
		);
		for (const [index, sample] of pending.entries()) {
			log(
				`[${index + 1}/${pending.length}] start ${sample.scenario} rep ${sample.rep} ${sample.label}`,
			);
			const result = spawnSync(process.execPath, launcherArgs(cli, sample), {
				stdio: ["ignore", "inherit", "inherit"],
				env: launcherEnv(sample),
			});
			log(
				`[${index + 1}/${pending.length}] end ${sample.scenario} rep ${sample.rep} ${sample.label}: exit ${result.status ?? result.signal}`,
			);
		}
		const left = pendingSamples(plan, readText);
		log(
			`runner done: ${plan.length - left.length} of ${plan.length} finished, ${left.length} without a verdict`,
		);
	} finally {
		release();
	}
}

function report(cli) {
	const plan = readPlan(cli.setDir);
	const summary = summarize(readRecords(cli.setDir), plan);
	const text = renderReport(summary, {
		harnessCommit: execFileSync(
			"git",
			["-C", SCRIPTS_DIR, "rev-parse", "HEAD"],
			{ encoding: "utf8" },
		).trim(),
		generatedAt: new Date().toISOString(),
		expected: plan.length,
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
