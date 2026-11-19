import { getArtifactProjectName, getArtifactStorageRoot } from "../../artifact-storage.ts";
import { readFileSync } from "node:fs";
import type { AgentDefaults } from "../../agents/definitions.ts";
import { buildHeadlessParentEnvSnapshot } from "../../launch/child-env.ts";
import { buildBackgroundLaunchPlan } from "../../launch/background.ts";
import { dirname, join } from "node:path";
import type { SubagentLaunchContext } from "../../launch/prep.ts";
import { runningSubagents } from "../../runtime/state.ts";
import {
	claimSpawnWidthSlot,
	getSpawnWidthLimit,
	releaseSpawnWidthSlotOnCompletion,
	type SpawnSlotLease,
	tryAcquireSlots,
} from "../../runtime/spawn-width.ts";
import { SPAWNING_TOOL_NAMES } from "../../tools/tool-names.ts";
import type { RunningSubagent, SubagentParamsInput, SubagentResult } from "../../types.ts";
import { resolveVerifiedFanOutLaunch } from "../criteria.ts";
import { resolveVerifierModel, VerifierProfileError } from "../verifier-profile.ts";
import { VerifierCriteriaError } from "../criteria.ts";
import { WorktreeError } from "../worktrees.ts";
import { candidateWorktreeBranchName, candidateWorktreeDirName, preflightWorktreeSource } from "../worktrees.ts";
import { newRunId } from "../supervisor/run-client.ts";
import { startVerifiedRun, verifiedRunDirFor, waitForVerifiedRunResult } from "./client.ts";
import {
	acquireVerifiedRunDeliveryLease,
	releaseVerifiedRunDeliveryLease,
	verifiedRunResultGeneration,
	writeVerifiedRunDeliveryReceipt,
} from "./types.ts";
import type { VerifiedCandidateSpec, VerifiedRunManifest, VerifiedRunRequest } from "./types.ts";
import { verifiedRunNotice, verifiedRunToSubagentResult } from "./winner-result.ts";

/**
 * Parent-side launch of a verified fan-out (ticket 07).
 *
 * A launch of an agent marked `llm-as-a-verifier: true` becomes ONE logical
 * child: N candidates are planned here from one resolved launch plan
 * (byte-identical prompt), spawned in isolated git worktrees by a detached
 * supervisor, ranked when they settle, and routed back as a single outcome.
 * Per-candidate steer/result routes never exist in the parent.
 */

export class VerifiedLaunchError extends Error {
	/** Machine-readable failure code (spawn_width, no-session-unsupported, ...). */
	readonly code: string;
	constructor(message: string, code: string) {
		super(message);
		this.name = "VerifiedLaunchError";
		this.code = code;
	}
}

/** Test seam mirroring the ticket-05 bridge mock; never set by production paths. */
const MOCK_VERIFIER_ENV = "PI_SUBAGENT_VF_MOCK_VERIFIER";

export function verifiedRunsBaseDir(cwd: string): string {
	return join(getArtifactStorageRoot(), getArtifactProjectName(cwd));
}

/** Force `spawning: false` normalization on a candidate env overlay. */
function denyCandidateSpawning(env: Record<string, string>): void {
	env.PI_SUBAGENT_SPAWN_BUDGET = "0";
	env.PI_SUBAGENT_SPAWNABLE = "";
	const denied = new Set((env.PI_DENY_TOOLS ?? "").split(",").filter(Boolean));
	for (const tool of SPAWNING_TOOL_NAMES) denied.add(tool);
	env.PI_DENY_TOOLS = [...denied].join(",");
}

export interface VerifiedFanOutLaunch {
	running: RunningSubagent;
	runId: string;
	runDir: string;
}

const MAX_LINEAGE_DEPTH = 8;

function readSessionHeader(file: string): { type?: unknown; id?: unknown; parentSession?: unknown } | null {
	try {
		const header = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0] ?? "");
		return typeof header === "object" && header !== null ? header : null;
	} catch {
		return null;
	}
}

/**
 * Freeze the recipient set at launch: the origin session plus every ancestor
 * reachable through session-file `parentSession` links. The walk fails
 * closed — an unreadable or missing link stops it with what it has — and a
 * visited set plus depth cap bound it. Delivery-time lineage discovery (with
 * its stale paths and full-file reads) is exactly what this avoids.
 */
