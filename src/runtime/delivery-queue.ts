import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { outstandingWork } from "./outstanding-work.ts";

interface RunEndMessage {
	customType: "subagent_result" | "subagent_ping";
	content: string;
	display: true;
	details: { id: string };
}

/**
 * D15: the one owner of run-end delivery to the parent. A result stays in this queue until the
 * parent session commits its message (Pi emits message_end for it). Pi's own steer queue is
 * editable: Alt+Up or Esc can clear it, so a result enters it only at a turn boundary, right
 * before Pi polls it, and one at a time while it is empty. A result that the boundary did not
 * commit is handed over again at the next boundary, or at once when the parent is idle. Delivery
 * is at least once; no result waits for the person's next prompt.
 */
class DeliveryQueue {
	private pending = new Map<string, RunEndMessage>();
	/** Run ends that a running wait holds, with the sink to use when an aborted wait gives them back. */
	private held = new Map<string, Pick<ExtensionAPI, "sendMessage">>();
	/** Only a registered session has boundary events; an unregistered host gets the message at once. */
	private registered = false;
	private busy = false;
	private pi?: Pick<ExtensionAPI, "sendMessage">;

	register(pi: ExtensionAPI): void {
		this.registered = true;
		this.pi = pi;
		pi.on("agent_start", () => {
			this.busy = true;
		});
		pi.on("message_end", (event) => this.commit(event.message));
		pi.on("turn_end", (event, ctx) => {
			const stop = (event.message as { stopReason?: string }).stopReason;
			// An aborted or failed turn polls no steer; the settle step hands the result over.
			if (stop === "aborted" || stop === "error" || ctx.hasPendingMessages()) return;
			const [next] = this.pending.values();
			if (next) this.send(next, true);
		});
		pi.on("agent_settled", () => {
			this.busy = false;
			for (const message of this.pending.values()) this.send(message, true);
		});
		pi.on("session_shutdown", () => {
			// A closed or replaced session gets no more deliveries (D15); results stay in their files.
			this.pending.clear();
			this.held.clear();
			this.busy = false;
		});
	}

	/**
	 * A run end that a wait holds: queued like every run end, but not sent at once. The wait's reply
	 * takes it, an aborted wait releases it, and a boundary that comes first hands it over.
	 */
	hold(pi: Pick<ExtensionAPI, "sendMessage">, message: RunEndMessage): void {
		this.pending.set(message.details.id, message);
		this.held.set(message.details.id, pi);
	}

	/** An aborted wait gives a held run end back: it leaves now when nothing else will send it. */
	release(id: string): void {
		const pi = this.held.get(id);
		this.held.delete(id);
		const message = this.pending.get(id);
		if (!pi || !message) return;
		if (!this.registered) {
			this.pending.delete(id);
			pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
		} else if (!this.busy) this.send(message, true);
	}

	queuedIds(): string[] {
		return [...this.pending.keys()];
	}

	queued(id: string): RunEndMessage | undefined {
		return this.pending.get(id);
	}

	deliver(pi: Pick<ExtensionAPI, "sendMessage">, message: RunEndMessage, triggerTurn: boolean): void {
		// A no-turn message (print-mode verified adoption, D18) is appended at the end of the turn
		// by Pi and never sits in the steer queue.
		if (!this.registered || !triggerTurn) {
			pi.sendMessage(message, { triggerTurn, deliverAs: "steer" });
			return;
		}
		this.pending.set(message.details.id, message);
		if (!this.busy) this.send(message, true);
	}

	private send(message: RunEndMessage, triggerTurn: boolean): void {
		this.pi?.sendMessage(message, { triggerTurn, deliverAs: "steer" });
	}

	private commit(message: unknown): void {
		if (!message || typeof message !== "object" || !("role" in message) || message.role !== "custom") return;
		const details = (message as { details?: { id?: unknown } }).details;
		if (typeof details?.id === "string") {
			this.pending.delete(details.id);
			this.held.delete(details.id);
		}
	}

	/** A wait reply carried this run end to its caller: no boundary hands it over again. */
	take(id: string): void {
		this.pending.delete(id);
		this.held.delete(id);
	}

	get size(): number {
		return this.pending.size;
	}

	reset(): void {
		this.pending.clear();
		this.held.clear();
		this.registered = false;
		this.busy = false;
		this.pi = undefined;
	}
}

const deliveryQueue = new DeliveryQueue();

/** Wire the queue to the parent session's boundaries; called once from extension wiring. */
export function registerDeliveryQueue(pi: ExtensionAPI): void {
	deliveryQueue.register(pi);
}

/** Run ends that the parent session has not committed yet. */
export function pendingRunEndCount(): number {
	return deliveryQueue.size;
}

/** A queued run end not yet committed, for a wait that starts after it was queued (an early ping). */
export function queuedRunEnd(id: string): (RunEndMessage & { details: Record<string, unknown> }) | undefined {
	return deliveryQueue.queued(id) as (RunEndMessage & { details: Record<string, unknown> }) | undefined;
}

/** Ids of the run ends not committed yet: the queued runs a wait with no ids takes (D16). */
export function queuedRunEndIds(): string[] {
	return deliveryQueue.queuedIds();
}

/**
 * D15 and R4, the one hand-over rule for waits: a run end stays in the queue until the reply of
 * the call that waited for it is returned. A returned reply delivers the results it holds: they
 * leave the queue and their lease ends once by id. An aborted call's reply may never reach the
 * model (codemode discards it), so every result it holds stays queued and is handed over as a
 * message; when Pi commits the reply anyway, the second copy is capped like every copy.
 */
export function settleWaitReply(
	ids: readonly string[],
	replies: readonly { details?: unknown }[],
	signal?: AbortSignal,
): void {
	// A wait error (interrupted, timed out) carries an error and no result.
	const returned = new Set(
		replies.flatMap((reply) => {
			const details = reply.details as { id?: unknown; error?: unknown } | undefined;
			return typeof details?.id === "string" && !details.error ? [details.id] : [];
		}),
	);
	for (const id of ids) {
		if (!signal?.aborted && returned.has(id)) {
			deliveryQueue.take(id);
			outstandingWork.release(id);
		} else deliveryQueue.release(id);
	}
}

/** Forget the session-scoped queue (test isolation and runtime reset). */
export function resetDeliveryQueue(): void {
	deliveryQueue.reset();
}

/**
 * Hand a run end to the parent. `triggerTurn: false` exists only for verified fan-out adoption
 * in a print-mode parent (D18).
 */
export function deliverRunEnd(
	pi: Pick<ExtensionAPI, "sendMessage">,
	id: string,
	message: Omit<RunEndMessage, "details"> & { details: object },
	options: { triggerTurn?: boolean; heldByWait?: boolean } = {},
): void {
	const full = { ...message, details: { ...message.details, id } };
	outstandingWork.delivery(id, () =>
		options.heldByWait ? deliveryQueue.hold(pi, full) : deliveryQueue.deliver(pi, full, options.triggerTurn ?? true),
	);
}
