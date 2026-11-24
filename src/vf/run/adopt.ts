import { deliverRunEnd } from "../../runtime/delivery-queue.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveArtifactProjectRoot } from "../../artifact-storage.ts";
import { endRun } from "../../runtime/result-router.ts";
import { runningSubagents, moduleAbortController } from "../../runtime/state.ts";
import {
	claimSpawnWidthSlot,
	getSpawnWidthLimit,
	releaseSpawnWidthSlotOnCompletion,
	tryAcquireSlots,
} from "../../runtime/spawn-width.ts";
import { attachVerifiedRun, isVerifiedRunOrphaned, listVerifiedRuns, respawnVerifiedSupervisor, waitForVerifiedRunResult } from "./client.ts";
import {
	acquireVerifiedRunDeliveryLease,
	authorizedRecipientIds,
	isTerminalRunState,
	readVerifiedRunDeliveryReceipt,
	releaseVerifiedRunDeliveryLease,
	verifiedRunResultGeneration,
	writeVerifiedRunDeliveryReceipt,
	type VerifiedRunManifest,
} from "./types.ts";
import { verifiedRunsBaseDir } from "./launch.ts";
import { type RenderedVerifiedResult, verifiedRunNotice, verifiedRunToSubagentResult } from "./winner-result.ts";
import type { RunningSubagent, SubagentResult } from "../../types.ts";

/**
 * Reattach: collect verified fan-out results across parent sessions.
 *
 * Runs live in a project-scoped artifacts dir and are owned by detached
 * supervisors, so a parent that quit, reloaded, or was replaced finds them
 * again on session start: finished runs are delivered exactly once (delivery
 * lease plus receipt), live runs get a watcher registered so the result steers in when
 * the supervisor terminalizes, and orphaned runs get a replacement
 * supervisor that adopts the still-running candidates.
 */

	const adoptedRunDirs = new Set<string>();
	const noticedRunDirs = new Set<string>();

interface AdoptedRunOutcome {
	runDir: string;
	runId: string;
	action:
		| "delivered"
		| "watching"
		| "respawned"
		| "already-delivered"
		| "already-tracked"
		| "awaiting-origin"
		| "lease-held"
		| "rotated"
		| "unconfirmed"
		| "foreign";
}

export async function adoptVerifiedRuns(
	pi: Pick<ExtensionAPI, "sendMessage">,
	cwd: string,
	options: {
		sessionId?: string;
		/** Confirms the deliveryId persisted in the receiving session's transcript. */
		confirmPersisted?: (deliveryId: string) => Promise<boolean>;
		/** False to deliver without triggering a model turn (print-mode `-p`
		 * sessions have no turn to trigger at startup). Default true. */
		triggerTurn?: boolean;
		updateWidget?: () => void;
	} = {},
): Promise<AdoptedRunOutcome[]> {
	const outcomes: AdoptedRunOutcome[] = [];
	for (const runDir of listVerifiedRuns(verifiedRunsBaseDir(cwd))) {
		let snapshot: ReturnType<typeof attachVerifiedRun>;
		try {
			snapshot = attachVerifiedRun(runDir);
		} catch {
			continue; // foreign or unreadable entry; not ours to adopt
		}
		const { manifest } = snapshot;
		if (resolveArtifactProjectRoot(manifest.request.sourceRepo) !== resolveArtifactProjectRoot(cwd)) {
			outcomes.push({ runDir, runId: manifest.runId, action: "foreign" });
			continue;
		}
		if (isTerminalRunState(manifest.state)) {
			const sessionId = options.sessionId ?? "";
			if (readVerifiedRunDeliveryReceipt(runDir)?.sessionId === sessionId) {
				outcomes.push({ runDir, runId: manifest.runId, action: "already-delivered" });
				continue;
			}
			if (!authorizedRecipientIds(manifest).includes(sessionId)) {
				if (!noticedRunDirs.has(runDir)) {
					sendProvenanceNotice(pi, manifest, runDir, sessionId);
					noticedRunDirs.add(runDir);
				}
				outcomes.push({ runDir, runId: manifest.runId, action: "awaiting-origin" });
				continue;
			}
			// Fence against rotation: a retry between our snapshot and this
			// acquisition must not deliver the stale report.
			const lease = acquireVerifiedRunDeliveryLease(runDir, {
				sessionId,
				expectedGeneration: verifiedRunResultGeneration(manifest),
			});
			if (!lease.acquired) {
				outcomes.push({
					runDir,
					runId: manifest.runId,
					action: lease.reason === "delivered"
						? "already-delivered"
						: lease.reason === "rotated"
							? "rotated"
							: "lease-held",
				});
				continue;
			}
			const result = verifiedRunToSubagentResult(manifest, runDir, logicalChild(manifest), runStart(manifest), { parentCwd: cwd });
			const confirmed = await deliverWithReceipt(pi, manifest, result, runDir, {
				sessionId: options.sessionId ?? "",
				deliveryId: lease.deliveryId,
				confirmPersisted: options.confirmPersisted,
				triggerTurn: options.triggerTurn ?? true,
			});
			if (confirmed) {
				outcomes.push({ runDir, runId: manifest.runId, action: "delivered" });
			} else {
				// No receipt: the report may or may not have landed; release
				// our lease so another authorized session can retry, and do
				// not memoize delivery on in-process memory.
				releaseVerifiedRunDeliveryLease(runDir, { sessionId, deliveryId: lease.deliveryId });
				outcomes.push({ runDir, runId: manifest.runId, action: "unconfirmed" });
			}
			continue;
		}
		if (adoptedRunDirs.has(runDir)) {
			outcomes.push({ runDir, runId: manifest.runId, action: "already-tracked" });
			continue;
		}
		let respawned = false;
		if (isVerifiedRunOrphaned(snapshot)) {
			try {
				respawnVerifiedSupervisor(runDir);
				respawned = true;
			} catch {
				// A concurrent parent may have respawned first; the watcher below
				// still collects the result.
			}
		}
		registerAdoptedWatcher(pi, manifest, runDir, cwd, options);
		adoptedRunDirs.add(runDir);
		outcomes.push({ runDir, runId: manifest.runId, action: respawned ? "respawned" : "watching" });
	}
	return outcomes;
}

