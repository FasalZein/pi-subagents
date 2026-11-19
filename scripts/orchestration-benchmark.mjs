#!/usr/bin/env node
/**
 * Orchestration benchmark launcher: runs one sample and writes one JSON record.
 *
 *   PI_SUBAGENT_LIVE_MODEL=<provider/model:thinking> node scripts/orchestration-benchmark.mjs \\
 *     --checkout <detached clean worktree> --scenario <name> --rep <n> [--thinking <level>] [--set <name>] [--plan] [--keep-sessions]
 *
 * --plan prints the sample's full key and file name as one JSON line and runs nothing;
 * the gate runner (orchestration-benchmark-gate.mjs) plans its queue with it.
 * The thinking level is required: as a suffix of the model ref or with --thinking.
 * The model comes only from the environment, so no model ref lands in the repository.
 * Records always go to ~/.pi/artifacts/pi-subagents/benchmark, outside any repository;
 * --set <plain name> puts them in one subfolder of it (baseline, candidate).
 * A sample file with a valid checksum and a verdict is final; a rerun does nothing.
 * Only a sample that ended without a verdict for an infrastructure reason runs again.
 *
 * Preconditions (the launcher checks the first; the operator owns the others):
 * - The measured checkout is a private linked worktree with a detached HEAD and no
 *   changes (git worktree add --detach <dir> <rev>). An archive copy is refused:
 *   the sample key needs a git commit.
 * - Nothing else touches that checkout while a sample runs.
 * - One launcher at a time per sample key (the exclusive claim covers normal contention only).
 *
 * Scenarios: smoke (launcher check), recon (G2.1 scenario (a): 6 children, 7 keyed facts),
 * review (G2.1 scenario (b): 8 children, 8 verdicts keyed by target)
 * and review-fix (G2.1 scenario (c): build, review, fix; a held-out test decides).
 * A scenario may declare inspectWorkspace(workDir): it runs after the parent ends and
 * before cleanup, and its facts land in the attempt and in final.workspace.
 * The record keeps delivery accounting by run id in final.delivery (see delivery.mjs).
 *
 * Known limits (accepted for version 1):
 * - F4: two launchers that create one claim at the same moment can both start the sample.
 * - F14: a checkout switched and restored during a run can publish other code under its commit.
 * - F13: provider settings edited between the fingerprint read and the launch read mix inputs.
 * - F2: a hard kill during root removal can leave credentials in a root without its owner tag.
 * - F12: an answer written in the last poll interval before the deadline counts as a timeout.
 * - T04: on a timeout, a child probe without a session file (no task arrived) keeps the
 *   timeout verdict; the record counts it as load.unfiledProbes, not as infra.
 * - F11: a child provider error can cause both a native recovery and a harness retry.
 * - T04 finding 5: on a timeout, an unfiled child probe is forgiven without checking
 *   that it names this attempt's session root, model and checkout.
 * - Revisit all of these before parallel benchmark jobs run on one checkout.
 * - T04 finding 1: scenario review is the v2.9.2 arm of (b) (direct launches). The candidate
 *   arm (workflow script, G2.1) is scenario review-workflow, so the baseline fixture
 *   hash does not change.
 * - Namesakes: children join their run ids by launch name. A scenario must give
 *   its children unique launch names; an attempt where two launched children
 *   share a name ends as an infrastructure error. Revisit when a scenario needs
 *   repeated names (join each child session to its run id by session file).
 * - Duplicate work is attributed by the parent's requested read paths, not by
 *   facts observed in successful tool results (a failed read counts, a bash read
 *   does not). It feeds the duplicate outcome class only, never the verdict.
 * - Candidate adapters (T59a, see delivery.mjs): grouped result messages, launches
 *   and reads nested in codemode scripts (run ids from the run folders), and
 *   declared workflow digests. A parent read of a report file is no duplicate work.
 * - review-workflow (G2.1 (b), candidate arm): the parent gets --tools +codemode.
 * - Undelivered results have the sub-class unknown on v2.9.2: its session files
 *   record no queue or drop evidence (see delivery.mjs).
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runAttempt } from "./orchestration-benchmark/attempt.mjs";
import {
	forRelease,
	releaseCapabilities,
} from "./orchestration-benchmark/candidate-evidence.mjs";
import {
	acquireClaim,
	holdsClaim,
	releaseClaim,
} from "./orchestration-benchmark/claim.mjs";
import {
	canonicalJson,
	RECORD_SCHEMA,
	rerunDecision,
	sampleFileName,
	sampleKey,
	sampleKeyId,
	sealRecord,
	sha256,
	totals,
} from "./orchestration-benchmark/record.mjs";
import {
	assertPrivateCheckout,
	BenchError,
	cleanups,
} from "./orchestration-benchmark/run-state.mjs";
import {
	hashFiles,
	readProviderModels,
	recoverAbandonedRoots,
	SAMPLE_SETTINGS,
	settingsFingerprint,
} from "./orchestration-benchmark/sample-home.mjs";
import { stopServer } from "./orchestration-benchmark/tmux-parent.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPTS_DIR, "..");
const BENCH_DIR = join(SCRIPTS_DIR, "orchestration-benchmark");
const OUT_DIR = join(
	homedir(),
	".pi",
	"artifacts",
	"pi-subagents",
	"benchmark",
);
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
const MAX_ATTEMPTS = 2; // one retry on a provider error
// G2.1: a sample has a 10-minute deadline without user input, from prompt submission.
const SCENARIO_DEADLINE_MS = 10 * 60_000;
const LOGIN_MARGIN_MS = 30 * 60_000;

function parseCli() {
	const { values } = parseArgs({
		options: {
			checkout: { type: "string" },
			scenario: { type: "string" },
			rep: { type: "string" },
			thinking: { type: "string" },
			set: { type: "string" },
			plan: { type: "boolean" },
			"keep-sessions": { type: "boolean" },
		},
	});
	const live = process.env.PI_SUBAGENT_LIVE_MODEL?.trim();
	if (!live)
		throw new BenchError(
			"set PI_SUBAGENT_LIVE_MODEL=<provider/model:thinking>",
		);
	if (!values.checkout || !values.scenario || !values.rep)
		throw new BenchError("--checkout, --scenario and --rep are required");
	const rep = Number(values.rep);
	if (!Number.isInteger(rep) || rep < 1)
		throw new BenchError("--rep must be a positive integer");
	const suffix = live.slice(live.lastIndexOf(":") + 1);
	const hasSuffix = live.includes(":") && THINKING_LEVELS.includes(suffix);
	const model = hasSuffix ? live.slice(0, live.lastIndexOf(":")) : live;
	const thinking = values.thinking ?? (hasSuffix ? suffix : undefined);
	if (!thinking || !THINKING_LEVELS.includes(thinking)) {
		throw new BenchError(
			`a thinking level is required (${THINKING_LEVELS.join(", ")}): model suffix or --thinking`,
		);
	}
	if (!/^[\w.-]+$/.test(values.scenario))
		throw new BenchError("--scenario must be a plain name");
	// No dot or separator, so the folder cannot leave the fixed output root.
	if (values.set !== undefined && !/^[a-z0-9-]+$/.test(values.set))
		throw new BenchError("--set must be a plain lower-case name");
	const checkout = realpathSync(resolve(values.checkout));
	if (checkout === realpathSync(REPO_ROOT))
		throw new BenchError("--checkout must not be the harness repository");
	const outDir = values.set ? join(OUT_DIR, values.set) : OUT_DIR;
	return {
		checkout,
		scenario: values.scenario,
		rep,
		model,
		thinking,
		outDir,
		plan: values.plan === true,
		keepSessions: values["keep-sessions"] === true,
	};
}

async function loadScenario(name) {
	const dir = join(BENCH_DIR, "scenarios", name);
	if (!existsSync(join(dir, "scenario.mjs")))
		throw new BenchError(`unknown scenario ${name}`);
	const definition = (
		await import(pathToFileURL(join(dir, "scenario.mjs")).href)
	).default;
	for (const role of definition.expectedChildRoles) {
		const contract = definition.childResults?.[role];
		const returns = [contract?.returns].flat();
		if (
			!returns.length ||
			returns.some((token) => typeof token !== "string") ||
			!Array.isArray(contract.reads)
		)
			throw new BenchError(
				`scenario ${name} declares no result for child ${role}`,
			);
	}
	return {
		...definition,
		dir,
		agentsDir: join(dir, "agents"),
		workspaceDir: join(dir, "workspace"),
	};
}

/**
 * Hash of the launcher, its modules and the frozen agent fixture of the fixed-cost
 * probe (tests and scenarios excluded; scenarios have their own hash). The gate's
 * plan and report modules (baseline-*.mjs) do not change a sample and stay out.
 */
