/**
 * One attempt of a sample: a registered private root, an interactive parent in a
 * private tmux server that gets its prompt after startup, then a classified
 * result built from the session evidence. The root is removed on every exit path.
 */
import {
	cpSync,
	existsSync,
	lstatSync,
	readFileSync,
	statSync,
} from "node:fs";
import { join, relative } from "node:path";
import { parentToolNames } from "./candidate-evidence.mjs";
import { deliveryAccounting, launchedRuns } from "./delivery.mjs";
import {
	answerParser,
	childEnded,
	childFulfils,
	endsWithProviderError,
	loadEvidence,
	scoreAttempt,
	summarizeChild,
	summarizeChildren,
	summarizeParent,
	terminalAnswer,
} from "./record.mjs";
import { checkoutState, cleanups } from "./run-state.mjs";
import {
	createAttemptRoot,
	prepareSampleHome,
	removeAttemptRoot,
	socketPath,
} from "./sample-home.mjs";
import {
	collectEvidence,
	liveEntries,
	parseJsonlStrict,
	readProbes,
} from "./session-evidence.mjs";
import {
	isAlive,
	pressEnter,
	shellQuote,
	startParent,
	stopServer,
	typeText,
} from "./tmux-parent.mjs";

const STARTUP_TIMEOUT_MS = 60_000;
const SUBMIT_TIMEOUT_MS = 30_000;
// Pi writes the session file when the first reply starts, so one Enter gets this long to show up.
const ENTER_SETTLE_MS = 10_000;
const PROVIDER_ERROR_SETTLE_MS = 10_000;
// A terminal reply without an answer counts as final after the sample is quiet this long.
const QUIET_MS = 60_000;
// A terminal reply with an answer counts as settled after the sample is quiet this long,
// so a result message that lands just after the last child ends still gets its turn.
const SETTLE_MS = 5_000;
const POLL_MS = 1_000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(predicate, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = predicate();
		if (value) return value;
		await sleep(POLL_MS / 2);
	}
	return null;
}

function parentProbe(probeDir) {
	return readProbes(probeDir).find((probe) => !probe.agent) ?? null;
}

function readEvents(file) {
	return file && existsSync(file)
		? parseJsonlStrict(readFileSync(file, "utf8")).events
		: [];
}

function userText(message) {
	if (typeof message.content === "string") return message.content;
	return (message.content ?? [])
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
}

function hasPrompt(events, prompt) {
	return events.some(
		(e) =>
			e?.type === "message" &&
			e.message?.role === "user" &&
			userText(e.message).includes(prompt),
	);
}

/** Latest modification time of any session file below the root. */
function lastActivity(root) {
	let latest = 0;
	const walk = (dir) => {
		for (const entry of liveEntries(dir)) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (path.endsWith(".jsonl"))
				latest = Math.max(
					latest,
					statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0,
				);
		}
	};
	walk(root);
	return latest;
}

// The launch tool of the extension under test; its successful results count launches.
const LAUNCH_TOOL = "subagent";

/**
 * Number of launched children that have not ended. A child counts as launched
 * from the first trace it leaves: a successful launch tool result in the parent,
 * a child probe or a child session file. A half-written probe counts as pending.
 * A resumed child (same session file) is the same child, not a new launch.
 */
function pendingChildren(parentEvents, root, probeDir) {
	let evidence;
	try {
		evidence = collectEvidence(root, probeDir);
	} catch {
		return 1;
	}
	const launchResults = parentEvents.filter(
		(e) =>
			e?.type === "message" &&
			e.message?.role === "toolResult" &&
			e.message.toolName === LAUNCH_TOOL &&
			!e.message.isError,
	).length;
	// A resumed run's probe names the session file of the child it resumes, so
	// child probes count by session file (a probe without one counts alone).
	const childProbes = evidence.probes.filter((probe) => probe.agent);
	const probedChildren =
		new Set(childProbes.map((p) => p.sessionFile).filter(Boolean)).size +
		childProbes.filter((p) => !p.sessionFile).length;
	const launched = Math.max(
		launchResults,
		probedChildren,
		evidence.children.length,
	);
	const ended = evidence.children.filter((c) => childEnded(c.events)).length;
	return launched - ended;
}

/**
 * Entry index of the parent's last assistant reply when it is terminal and no
 * carrier came after it (a result message, or a launch or wait tool result);
 * else null. A carrier after the last reply means the parent still has a model
 * request for it in flight, and silence alone does not prove it finished.
 */