function registerAdoptedWatcher(
	pi: Pick<ExtensionAPI, "sendMessage">,
	manifest: VerifiedRunManifest,
	runDir: string,
	cwd: string,
	options: {
		sessionId?: string;
		confirmPersisted?: (deliveryId: string) => Promise<boolean>;
		triggerTurn?: boolean;
		updateWidget?: () => void;
	},
): void {
	const authorized = authorizedRecipientIds(manifest).includes(options.sessionId ?? "");
	// An authorized adopter stands in for the origin and holds the fan-out's
	// width; a non-recipient observer reserves nothing. The candidates are
	// already paid for and running, so watching without a slot when the width
	// is full stays the lesser evil — and never releases slots it did not
	// acquire.
	const acquireCount = authorized ? manifest.request.candidateCount : 0;
	const extraSlots = acquireCount > 0 ? tryAcquireSlots(acquireCount, getSpawnWidthLimit()) : null;
	const ownerSlot = extraSlots?.split(1);
	const running: RunningSubagent = {
		id: manifest.runId.slice(-8),
		parentSessionId: options.sessionId,
		name: manifest.request.name,
		task: manifest.request.taskPrompt,
		title: manifest.request.title,
		agent: manifest.request.agent,
		mode: "background",
		phase: { kind: "running" },
		parentClosePolicy: "continue",
		blocking: false,
		async: true,
		autoExit: true,
		noSession: false,
		startTime: runStart(manifest),
		sessionFile: manifest.request.candidates[0]?.sessionFile ?? "",
		verifiedRunDir: runDir,
		verifiedRunId: manifest.runId,
		verifiedRunCancelDenied: !authorizedRecipientIds(manifest).includes(options.sessionId ?? ""),
	};
	running.completionPromise = releaseSpawnWidthSlotOnCompletion(
		running,
		(async (): Promise<SubagentResult> => {
			try {
				let final: Awaited<ReturnType<typeof waitForVerifiedRunResult>>;
				try {
					final = await waitForVerifiedRunResult(runDir, {
						signal: moduleAbortController.signal,
					});
				} catch {
					// Session shutdown aborts the watch by design (parent-close
					// policy continue): the detached supervisor owns the run and
					// delivery stays on disk for the authorized recipient. This
					// catch is load-bearing — an unhandled rejection here killed
					// live `-p` sessions at exit.
					endRun(running);
					return verifiedRunNotice(
						manifest,
						runDir,
						logicalChild(manifest),
						running.startTime,
						`[llm-as-a-verifier ${manifest.runId}: this session stopped watching; ` +
							`the detached run continues and its report stays with the run (${runDir})]`,
						{ parentCwd: cwd },
					);
				}
				const result = verifiedRunToSubagentResult(final, runDir, logicalChild(manifest), running.startTime, { parentCwd: cwd });
				// D15: a closed parent takes no lease and gets no notice; the report stays with the run for
				// the next authorized adopter.
				const parentOpen = endRun(running);
				if (!parentOpen) return result;
				if (authorizedRecipientIds(final).includes(options.sessionId ?? "")) {
					const sessionId = options.sessionId ?? "";
					const lease = acquireVerifiedRunDeliveryLease(runDir, {
						sessionId,
						expectedGeneration: verifiedRunResultGeneration(final),
					});
					if (lease.acquired) {
						const confirmed = await deliverWithReceipt(pi, final, result, runDir, {
							sessionId,
							deliveryId: lease.deliveryId,
							confirmPersisted: options.confirmPersisted,
							triggerTurn: options.triggerTurn ?? true,
						});
						if (!confirmed) {
							releaseVerifiedRunDeliveryLease(runDir, { sessionId, deliveryId: lease.deliveryId });
						}
					}
				} else if (final.result?.apply?.applied && !noticedRunDirs.has(runDir)) {
					// The observer watched this run finish: it learns the winner
					// was staged in its repo, without ever seeing the report.
					sendProvenanceNotice(pi, final, runDir, options.sessionId ?? "");
					noticedRunDirs.add(runDir);
				}
				return result;
			} finally {
				extraSlots?.release();
				runningSubagents.delete(running.id);
				options.updateWidget?.();
			}
		})(),
	);
	if (ownerSlot) claimSpawnWidthSlot(running, ownerSlot);
	runningSubagents.set(running.id, running);
	options.updateWidget?.();
}

