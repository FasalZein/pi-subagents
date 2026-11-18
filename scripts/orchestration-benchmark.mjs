#!/usr/bin/env node
/**
 * Orchestration benchmark launcher: runs one sample and writes one JSON record.
 *
 *   PI_SUBAGENT_LIVE_MODEL=<provider/model[:thinking]> node scripts/orchestration-benchmark.mjs \\
 *     --checkout <dir> --scenario <name> --rep <n> [--thinking <level>] [--out <dir>]
 *
 * The model comes only from the environment, so no model ref lands in the repository.
 * A sample file with a valid checksum and a verdict is final; a rerun does nothing.
 * Only a sample that ended without a verdict for an infrastructure reason runs again.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { listJsonlFiles, parseJsonl } from "./live-test-common.mjs";
import {
	endsWithProviderError,
	findParentAnswer,
	RECORD_SCHEMA,
	rerunDecision,
	sampleFileName,
	sampleKey,
	sampleKeyId,
	sealRecord,
	sha256,
	summarizeChildren,
	summarizeParent,
} from "./orchestration-benchmark/record.mjs";
import {
	checkLoginLifetime,
	hashFiles,
	prepareSampleHome,
	SAMPLE_SETTINGS,
	settingsHash,
} from "./orchestration-benchmark/sample-home.mjs";
import {
	isAlive,
	pressEnter,
	readScreen,
	shellQuote,
	startParent,
	stopServer,
	typeText,
} from "./orchestration-benchmark/tmux-parent.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
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
const STARTUP_TIMEOUT_MS = 60_000;
const SUBMIT_TIMEOUT_MS = 30_000;
// Pi writes the session file when the first reply starts, so one Enter gets this long to show up.
const ENTER_SETTLE_MS = 10_000;
// G2.1: a sample has a 10-minute deadline without user input.
const SCENARIO_DEADLINE_MS = 10 * 60_000;
const PROVIDER_ERROR_SETTLE_MS = 10_000;
const POLL_MS = 1_000;
const LOGIN_MARGIN_MS = 30 * 60_000;
const SCREEN_TAIL_CHARS = 1_500;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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
		throw new Error("set PI_SUBAGENT_LIVE_MODEL=<provider/model[:thinking]>");
	if (!values.checkout || !values.scenario || !values.rep)
		throw new Error("--checkout, --scenario and --rep are required");
	const rep = Number(values.rep);
	if (!Number.isInteger(rep) || rep < 1)
		throw new Error("--rep must be a positive integer");
	const suffix = live.slice(live.lastIndexOf(":") + 1);
	const hasSuffix = live.includes(":") && THINKING_LEVELS.includes(suffix);
	const model = hasSuffix ? live.slice(0, live.lastIndexOf(":")) : live;
	const thinking = values.thinking ?? (hasSuffix ? suffix : undefined);
	if (!thinking || !THINKING_LEVELS.includes(thinking)) {
		throw new Error(
			`set a thinking level (${THINKING_LEVELS.join(", ")}) with a model suffix or --thinking`,
		);
	}
	if (!/^[\w.-]+$/.test(values.scenario))
		throw new Error("--scenario must be a plain name");
	return {
		checkout: realpathSync(resolve(values.checkout)),
		scenario: values.scenario,
		rep,
		model,
		thinking,
		out: values.out,
	};
}

function git(dir, args) {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/** Commit of the checkout, plus a hash of uncommitted changes when there are any. */
function checkoutRevision(dir) {
	const commit = git(dir, ["rev-parse", "HEAD"]);
	const status = git(dir, ["status", "--porcelain", "--untracked-files=no"]);
	if (!status) return { commit, revision: commit, dirty: false };
	const diff = execFileSync("git", ["-C", dir, "diff", "HEAD"], {
		encoding: "utf8",
	});
	return {
		commit,
		revision: `${commit}+dirty-${sha256(diff).slice(0, 16)}`,
		dirty: true,
	};
}

async function loadScenario(name) {
	const dir = join(BENCH_DIR, "scenarios", name);
	if (!existsSync(join(dir, "scenario.mjs")))
		throw new Error(`unknown scenario ${name}`);
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

function harnessHash() {
	const parts = [
		"record.mjs",
		"sample-home.mjs",
		"tmux-parent.mjs",
		"load-probe.ts",
	];
	const files = [
		"orchestration-benchmark.mjs",
		"live-test-common.mjs",
		...parts.map((part) => join("orchestration-benchmark", part)),
	];
	return hashFiles(
		files.map((file) => join(SCRIPTS_DIR, file)),
		SCRIPTS_DIR,
	);
}

function writeAtomic(path, text) {
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, text);
	renameSync(temporary, path);
}