export function resolveAuthorizedRecipients(
	originSessionFile: string | null | undefined,
	originSessionId: string | null,
): string[] {
	if (!originSessionId) return [];
	const recipients = [originSessionId];
	const visited = new Set<string>();
	let current = originSessionFile;
	if (current) {
		// Trust the origin file only when it is a session header naming this
		// very origin; anything else is untrusted lineage and fails closed.
		const originHeader = readSessionHeader(current);
		if (!originHeader || originHeader.type !== "session" || originHeader.id !== originSessionId) {
			return recipients;
		}
	}
	for (let depth = 0; current && depth < MAX_LINEAGE_DEPTH; depth += 1) {
		if (visited.has(current)) break;
		visited.add(current);
		const header = readSessionHeader(current);
		if (!header || typeof header.parentSession !== "string" || header.parentSession === "") break;
		const parentHeader = readSessionHeader(header.parentSession);
		if (!parentHeader || parentHeader.type !== "session" || typeof parentHeader.id !== "string") break;
		if (!recipients.includes(parentHeader.id)) recipients.push(parentHeader.id);
		current = header.parentSession;
	}
	return recipients;
}

export async function launchVerifiedFanOut(
	params: SubagentParamsInput,
	agentDefs: AgentDefaults,
	ctx: SubagentLaunchContext,
	options: { signal?: AbortSignal; awaited?: boolean; slots?: SpawnSlotLease } = {},
): Promise<VerifiedFanOutLaunch> {
	let fanout: ReturnType<typeof resolveVerifiedFanOutLaunch>;
	let verifier: ReturnType<typeof resolveVerifierModel>;
	let preflight: ReturnType<typeof preflightWorktreeSource>;
	try {
		fanout = resolveVerifiedFanOutLaunch(
			{
				llmAsVerifierCandidates: agentDefs.llmAsVerifierCandidates,
				llmAsVerifierModel: agentDefs.llmAsVerifierModel ?? undefined,
				llmAsVerifierCriteria: agentDefs.llmAsVerifierCriteria,
			},
			ctx.cwd,
		);
		verifier = resolveVerifierModel({ override: fanout.modelOverride ?? undefined, baseCwd: ctx.cwd });
		if (agentDefs.noSession) {
			throw new VerifiedLaunchError(
				`Agent ${params.agent} sets no-session: true; llm-as-a-verifier needs saved session files to rank each attempt.`,
				"no-session-unsupported",
			);
		}
		preflight = preflightWorktreeSource(ctx.cwd);
	} catch (error) {
		// Pre-flight rejections are configuration facts, not transient failures:
		// relaunching without a change cannot succeed, and fixing them usually
		// means committing/stashing the parent's own work or a user decision.
		if (
			error instanceof VerifiedLaunchError ||
			error instanceof WorktreeError ||
			error instanceof VerifierProfileError ||
			error instanceof VerifierCriteriaError
		) {
			error.message +=
				" No attempt was launched and nothing was paid. Relaunching will fail the same way. Ask the user how to proceed; do not commit, stash, or edit agent or config files on your own.";
		}
		throw error;
	}
	const runId = newRunId();
	const runDir = verifiedRunDirFor(verifiedRunsBaseDir(ctx.cwd), runId);
	const repoParent = dirname(preflight.repoRoot);

	// Slot accounting: the fan-out's N candidates consume N spawn slots,
	// reserved before any worktree creation or verifier spend. The subagent
	// tool pre-reserves the full N for verified children (one atomic batch
	// reservation) and hands that lease over; direct callers reserve here.
	// The logical child owns one slot; the outcome watcher owns the rest.
	const limit = getSpawnWidthLimit();
	const slots = options.slots ?? tryAcquireSlots(fanout.candidates, limit);
	if (!slots) {
		throw new VerifiedLaunchError(
			`llm-as-a-verifier needs ${fanout.candidates} subagent slots (limit ${limit}); running subagents hold them.`,
			"spawn_width",
		);
	}
	const ownerSlot = slots.split(1);
	let launchOwnsExtraSlots = true;

	try {
		// SPEC normalization profile: candidates are background, auto-exit,
		// non-spawning workers with durable sessions; everything else about
		// the agent definition is preserved.
		const candidateCtx: SubagentLaunchContext = { ...ctx, autoExit: true };
		const specs: VerifiedCandidateSpec[] = [];
		let frozenTaskArg: string | undefined;
		let frozenFullTask: string | undefined;
		let fullTask = "";
		let piCommand = "";
	let baseEnv: Record<string, string> | undefined;
	let denyPatterns: string[] = [];
	let modelRef: string | undefined;
	let piCommandArgs: string[] = [];
		for (let index = 1; index <= fanout.candidates; index++) {
			const worktree = join(repoParent, candidateWorktreeDirName(preflight.repoRoot, runId, index));
			const candidateParams: SubagentParamsInput = {
				...params,
				background: true,
				forcedCwd: worktree,
			};
			const plan = await buildBackgroundLaunchPlan(candidateParams, candidateCtx, {
				frozenTaskArg,
				frozenFullTask,
				spawningDenied: true,
			});
			if (index === 1) {
				frozenTaskArg = plan.taskArg;
				frozenFullTask = plan.fullTask;
				fullTask = plan.fullTask;
				piCommand = plan.invocation.command;
				// getPiInvocation builds [...prefixWords, ...args]; recover the
				// prefix so the supervisor can reconstruct the full candidate
				// command line (wrapper scripts, script-path invocations).
				const invocationArgs = plan.invocation.args;
				if (invocationArgs.slice(invocationArgs.length - plan.args.length).join("\u0000") !== plan.args.join("\u0000")) {
					throw new VerifiedLaunchError(
						"candidate invocation prefix could not be derived from the resolved pi command",
						"invocation",
					);
				}
				piCommandArgs = invocationArgs.slice(0, invocationArgs.length - plan.args.length);
				denyPatterns = plan.denyPatterns;
				modelRef = plan.launch.prepared.effectiveModelRef;
				baseEnv = buildHeadlessParentEnvSnapshot(process.env, denyPatterns);
			} else if (plan.fullTask !== fullTask) {
				throw new VerifiedLaunchError(
					`candidate ${index} prompt diverged from candidate 1 (${plan.fullTask.length} vs ${fullTask.length} chars)`,
					"prompt-drift",
				);
			}
			denyCandidateSpawning(plan.launch.envVars);
			// Ticket 08: candidate sessions are non-resumable once their run is
			// finalized; this marker lets subagent_resume fail with the precise
			// error instead of resurrecting a session in a deleted worktree.
			plan.launch.envVars.PI_SUBAGENT_VF_RUN_DIR = runDir;
			specs.push({
				index,
				sessionFile: plan.launch.prepared.subagentSessionFile,
				worktree,
				internalBranch: candidateWorktreeBranchName(runId, index),
				args: plan.args,
				env: plan.launch.envVars,
				launchEntryCount: plan.launch.launchEntryCount,
			});
		}

		const mockVerifier = process.env[MOCK_VERIFIER_ENV];
		const parentSessionId = ctx.sessionManager.getSessionId?.() ?? null;
		const request: VerifiedRunRequest = {
			kind: "verified-fanout",
			name: params.name,
			title: params.title,
			piCommand,
			piCommandArgs,
			taskArtifact: frozenTaskArg!.slice(1),
			taskPrompt: fullTask,
			sourceRepo: preflight.repoRoot,
			baseCommit: preflight.baseCommit,
			agent: params.agent,
			candidateCount: fanout.candidates,
			candidates: specs,
			verifier: {
				model: verifier.model,
				thinking: verifier.thinking,
				env: verifier.env,
				criteriaPath: fanout.criteria.path,
				...(mockVerifier !== undefined ? { mockVerifier: JSON.parse(mockVerifier) } : {}),
			},
			env: baseEnv!,
			parentSessionId,
			authorizedRecipients: resolveAuthorizedRecipients(
				ctx.sessionManager.getSessionFile?.(),
				parentSessionId,
			),
			createdAt: new Date().toISOString(),
		};

		const started = startVerifiedRun({
			baseDir: verifiedRunsBaseDir(ctx.cwd),
			runId,
			request,
		});
		launchOwnsExtraSlots = false; // ownership transferred to the completion promise

		const startTime = Date.now();
		const running: RunningSubagent = {
			id: runId.slice(-8),
			name: params.name,
			task: params.task,
			title: params.title,
			agent: params.agent,
			mode: "background",
			phase: "running",
			deliveryState: options.awaited ? "awaited" : "detached",
			parentClosePolicy: "continue",
			blocking: params.blocking ?? false,
			async: params.async ?? !(params.blocking ?? false),
			autoExit: true,
			noSession: false,
			startTime,
			sessionFile: specs[0].sessionFile,
			launchEntryCount: specs[0].launchEntryCount,
			modelRef,
			verifiedRunDir: started.runDir,
			verifiedRunId: runId,
			// The origin is a recipient; a wait admits a verified run only with this set (D18).
			verifiedRunCancelDenied: false,
		};
		const watcherAbort = new AbortController();
		running.abortController = watcherAbort;
		running.completionPromise = releaseSpawnWidthSlotOnCompletion(
			running,
			waitForVerifiedOutcome(started.runDir, runId, params, startTime, {
				signal: options.signal ?? watcherAbort.signal,
				extraSlots: slots,
				origin: {
					sessionId: parentSessionId,
					sessionFile: ctx.sessionManager.getSessionFile?.() ?? null,
					cwd: ctx.cwd,
					warnings: ctx.resultWarnings ?? [],
				},
			}),
		);
		claimSpawnWidthSlot(running, ownerSlot);
		runningSubagents.set(running.id, running);
		return { running, runId, runDir: started.runDir };
	} catch (error) {
		ownerSlot.release();
		if (launchOwnsExtraSlots) slots.release();
		throw error;
	}
}

