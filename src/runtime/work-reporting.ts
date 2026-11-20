import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { connectMuxWorkReporter } from "../mux.ts";
import { outstandingWork } from "./outstanding-work.ts";
import { runEndIds } from "./run-end-message.ts";

/** Optional transport for session-scoped delegated-work facts, never native agent status. */
export interface WorkReporter {
	/**
	 * True for old Herdr: a report counts until the parent read it and settled idle, as in cf6dbf4 (D11).
	 * Absent: a report counts until its result is delivered (D30).
	 */
	readonly releaseAfterSettle?: true;
	publish(count: number): Promise<void>;
	stop(): Promise<void>;
}

/** The part of the Pi session that a work reporter reads. */
export type WorkReporterSession = { mode: string; sessionManager: { getSessionFile(): string | undefined } };

/** Bind reporting to Pi lifecycle without creating resources in the extension factory. */
export function registerOutstandingWorkReporting(
	pi: ExtensionAPI,
	connect: (ctx: ExtensionContext) => Promise<WorkReporter | undefined> = connectMuxWorkReporter,
) {
	let ready: Promise<void> = Promise.resolve();
	let reporter: WorkReporter | undefined;
	let unsubscribe: (() => void) | undefined;
	let stopped = true;
	let pending: Promise<void> = Promise.resolve();

	function publish(): Promise<void> {
		// Read the current count when this serialized write runs, not when queued.
		pending = pending.then(async () => {
			if (!stopped) await reporter?.publish(outstandingWork.count);
		}).catch(() => {});
		return pending;
	}

	async function flush(): Promise<void> {
		await ready;
		await publish();
	}

	pi.on("tool_result", async () => { await flush(); });
	// D30: a run counts until the message that carries its result is committed, single or grouped.
	// D11: under the old-Herdr settle rule a commit releases nothing; reading it and an idle settle do.
	pi.on("message_end", (event) => { if (!stopped) outstandingWork.committed(...runEndIds(event.message)); });
	pi.on("context", (event) => { if (!stopped) outstandingWork.consume(event.messages.flatMap(runEndIds)); });
	pi.on("agent_settled", async (_event, ctx) => {
		if (!stopped && ctx.isIdle()) outstandingWork.settle();
		await flush();
	});

	return {
		start(ctx: ExtensionContext): Promise<void> {
			stopped = false;
			unsubscribe = outstandingWork.subscribe(() => { void publish(); });
			ready = connect(ctx).then(async (connected) => {
				if (stopped) { await connected?.stop(); return; }
				reporter = connected;
				if (!reporter) { unsubscribe?.(); outstandingWork.reset(); return; }
				outstandingWork.useSettleRule(reporter.releaseAfterSettle === true);
				await publish();
			}).catch(() => { unsubscribe?.(); outstandingWork.reset(); });
			return ready;
		},
		async stop(): Promise<void> {
			stopped = true;
			unsubscribe?.();
			unsubscribe = undefined;
			await ready;
			await pending;
			await reporter?.stop();
			reporter = undefined;
			outstandingWork.reset();
		},
	};
}
