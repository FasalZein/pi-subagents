#!/usr/bin/env node
/**
 * Orchestration benchmark launcher: runs one sample and writes one JSON record.
 *
 *   PI_SUBAGENT_LIVE_MODEL=<provider/model:thinking> node scripts/orchestration-benchmark.mjs \\
 *     --checkout <clean git checkout> --scenario <name> --rep <n> [--thinking <level>] [--out <dir>]
 *
 * The thinking level is required: as a suffix of the model ref or with --thinking.
 * The model comes only from the environment, so no model ref lands in the repository.
 * A sample file with a valid checksum and a verdict is final; a rerun does nothing.
 * Only a sample that ended without a verdict for an infrastructure reason runs again.
 * One job at a time owns a sample key (exclusive claim).
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
	BenchError,
	checkoutState,
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
const DEFAULT_OUT = join(
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
			out: { type: "string", default: DEFAULT_OUT },
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
	const out = resolve(values.out);
	if (`${out}/`.startsWith(`${REPO_ROOT}/`))
		throw new BenchError("--out must be outside the repository");
	return {
		checkout: realpathSync(resolve(values.checkout)),
		scenario: values.scenario,
		rep,
		model,
		thinking,
		out,
	};
}

async function loadScenario(name) {
	const dir = join(BENCH_DIR, "scenarios", name);
	if (!existsSync(join(dir, "scenario.mjs")))
		throw new BenchError(`unknown scenario ${name}`);
	const definition = (
		await import(pathToFileURL(join(dir, "scenario.mjs")).href)
	).default;
	return {
		...definition,
		dir,
		agentsDir: join(dir, "agents"),
		workspaceDir: join(dir, "workspace"),
	};
}

/** Hash of the launcher and its modules (tests and scenarios excluded; scenarios have their own hash). */
function harnessHash() {
	const modules = readdirSync(BENCH_DIR)
		.filter((name) => /\.(mjs|ts)$/.test(name) && !name.endsWith(".test.mjs"))
		.map((name) => join(BENCH_DIR, name));
	return hashFiles(
		[join(SCRIPTS_DIR, "orchestration-benchmark.mjs"), ...modules],
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
	const scenario = await loadScenario(cli.scenario);
	if (
		!existsSync(join(cli.checkout, "src", "index.ts")) ||
		!existsSync(join(cli.checkout, "node_modules"))
	) {
		throw new BenchError(
			"--checkout needs src/index.ts and installed node_modules",
		);
	}
	const recovered = recoverAbandonedRoots(stopServer);
	if (recovered.length)
		console.log(`removed ${recovered.length} abandoned attempt folder(s)`);
	const checkout = checkoutState(cli.checkout);
	const provider = cli.model.split("/")[0];
	const piVersion = execFileSync("pi", ["--version"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
	const settings = {
		pi: SAMPLE_SETTINGS,
		piVersion,
		providerSettings: settingsFingerprint(readProviderModels(provider)),
		mux: "tmux",
		parentMode: "interactive",
		deadlineMs: SCENARIO_DEADLINE_MS,
		maxAttempts: MAX_ATTEMPTS,
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
	mkdirSync(cli.out, { recursive: true, mode: 0o700 });
	const samplePath = join(cli.out, sampleFileName(key));
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
			expected: scenario.expectedAnswer,
			observed: last.answer ?? null,
		},
		attemptCount: attempts.length,
		wallTimeMs: last.wallTimeMs ?? null,
		final: {
			parent: last.parent?.all ?? null,
			parentConversation: last.parent?.conversation ?? null,
			childRoles: last.children?.roles ?? null,
			childCost: last.children?.cost ?? null,
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