function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** A marker left by a job that crashed names its private tmux server and temp root; clear both. */
function reconcileRunningMarker(markerPath) {
	if (!existsSync(markerPath)) return;
	const marker = JSON.parse(readFileSync(markerPath, "utf8"));
	if (processAlive(marker.pid))
		throw new Error(`another job runs this sample (pid ${marker.pid})`);
	if (marker.socket) stopServer(marker.socket);
	if (marker.root) rmSync(marker.root, { recursive: true, force: true });
	rmSync(markerPath, { force: true });
}

function findParentSession(sessionDir, prompt) {
	for (const file of listJsonlFiles(sessionDir)) {
		const events = parseJsonl(file);
		const isChild = events.some(
			(e) =>
				e?.type === "custom" && e.customType === "pi-subagents_launch_metadata",
		);
		const hasPrompt = events.some(
			(e) =>
				e?.type === "message" &&
				e.message?.role === "user" &&
				userText(e.message).includes(prompt),
		);
		if (!isChild && hasPrompt) return { file, events };
	}
	return null;
}

function userText(message) {
	if (typeof message.content === "string") return message.content;
	return (message.content ?? [])
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
}

function readProbes(probeDir) {
	if (!existsSync(probeDir)) return [];
	return readdirSync(probeDir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => JSON.parse(readFileSync(join(probeDir, name), "utf8")));
}

function loadedCheckout(probes, checkout) {
	const inCheckout = (path) => path.startsWith(`${checkout}/`);
	const parent = probes
		.filter((probe) => !probe.agent)
		.map((probe) => probe.extensions);
	const children = probes
		.filter((probe) => probe.agent)
		.map((probe) => ({ agent: probe.agent, extensions: probe.extensions }));
	return {
		checkout,
		parent,
		children,
		parentLoadedCheckout: parent.length === 1 && parent[0].some(inCheckout),
		childrenLoadedCheckout:
			children.length > 0 &&
			children.every((child) => child.extensions.some(inCheckout)),
	};
}

async function waitFor(predicate, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = predicate();
		if (value) return value;
		await sleep(POLL_MS / 2);
	}
	return null;
}

/** Run one attempt. Returns its result: a verdict, a provider error or an infrastructure failure. */
async function runAttempt({ cli, scenario, attempt, markerPath }) {
	const home = prepareSampleHome({
		scenario,
		model: cli.model,
		thinking: cli.thinking,
		probePath: join(BENCH_DIR, "load-probe.ts"),
	});
	const socket = join(home.root, "tmux.sock");
	writeAtomic(
		markerPath,
		JSON.stringify({ pid: process.pid, socket, root: home.root, attempt }),
	);
	const env = {
		HOME: home.home,
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		TERM: "xterm-256color",
		LANG: process.env.LANG ?? "en_US.UTF-8",
		USER: process.env.USER ?? "bench",
		SHELL: "/bin/sh",
		TMPDIR: process.env.TMPDIR ?? "/tmp",
		PI_CODING_AGENT_DIR: home.agentDir,
		PI_ARTIFACT_PROJECT_ROOT: home.artifactsDir,
		PI_BENCH_PROBE_DIR: home.probeDir,
		PI_SUBAGENT_MUX: "tmux",
	};
	const command = [
		"exec pi",
		"--model",
		shellQuote(cli.model),
		"--thinking",
		shellQuote(cli.thinking),
		"-e",
		shellQuote(join(cli.checkout, "src", "index.ts")),
		"--session-dir",
		shellQuote(home.sessionDir),
	].join(" ");
	const result = { attempt, startedAt: new Date().toISOString() };
	let parent;
	try {
		parent = startParent({ socket, workDir: home.workDir, command, env });
		const started = await waitFor(
			() =>
				!isAlive(parent) ||
				readProbes(home.probeDir).some((probe) => !probe.agent),
			STARTUP_TIMEOUT_MS,
		);
		if (!started || !isAlive(parent)) {
			return {
				...result,
				kind: "infra",
				infraReason: started
					? "parent exited at startup"
					: "parent startup timed out",
				screen: readScreen(parent).slice(-SCREEN_TAIL_CHARS),
			};
		}
		await sleep(2_000); // let the editor take input after session_start
		// The prompt goes in after startup: a startup prompt forces synchronous child launches.
		typeText(parent, scenario.prompt);
		let submitted = null;
		for (
			let tries = 0;
			!submitted && tries < SUBMIT_TIMEOUT_MS / ENTER_SETTLE_MS;
			tries++
		) {
			pressEnter(parent);
			submitted = await waitFor(
				() => findParentSession(home.sessionDir, scenario.prompt),
				ENTER_SETTLE_MS,
			);
		}
		if (!submitted)
			return {
				...result,
				kind: "infra",
				infraReason: "prompt was not submitted",
				screen: readScreen(parent).slice(-SCREEN_TAIL_CHARS),
			};
		const promptAt = Date.now();
		let errorSince = null;
		let session = null;
		let outcome = null;
		while (!outcome) {
			await sleep(POLL_MS);
			session = findParentSession(home.sessionDir, scenario.prompt);
			const answer = session ? findParentAnswer(session.events) : null;
			if (answer !== null) {
				outcome = {
					kind: "verdict",
					verdict: answer === scenario.expectedAnswer ? "pass" : "wrong-answer",
					answer,
				};
			} else if (session && endsWithProviderError(session.events)) {
				errorSince ??= Date.now();
				if (Date.now() - errorSince >= PROVIDER_ERROR_SETTLE_MS)
					outcome = { kind: "provider-error" };
			} else if (!isAlive(parent)) {
				outcome = {
					kind: "infra",
					infraReason: "parent exited before a verdict",
				};
			} else if (Date.now() - promptAt >= SCENARIO_DEADLINE_MS) {
				outcome = { kind: "verdict", verdict: "timeout", answer: null };
			} else {
				errorSince = null;
			}
		}
		const wallTimeMs = Date.now() - promptAt;
		const childEvents = listJsonlFiles(home.sessionDir)
			.filter((file) => file !== session?.file)
			.map(parseJsonl);
		return {
			...result,
			...outcome,
			wallTimeMs,
			parent: session ? summarizeParent(session.events) : null,
			children: summarizeChildren(childEvents),
			loaded: loadedCheckout(readProbes(home.probeDir), cli.checkout),
			screen:
				outcome.kind === "verdict" && outcome.verdict === "pass"
					? undefined
					: readScreen(parent).slice(-SCREEN_TAIL_CHARS),
		};
	} finally {
		stopServer(socket);
		if (process.env.PI_BENCH_KEEP_TMP === "1")
			console.error(`kept temp root: ${home.root}`);
		else rmSync(home.root, { recursive: true, force: true });
	}
}