/**
 * Send first, prove persistence second: a crash before the receipt is
 * written leaves the lease reclaimable instead of stranding the result.
 */
async function deliverWithReceipt(
	pi: Pick<ExtensionAPI, "sendMessage">,
	manifest: VerifiedRunManifest,
	result: RenderedVerifiedResult,
	runDir: string,
	info: {
		sessionId: string;
		deliveryId: string;
		confirmPersisted?: (deliveryId: string) => Promise<boolean>;
		triggerTurn?: boolean;
	},
): Promise<boolean> {
	deliverVerifiedRunResult(pi, manifest, result, info.deliveryId, info.triggerTurn ?? true);
	const persisted = info.confirmPersisted ? await info.confirmPersisted(info.deliveryId) : true;
	if (persisted) {
		try {
			writeVerifiedRunDeliveryReceipt(runDir, { sessionId: info.sessionId, deliveryId: info.deliveryId });
		} catch {
			// The result rotated or another writer proved delivery first.
			return false;
		}
	}
	return persisted;
}

function deliverVerifiedRunResult(
	pi: Pick<ExtensionAPI, "sendMessage">,
	manifest: VerifiedRunManifest,
	result: RenderedVerifiedResult,
	deliveryId: string,
	triggerTurn: boolean,
): void {
	const selection = manifest.result?.selection ?? null;
	deliverRunEnd(
		pi,
		manifest.runId.slice(-8),
		{
			customType: "subagent_result",
			// D14 and D18: the renderer's text; the delivery id stays in the details.
			content: result.resultText,
			display: true,
			details: {
				id: manifest.runId.slice(-8),
				name: manifest.request.name,
				task: manifest.request.taskPrompt,
				agent: manifest.request.agent,
				mode: "background",
				status: manifest.state === "completed" ? "completed" : "failed",
				deliveryState: "detached",
				parentClosePolicy: "continue",
				async: true,
				exitCode: result.exitCode,
				elapsed: result.elapsed,
				sessionFile: selection?.winnerSessionFile ?? manifest.request.candidates[0]?.sessionFile,
				verifiedRunId: manifest.runId,
				deliveryId,
				...(result.resultRunId ? { runId: result.resultRunId } : {}),
				...(result.resultOutcome ? { outcome: result.resultOutcome } : {}),
				...(result.resultEndedBy ? { endedBy: result.resultEndedBy } : {}),
				...(result.reportFile ? { reportFile: result.reportFile } : {}),
				errorMessage: result.errorMessage,
			},
		},
		{ triggerTurn },
	);
}

/**
 * A non-recipient session sharing this repo must never be surprised by
 * staged changes: send a terse, no-turn provenance note (never the winner
 * report) whenever an applied winner exists and this session did not
 * receive the delivery itself.
 */
function sendProvenanceNotice(
	pi: Pick<ExtensionAPI, "sendMessage">,
	manifest: VerifiedRunManifest,
	runDir: string,
	sessionId: string,
): void {
	if (!manifest.result?.apply?.applied) return;
	pi.sendMessage(
		{
			customType: "subagent_result",
			content:
				`[llm-as-a-verifier ${manifest.runId}] A detached supervisor staged this run's winner in this repository ` +
				`(origin session ${manifest.request.parentSessionId ?? "unknown"}; this session is not a recipient). ` +
				`Inspect \`git diff --staged\`. The report and ranking stay with the run: ${runDir}`,
			display: true,
			details: {
				provenance: true,
				id: manifest.runId.slice(-8),
				verifiedRunId: manifest.runId,
				sessionId,
			},
		},
		{ triggerTurn: false, deliverAs: "steer" },
	);
}

/** The logical child the fan-out stands for: its tool name and task. */
function logicalChild(manifest: VerifiedRunManifest): { name: string; task: string } {
	return { name: manifest.request.name, task: manifest.request.taskPrompt };
}

function runStart(manifest: VerifiedRunManifest): number {
	return Date.parse(manifest.createdAt) || Date.now();
}