export function settledReplyIndex(events) {
	let lastReply = -1;
	let lastCarrier = -1;
	events.forEach((e, index) => {
		if (e?.type === "custom_message" && e.customType === "subagent_result")
			lastCarrier = index;
		else if (e?.type === "message" && e.message?.role === "toolResult")
			lastCarrier = index;
		else if (e?.type === "message" && e.message?.role === "assistant")
			lastReply = index;
	});
	return lastReply > lastCarrier &&
		events[lastReply].message.stopReason === "stop"
		? lastReply
		: null;
}

const REAL_CLOCK = { now: () => Date.now(), sleep, alive: isAlive };

/**
 * Watch the parent from prompt submission until an outcome. Deadline is checked first.
 * @param {object} input
 * @param {{now: () => number, sleep: (ms: number) => Promise<void>, alive: (parent: object) => boolean}} [input.clock] - injected by tests
 * @param {() => void} [input.onPoll] - runs on every poll before the outcome checks
 */
export async function observe({
	parent,
	parentFile,
	root,
	probeDir,
	submittedAt,
	deadlineMs,
	parseAnswer,
	clock = REAL_CLOCK,
	onPoll = () => {},
}) {
	let errorSince = null;
	while (true) {
		await clock.sleep(POLL_MS);
		const now = clock.now();
		if (now - submittedAt >= deadlineMs)
			return { kind: "verdict", verdict: "timeout" };
		onPoll();
		const events = readEvents(parentFile);
		const { answer } = terminalAnswer(events, parseAnswer);
		const answeredAt = settledReplyIndex(events);
		// Observation ends only on a settled reply: terminal and after the last
		// carrier the parent received, the sample quiet, and no launched child
		// outstanding. A partial progress reply does not end it; the reply that is
		// last at that boundary is scored (an incomplete answer there is a wrong
		// answer). A parent that never replies after its last carrier times out.
		if (
			answeredAt !== null &&
			now - lastActivity(root) >= (answer === null ? QUIET_MS : SETTLE_MS) &&
			pendingChildren(events, root, probeDir) <= 0
		)
			return { kind: "answered", answer, answeredAt };
		if (endsWithProviderError(events)) {
			errorSince ??= now;
			if (now - errorSince >= PROVIDER_ERROR_SETTLE_MS)
				return { kind: "provider-error" };
		} else errorSince = null;
		if (!clock.alive(parent))
			return { kind: "infra", infraReason: "parent exited before a verdict" };
	}
}

/**
 * Classify a finished attempt from its evidence. Order: missing or unsound
 * evidence (infra), then any provider error in parent or child (counted retry),
 * then the verdict.
 */