/** The launching parent session; its working directory resolves the report locator (D14). */
interface VerifiedOrigin {
	sessionId: string | null;
	sessionFile: string | null | undefined;
	cwd: string;
	/** Launch warnings (D22 and others); the bounded rendering repeats them inside its frame. */
	warnings: readonly string[];
}

/** Poll the durable manifest; resolve ONE SubagentResult for the whole fan-out. */
async function waitForVerifiedOutcome(
	runDir: string,
	runId: string,
	params: SubagentParamsInput,
	startTime: number,
	options: {
		signal: AbortSignal;
		extraSlots: SpawnSlotLease;
		origin: VerifiedOrigin;
	},
): Promise<SubagentResult> {
	try {
		const manifest = await waitForVerifiedRunResult(runDir, { signal: options.signal });
		return deliverOnce(manifest, runDir, params, startTime, options.origin);
	} catch (error) {
		if (options.signal.aborted) {
			// The wait stopped (kill or parent shutdown), not the run: give the
			// cancel path a grace window to terminalize, then surface the state.
			const settled = await waitForVerifiedRunResult(runDir, { timeoutMs: 10_000 }).catch(() => null);
			if (settled) return deliverOnce(settled, runDir, params, startTime, options.origin);
		}
		throw error;
	} finally {
		options.extraSlots.release();
	}
}

