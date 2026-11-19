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
			this.busy = false;
		});
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
		if (typeof details?.id === "string") this.pending.delete(details.id);
	}

	reset(): void {
		this.pending.clear();
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
	options: { triggerTurn?: boolean } = {},
): void {
	outstandingWork.delivery(id, () =>
		deliveryQueue.deliver(pi, { ...message, details: { ...message.details, id } }, options.triggerTurn ?? true),
	);
}