export function classifyAttempt({
	observed,
	evidence,
	cli,
	scenario,
	checkoutChanged,
	workDir,
	workspace = null,
	phases = {},
}) {
	const parent = evidence.parent
		? summarizeParent(evidence.parent.events)
		: null;
	const children = summarizeChildren(
		evidence.children.map((child) => child.events),
	);
	const load = loadEvidence(evidence.probes, {
		parentFile: evidence.parent?.file ?? null,
		childFiles: evidence.children.map((child) => child.file),
		otherFiles: evidence.others,
		checkout: cli.checkout,
		parentTool: scenario.parentLoadTool,
		childTool: scenario.childLoadTool,
	});
	const metrics = { parent, children, load };
	const probed = [...load.children, ...load.resumes];
	const models = [load.parentModel, ...probed.map((c) => c.model)];
	const thinking = [load.parentThinking, ...probed.map((c) => c.thinking)];
	const infra = (infraReason) => ({ kind: "infra", infraReason, ...metrics });
	if (observed.kind === "infra") return infra(observed.infraReason);
	if (checkoutChanged) return infra("checkout changed during the attempt");
	if (!parent || evidence.parentProbes !== 1)
		return infra("parent session or probe missing");
	if (evidence.malformed > 0) return infra("malformed session lines");
	if (evidence.unattributed.length > 0)
		return infra("session file without a known owner");
	if (parent.missingUsage + children.missingUsage > 0)
		return infra("request without usage");
	if (load.missingProbes > 0) return infra("load probe missing");
	// Children join their run ids by launch name, so names must be unique (a known limit).
	const names = launchedRuns(
		evidence.parent.events,
		scenario.parentLoadTool,
		evidence.runFolders,
	)
		.map((run) => run.name)
		.filter(Boolean);
	// On the candidate a repeated launch name is a parent that ran work twice: a
	// counted failure (scoreAttempt). v2.9.2 keeps the T04 contract (infra).
	const repeatedLaunch = new Set(names).size !== names.length;
	if (repeatedLaunch && !scenario.release?.candidate)
		return infra("two launched children share a launch name");
	// A deadline timeout stays a timeout (G2.1): a child that started but never
	// got its task has a probe and no session file, which is measured behaviour.
	const timedOut =
		observed.kind === "verdict" && observed.verdict === "timeout";
	if (load.unmatchedProbes - (timedOut ? load.unfiledProbes : 0) > 0)
		return infra("probe without its session file");
	if (!load.parentLoadedCheckout || !load.childrenLoadedCheckout)
		return infra("extension did not load from the checkout");
	if (
		models.some((m) => m !== cli.model) ||
		thinking.some((t) => t !== cli.thinking)
	)
		return infra("model or thinking differs from the request");
	if (
		observed.kind === "provider-error" ||
		parent.errorRequests + children.errorRequests > 0
	) {
		return { kind: "provider-error", ...metrics };
	}
	// A child of a role without a declared result can never support a pass.
	const childFacts = evidence.children.map((child) => {
		const summary = summarizeChild(child.events);
		const contract = scenario.childResults[summary?.role];
		// Phase facts: the workspace as the first poll after the child ended saw it.
		const gate = scenario.phaseGates?.[summary?.role];
		const phaseFacts = phases[child.file] ?? null;
		const phase =
			!gate ||
			(phaseFacts !== null &&
				Object.entries(gate).every(
					([key, value]) => phaseFacts[key] === value,
				));
		return {
			name: summary?.name ?? null,
			role: summary?.role ?? null,
			contract,
			ended: childEnded(child.events),
			phaseFacts,
			fulfils: {
				...(contract
					? childFulfils(child.events, contract, workDir)
					: { read: false, returned: false }),
				phase,
			},
		};
	});
	// A result counts as delivered only when it reached the parent by the child's own run id.
	const delivery = deliveryAccounting({
		parentEvents: evidence.parent.events,
		children: childFacts,
		// The observer's scored reply; a timeout scored none, so nothing was available to it.
		answeredAt: observed.kind === "answered" ? observed.answeredAt : null,
		scenario,
		workDir,
		runFolders: evidence.runFolders,
	});
	const childOutcomes = childFacts.map((child, index) => ({
		...child.fulfils,
		phaseFacts: child.phaseFacts,
		delivered: delivery.runs[index].delivered,
	}));
	if (observed.kind === "verdict")
		return {
			kind: "verdict",
			verdict: observed.verdict,
			answer: null,
			delivery,
			...metrics,
		};
	const verdict = scoreAttempt({
		answer: observed.answer,
		childRoles: children.roles,
		parentTools: parentToolNames(
			evidence.parent.events,
			evidence.runFolders,
			workDir,
		),
		workflowScript: delivery.workflowScript,
		repeatedLaunch,
		childOutcomes,
		workspace,
		handoffInOrder: delivery.handoffInOrder,
		scenario,
	});
	return {
		kind: "verdict",
		verdict,
		answer: observed.answer,
		childOutcomes,
		workspace,
		delivery,
		...metrics,
	};
}

function sanitize(result) {
	// Keep counts and classified reasons only: no message text enters the record.
	const { parent, children, load, ...rest } = result;
	return {
		...rest,
		parent: parent ?? null,
		children: children ?? null,
		load: load ?? null,
	};
}

// Files a kept copy holds: session files and the run folders' record and launch
// files. Credentials, settings and the workspace stay out.
// Known evidence paths only: session files below sessions/ and the record and
// launch files of run folders below artifacts/. Credentials, settings, the
// workspace and every symbolic link stay out.
const KEPT_DIRS = /^(sessions|artifacts)(\/|$)/;
const KEPT_FILES = [
	/^sessions\/.+\.jsonl$/,
	/^artifacts\/.+\/results\/[^/]+\/(record|launch)\.json$/,
];

/**
 * Copy the evidence of an attempt before cleanup (launcher --keep-sessions), so
 * the delivery accounting can be checked by hand against the sessions.
 */
export function keepEvidence(root, dest) {
	// A debugging copy never decides a sample: a file that vanishes mid-copy is reported.
	try {
		cpSync(root, dest, {
			recursive: true,
			filter: (source) => {
				const path = relative(root, source);
				if (path === "") return true;
				const stat = lstatSync(source, { throwIfNoEntry: false });
				if (!stat || stat.isSymbolicLink()) return false;
				if (stat.isDirectory()) return KEPT_DIRS.test(path);
				return stat.isFile() && KEPT_FILES.some((pattern) => pattern.test(path));
			},
		});
	} catch (error) {
		console.error(`kept copy incomplete: ${error?.code ?? error?.name ?? "unknown"}`);
	}
}