async function main() {
	const cli = parseCli();
	const scenario = await loadScenario(cli.scenario);
	if (
		!existsSync(join(cli.checkout, "src", "index.ts")) ||
		!existsSync(join(cli.checkout, "node_modules"))
	) {
		throw new Error("--checkout needs src/index.ts and installed node_modules");
	}
	const checkout = checkoutRevision(cli.checkout);
	const settings = {
		pi: SAMPLE_SETTINGS,
		mux: "tmux",
		parentMode: "interactive",
		deadlineMs: SCENARIO_DEADLINE_MS,
		maxAttempts: MAX_ATTEMPTS,
	};
	const key = sampleKey({
		checkoutRevision: checkout.revision,
		fixtureHash: hashFiles([scenario.dir], scenario.dir),
		harnessHash: harnessHash(),
		model: cli.model,
		thinking: cli.thinking,
		settingsHash: settingsHash(settings),
		scenario: scenario.name,
		rep: cli.rep,
	});
	mkdirSync(cli.out, { recursive: true });
	const samplePath = join(cli.out, sampleFileName(key));
	const decision = rerunDecision(
		existsSync(samplePath) ? readFileSync(samplePath, "utf8") : null,
		key,
	);
	if (decision.action === "skip") {
		console.log(`skip ${samplePath}: ${decision.reason}`);
		return;
	}
	console.log(`run ${samplePath}: ${decision.reason}`);
	const markerPath = `${samplePath}.running`;
	reconcileRunningMarker(markerPath);
	const provider = cli.model.split("/")[0];
	checkLoginLifetime(provider, LOGIN_MARGIN_MS);
	const piVersion = execFileSync("pi", ["--version"], {
		encoding: "utf8",
	}).trim();
	const startedAt = new Date().toISOString();
	const attempts = [];
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const result = await runAttempt({ cli, scenario, attempt, markerPath });
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
		parent: last.parent ?? null,
		children: last.children ?? null,
		loaded: last.loaded ?? null,
		checkout: {
			path: cli.checkout,
			commit: checkout.commit,
			dirty: checkout.dirty,
		},
		piVersion,
		settings,
		model: cli.model,
		thinking: cli.thinking,
		attempts: attempts.map(
			({
				attempt,
				startedAt: at,
				kind,
				verdict,
				infraReason,
				wallTimeMs,
				parent,
				screen,
			}) => ({
				attempt,
				startedAt: at,
				kind,
				verdict: verdict ?? null,
				infraReason: infraReason ?? null,
				wallTimeMs: wallTimeMs ?? null,
				parentCumulativeInput: parent?.cumulativeInput ?? null,
				screenTail: screen ?? null,
			}),
		),
		startedAt,
		finishedAt: new Date().toISOString(),
	});
	writeAtomic(samplePath, `${JSON.stringify(record, null, 2)}\n`);
	rmSync(markerPath, { force: true });
	console.log(
		`wrote ${samplePath}: ${record.outcome} ${record.verdict ?? record.infraReason}, attempts ${record.attemptCount}`,
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