function harnessHash() {
	const modules = readdirSync(BENCH_DIR)
		.filter(
			(name) =>
				/\.(mjs|ts)$/.test(name) &&
				!name.endsWith(".test.mjs") &&
				!name.startsWith("baseline-"),
		)
		.map((name) => join(BENCH_DIR, name));
	return hashFiles(
		[
			join(SCRIPTS_DIR, "orchestration-benchmark.mjs"),
			...modules,
			join(BENCH_DIR, "agent-fixture"),
		],
		SCRIPTS_DIR,
	);
}

/** Write privately to a temporary name, then rename. Only the claim holder calls it. */
function publish(path, text) {
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, text, { mode: 0o600 });
	renameSync(temporary, path);
}

function sumAttempts(attempts) {
	const parentRows = attempts.flatMap(
		(attempt) => attempt.parent?.ledger ?? [],
	);
	const childRows = attempts.flatMap(
		(attempt) =>
			attempt.children?.children.flatMap((child) => child.ledger) ?? [],
	);
	return { parent: totals(parentRows), children: totals(childRows) };
}

async function main() {
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.on(signal, () => {
			cleanups.runAll();
			process.exit(
				128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1),
			);
		});
	}
	const cli = parseCli();
	const loaded = await loadScenario(cli.scenario);
	if (
		!existsSync(join(cli.checkout, "src", "index.ts")) ||
		!existsSync(join(cli.checkout, "node_modules"))
	) {
		throw new BenchError(
			"--checkout needs src/index.ts and installed node_modules",
		);
	}
	// A plan run starts nothing, so it leaves other runs' attempt folders alone.
	const recovered = cli.plan ? [] : recoverAbandonedRoots(stopServer);
	if (recovered.length)
		console.log(`removed ${recovered.length} abandoned attempt folder(s)`);
	const checkout = assertPrivateCheckout(cli.checkout);
	// Candidate-only allowances follow the measured release (candidate-evidence.mjs).
	const scenario = forRelease(loaded, releaseCapabilities(cli.checkout));
	const provider = cli.model.split("/")[0];
	const piVersion = execFileSync("pi", ["--version"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
	const settings = {
		pi: SAMPLE_SETTINGS,
		piVersion,
		providerSettings: settingsFingerprint(readProviderModels(provider), cli),
		mux: "tmux",
		parentMode: "interactive",
		deadlineMs: SCENARIO_DEADLINE_MS,
		maxAttempts: MAX_ATTEMPTS,
		// Only a scenario that loads extra parent tools adds the field, so the settings
		// hash of every other scenario stays equal to T04's.
		...(scenario.parentTools ? { parentTools: scenario.parentTools } : {}),
	};
	const key = sampleKey({
		checkoutRevision: checkout.commit,
		fixtureHash: hashFiles([scenario.dir], scenario.dir),
		harnessHash: harnessHash(),
		model: cli.model,
		thinking: cli.thinking,
		settingsHash: sha256(canonicalJson(settings)),
		scenario: scenario.name,
		rep: cli.rep,
	});
	if (cli.plan) {
		console.log(JSON.stringify({ key, file: sampleFileName(key) }));
		return;
	}
	mkdirSync(cli.outDir, { recursive: true, mode: 0o700 });
	const samplePath = join(cli.outDir, sampleFileName(key));
	const markerPath = `${samplePath}.claim`;
	const readSample = () =>
		existsSync(samplePath) ? readFileSync(samplePath, "utf8") : null;
	const claim = acquireClaim(markerPath);
	if ("busy" in claim) throw new BenchError(`${samplePath}: ${claim.busy}`);
	cleanups.add(() => releaseClaim(markerPath, claim.token));
	// Decided under the claim, so no other job can publish between this check and our write.
	const decision = rerunDecision(readSample(), key);
	if (decision.action === "skip") {
		releaseClaim(markerPath, claim.token);
		console.log(`skip ${samplePath}: ${decision.reason}`);
		return;
	}
	console.log(`run ${samplePath}: ${decision.reason}`);
	const startedAt = new Date().toISOString();
	const attempts = [];
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const result = await runAttempt({
			cli,
			scenario,
			attempt,
			checkout,
			deadlineMs: SCENARIO_DEADLINE_MS,
			loginMarginMs: LOGIN_MARGIN_MS,
			probePath: join(BENCH_DIR, "load-probe.ts"),
			// --keep-sessions: session files and run folders next to the record, for a hand check.
			keepDir: cli.keepSessions
				? join(cli.outDir, "sessions", sampleFileName(key).replace(/\.json$/, ""))
				: null,
		});
		attempts.push(result);
		if (result.kind !== "provider-error") break;
	}
	const last = attempts.at(-1);
	const record = sealRecord({
		schema: RECORD_SCHEMA,
		key,
		keyId: sampleKeyId(key),
		outcome: last.kind === "verdict" ? "verdict" : "infra-failure",
		verdict: last.kind === "verdict" ? last.verdict : null,
		infraReason:
			last.kind === "verdict"
				? null
				: last.kind === "provider-error"
					? "provider error after one retry"
					: last.infraReason,
		answer: {
			expected: scenario.expectedFacts ?? scenario.expectedAnswer,
			observed: last.answer ?? null,
		},
		attemptCount: attempts.length,
		wallTimeMs: last.wallTimeMs ?? null,
		final: {
			parent: last.parent?.all ?? null,
			parentConversation: last.parent?.conversation ?? null,
			parentToolAttributed: last.parent?.toolAttributed ?? null,
			childRoles: last.children?.roles ?? null,
			childCost: last.children?.cost ?? null,
			// Outcome classes, transfers, extra copies and undelivered results, by run id.
			delivery: last.delivery ?? null,
			// Held-out test and fixture test checksums of a scenario with a workspace oracle.
			workspace: last.workspace ?? null,
		},
		allAttempts: sumAttempts(attempts),
		checkout: { path: cli.checkout, commit: checkout.commit },
		piVersion,
		settings,
		model: cli.model,
		thinking: cli.thinking,
		attempts,
		startedAt,
		finishedAt: new Date().toISOString(),
	});
	if (!holdsClaim(markerPath, claim.token))
		throw new BenchError("lost the sample claim; record not written");
	publish(samplePath, `${JSON.stringify(record, null, 2)}\n`);
	releaseClaim(markerPath, claim.token);
	console.log(
		`wrote ${samplePath}: ${record.outcome} ${record.verdict ?? record.infraReason}, attempts ${record.attemptCount}`,
	);
}

main()
	.catch((error) => {
		// Own errors carry a safe message; anything else prints only its class or code.
		console.error(
			error instanceof BenchError
				? error.message
				: `unexpected error: ${error?.code ?? error?.name ?? "unknown"}`,
		);
		process.exitCode = 1;
	})
	.finally(() => cleanups.runAll());