/** @returns {Promise<object>} a sanitized attempt result */
export async function runAttempt({
	cli,
	scenario,
	attempt,
	checkout,
	deadlineMs,
	loginMarginMs,
	probePath,
	keepDir = null,
}) {
	const root = createAttemptRoot();
	const socket = socketPath(root);
	const cleanup = () => {
		stopServer(socket);
		if (keepDir) keepEvidence(root, join(keepDir, `attempt-${attempt}`));
		removeAttemptRoot(root);
	};
	const unregister = cleanups.add(cleanup);
	const base = { attempt, startedAt: new Date().toISOString() };
	try {
		const home = prepareSampleHome(root, {
			scenario,
			model: cli.model,
			thinking: cli.thinking,
			probePath,
			provider: cli.model.split("/")[0],
			loginMarginMs,
		});
		const env = {
			HOME: home.home,
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			TERM: "xterm-256color",
			LANG: process.env.LANG ?? "en_US.UTF-8",
			USER: process.env.USER ?? "bench",
			SHELL: "/bin/sh",
			TMPDIR: home.tmpDir,
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
			// A workflow scenario (candidate arm of (b)) activates Pi's built-in codemode tool.
			...(scenario.parentTools
				? ["--tools", shellQuote(scenario.parentTools)]
				: []),
			"--session-dir",
			shellQuote(home.sessionDir),
		].join(" ");
		const parent = startParent({ socket, workDir: home.workDir, command, env });
		const probe = await waitFor(
			() => !isAlive(parent) || parentProbe(home.probeDir),
			STARTUP_TIMEOUT_MS,
		);
		if (!probe || !isAlive(parent)) {
			return sanitize({
				...base,
				kind: "infra",
				infraReason: probe
					? "parent exited at startup"
					: "parent startup timed out",
			});
		}
		const parentFile = parentProbe(home.probeDir).sessionFile;
		await sleep(2_000); // let the editor take input after session_start
		// The prompt goes in after startup: a startup prompt forces synchronous child launches.
		typeText(parent, scenario.prompt);
		const submittedAt = Date.now();
		let submitted = false;
		for (
			let tries = 0;
			!submitted && tries < SUBMIT_TIMEOUT_MS / ENTER_SETTLE_MS;
			tries++
		) {
			pressEnter(parent);
			submitted = Boolean(
				await waitFor(
					() => hasPrompt(readEvents(parentFile), scenario.prompt),
					ENTER_SETTLE_MS,
				),
			);
		}
		if (!submitted)
			return sanitize({
				...base,
				kind: "infra",
				infraReason: "prompt was not submitted",
			});
		// Phase facts per child session file, taken on the first poll that sees the
		// child ended. Limit: they show the workspace up to one poll later; a next
		// child that edits within that time would blur them. Serial handoff keeps
		// the next writer behind a full review run in scenario review-fix.
		const phases = {};
		const onPoll = () => {
			if (!scenario.inspectPhase) return;
			let evidence;
			try {
				evidence = collectEvidence(root, home.probeDir);
			} catch {
				return; // a half-written line: the next poll retries
			}
			for (const child of evidence.children)
				if (!(child.file in phases) && childEnded(child.events))
					phases[child.file] = scenario.inspectPhase(home.workDir);
		};
		const observed = await observe({
			parent,
			parentFile,
			root,
			probeDir: home.probeDir,
			submittedAt,
			deadlineMs,
			parseAnswer: answerParser(scenario),
			onPoll,
		});
		const wallTimeMs = Date.now() - submittedAt;
		let checkoutChanged = false;
		try {
			checkoutChanged = checkoutState(cli.checkout).commit !== checkout.commit;
		} catch {
			checkoutChanged = true;
		}
		const evidence = collectEvidence(root, home.probeDir);
		// The workspace oracle runs before cleanup removes the workspace copy.
		const workspace =
			observed.kind === "answered" && scenario.inspectWorkspace
				? scenario.inspectWorkspace(home.workDir)
				: null;
		return sanitize({
			...base,
			wallTimeMs,
			...classifyAttempt({
				observed,
				evidence,
				cli,
				scenario,
				checkoutChanged,
				workDir: home.workDir,
				workspace,
				phases,
			}),
		});
	} finally {
		cleanup();
		unregister();
	}
}