/**
 * Deliver the run's result under the lease/receipt handshake: acquire the
 * delivery lease as the origin, tag the result with its deliveryId (the
 * steer carries it), then convert the lease into a durable receipt once the
 * deliveryId has persisted in the origin's own session file. A crash before
 * that persistence leaves the lease reclaimable — never a stranded result.
 */
function deliverOnce(
	manifest: VerifiedRunManifest,
	runDir: string,
	params: Pick<SubagentParamsInput, "name" | "task">,
	startTime: number,
	origin: VerifiedOrigin,
): SubagentResult {
	const target = { parentCwd: origin.cwd, warnings: origin.warnings };
	const result = verifiedRunToSubagentResult(manifest, runDir, params, startTime, target);
	const sessionId = origin.sessionId ?? manifest.request.parentSessionId;
	if (!sessionId) return result;
	const lease = acquireVerifiedRunDeliveryLease(runDir, {
		sessionId,
		expectedGeneration: verifiedRunResultGeneration(manifest),
	});
	if (!lease.acquired) {
		return verifiedRunNotice(
			manifest,
			runDir,
			params,
			startTime,
			`[llm-as-a-verifier ${manifest.runId}: run complete; its report was already delivered — report and ranking in ${runDir}]`,
			target,
		);
	}
	result.deliveryId = lease.deliveryId;
	watchOriginDeliveryPersisted(runDir, lease.deliveryId, sessionId, origin.sessionFile ?? undefined);
	return result;
}

/** Fire-and-forget on purpose: if this process dies before the steer
 * persists, no receipt is written and the lease stays reclaimable. */
function watchOriginDeliveryPersisted(
	runDir: string,
	deliveryId: string,
	sessionId: string,
	sessionFile: string | undefined,
): void {
	if (!sessionFile) {
		// Nothing to probe (ephemeral parent): the steer is best-effort, and
		// without a resumable file nobody can reclaim a receipt anyway.
		return;
	}
	const deadline = Date.now() + 10_000;
	const poll = (): void => {
		let persisted = false;
		try {
			persisted = readFileSync(sessionFile, "utf8").includes(deliveryId);
		} catch {
			// not flushed yet
		}
		if (persisted) {
			try {
				writeVerifiedRunDeliveryReceipt(runDir, { sessionId, deliveryId });
			} catch {
				// lost the receipt race or the result rotated: the other
				// writer proved delivery, or a retry owns the result now
			}
			return;
		}
		if (Date.now() < deadline) {
			const next = setTimeout(poll, 200);
			next.unref?.();
			return;
		}
		// Persistence never confirmed: release our lease so another
		// authorized session can retry instead of waiting for this pid to die.
		releaseVerifiedRunDeliveryLease(runDir, { sessionId, deliveryId });
	};
	const first = setTimeout(poll, 200);
	first.unref?.();
}
