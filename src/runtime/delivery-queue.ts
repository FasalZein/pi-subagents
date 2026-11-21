import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunningSubagent } from "../types.ts";
import { outstandingWork } from "./outstanding-work.ts";
import { groupRunEnds, isFinishedStatus, type RunEndMessage, runEndIds } from "./run-end-message.ts";

type Sink = Pick<ExtensionAPI, "sendMessage">;
/** What the queue reads of the parent session: the entries Pi committed, in append order. */
type CommittedEntries = Pick<ExtensionContext["sessionManager"], "getEntries">;
type Notices = Pick<ExtensionContext["ui"], "notify">;

/** A message that Pi commits without an extension message_end: a settle entry or a no-turn message. */
interface InFlight {
	message: RunEndMessage;
	/** The session's entry count when it was proposed or sent; its commit is an entry after this. */
	mark: number;
}

/**
 * D15: the one owner of run-end delivery to the parent. A result stays in this queue until the
 * parent session commits its message. Pi's own steer queue is editable: Alt+Up or Esc can clear
 * it, so a result enters it only at a turn boundary, right before Pi polls it, and only while it is
 * empty. All results queued at one boundary leave as one message (D15). A result that the boundary
 * did not commit is handed over again at the next boundary, or at once when the parent is idle.
 * Delivery is at least once.
 *
 * Two paths commit without an extension message_end: the settle entry and a no-turn message. Each
 * stays in flight until a session entry after its mark carries its run id; only then does the run
 * leave the queue and its work lease end (D30). The settle step proposes the queued results as one
 * entry and asks for one more request; when the person presses Esc during that step, Pi commits the
 * entry and starts no turn, and a result that arrives during that step leaves with no turn too, so
 * both enter the next request when the person types (D15). No result waits for the person's next
 * prompt in any other case.
 */
class DeliveryQueue {
	private pending = new Map<string, RunEndMessage>();
	/** Run ends that a running wait holds, with the sink to use when an aborted wait gives them back. */
	private held = new Map<string, Sink>();
	private inFlight = new Map<string, InFlight>();
	/** Only a registered session has boundary events; an unregistered host gets the message at once. */
	private registered = false;
	private busy = false;
	/** This run reached the settle step: an abort now came during settling. */
	private settling = false;
	private pi?: Sink;
	private session?: CommittedEntries;
	/** The parent's TUI, only when the session has one: a busy parent shows a notice there. */
	private ui?: Notices;
	/** Names of the run ends announced while busy and not handed over yet: Pi shows only the last notice. */
	private announced = new Map<string, string>();

	register(pi: ExtensionAPI): void {
		this.registered = true;
		this.pi = pi;
		pi.on("session_start", (_event, ctx) => {
			this.session = ctx.sessionManager;
		});
		pi.on("agent_start", (_event, ctx) => {
			this.session = ctx.sessionManager;
			this.ui = ctx.hasUI ? ctx.ui : undefined;
			this.confirm();
			this.busy = true;
			this.settling = false;
		});
		pi.on("message_end", (event) => this.commitIds(runEndIds(event.message)));
		pi.on("turn_end", (event, ctx) => {
			this.confirm();
			const stop = (event.message as { stopReason?: string }).stopReason;
			// An aborted or failed turn polls no steer; the settle step hands the result over.
			if (stop === "aborted" || stop === "error" || ctx.hasPendingMessages()) return;
			this.sendPending();
		});
		// An aborted run skips this step (extensions.md, lifecycle): its queued results leave when
		// agent_settled finds the parent idle.
		pi.on("agent_before_settle", (event) => {
			this.settling = true;
			const free = this.takeFree();
			if (free.length === 0) return;
			const message = groupRunEnds(free);
			this.propose(free);
			return {
				entries: [
					...event.entries,
					{
						type: "custom_message",
						customType: message.customType,
						content: message.content,
						display: true,
						details: message.details,
					},
				],
				continue: true,
			};
		});
		pi.on("agent_settled", (event) => {
			this.confirm();
			// A proposed entry that a later handler replaced, or that Pi failed to append, is queued again.
			for (const [id, entry] of this.inFlight) this.pending.set(id, entry.message);
			this.inFlight.clear();
			this.busy = false;
			const escDuringSettle = event.aborted && this.settling;
			this.settling = false;
			if (escDuringSettle) this.sendNoTurn(this.pi, this.takeFree());
			else this.sendPending();
		});
		pi.on("session_shutdown", () => {
			// A closed or replaced session gets no more deliveries (D15); results stay in their files.
			this.pending.clear();
			this.held.clear();
			this.inFlight.clear();
			this.busy = false;
			this.settling = false;
			this.session = undefined;
			this.ui = undefined;
			this.announced.clear();
		});
	}

	/**
	 * A run end that a wait holds: queued like every run end, but the wait owns it. The wait's reply
	 * takes it, or an aborted wait gives it back; no boundary hands it over before that (R4).
	 */
	hold(pi: Sink, message: RunEndMessage): void {
		this.pending.set(message.details.id, message);
		this.held.set(message.details.id, pi);
	}

	/**
	 * An aborted wait gives back every run end it took, held during the wait or queued before it
	 * (D15, T26): they leave now as one message that starts no turn, since the person stopped the
	 * turn. Pi appends it at the end of the aborted run, or at once when idle, so it enters the next
	 * request. Runs that end later start turns.
	 */
	giveBack(ids: readonly string[]): void {
		let sink: Sink | undefined;
		const messages: RunEndMessage[] = [];
		for (const id of ids) {
			const holder = this.held.get(id);
			this.held.delete(id);
			const message = this.pending.get(id);
			if (!message) continue;
			this.pending.delete(id);
			sink ??= holder;
			messages.push(message);
		}
		this.sendNoTurn(this.registered ? this.pi : sink, messages);
	}

	/** A wait that returned without these run ends (not aborted) leaves them to the boundaries. */
	unhold(ids: readonly string[]): void {
		for (const id of ids) {
			const pi = this.held.get(id);
			this.held.delete(id);
			const message = this.pending.get(id);
			if (!pi || !message) continue;
			if (!this.registered) {
				this.pending.delete(id);
				pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
			} else if (!this.busy) this.send(message, true);
		}
	}

	queuedIds(): string[] {
		return [...this.pending.keys()];
	}

	queued(id: string): RunEndMessage | undefined {
		return this.pending.get(id);
	}

	deliver(pi: Sink, message: RunEndMessage, triggerTurn: boolean): void {
		if (!this.registered) {
			pi.sendMessage(message, { triggerTurn, deliverAs: "steer" });
			return;
		}
		// A no-turn message (print-mode verified adoption, D18) commits like a give-back.
		if (!triggerTurn) {
			this.sendNoTurn(pi, [message]);
			return;
		}
		this.pending.set(message.details.id, message);
		if (!this.busy) this.send(message, true);
		else if (this.ui) {
			const { name } = message.details as { name?: unknown };
			this.announced.set(message.details.id, typeof name === "string" ? name : message.details.id);
			this.ui.notify(readyNotice([...this.announced.values()]), "info");
		}
	}

	private send(message: RunEndMessage, triggerTurn: boolean): void {
		this.pi?.sendMessage(message, { triggerTurn, deliverAs: "steer" });
	}

	/** One message that starts no turn; in a registered session it stays in flight until committed. */
	private sendNoTurn(sink: Sink | undefined, messages: RunEndMessage[]): void {
		if (!sink || messages.length === 0) return;
		if (this.registered) this.propose(messages);
		sink.sendMessage<object>(groupRunEnds(messages), { triggerTurn: false });
		// When idle, Pi appends the message at once.
		this.confirm();
	}

	/** Track messages that commit without message_end; with no session to read, they count as committed. */
	private propose(messages: readonly RunEndMessage[]): void {
		if (!this.session) {
			this.commitIds(messages.map((message) => message.details.id));
			return;
		}
		const mark = this.session.getEntries().length;
		for (const message of messages) this.inFlight.set(message.details.id, { message, mark });
	}

	/** Commit every in-flight run end that a session entry after its mark carries. */
	private confirm(): void {
		if (!this.session || this.inFlight.size === 0) return;
		const first = Math.min(...[...this.inFlight.values()].map((entry) => entry.mark));
		const committed = new Set<string>();
		this.session.getEntries().forEach((entry, index) => {
			if (index < first || entry.type !== "custom_message") return;
			for (const id of runEndIds({ role: "custom", ...entry })) {
				const flight = this.inFlight.get(id);
				if (flight && index >= flight.mark) committed.add(id);
			}
		});
		this.commitIds([...committed]);
	}

	/** The queued results that no wait holds, taken out of the queue. */
	private takeFree(): RunEndMessage[] {
		const free = [...this.pending.values()].filter((message) => !this.held.has(message.details.id));
		for (const message of free) this.pending.delete(message.details.id);
		this.announced.clear();
		return free;
	}

	/** One boundary hands every queued result that no wait holds over as one message. */
	private sendPending(): void {
		const free = [...this.pending.values()].filter((message) => !this.held.has(message.details.id));
		if (free.length === 0) return;
		this.announced.clear();
		this.pi?.sendMessage<object>(groupRunEnds(free), { triggerTurn: true, deliverAs: "steer" });
	}

	/**
	 * A committed message delivers every run end it carries, grouped or single; each lease ends once (D30),
	 * or after the parent read it and settled idle under the old-Herdr rule (D11).
	 */
	private commitIds(ids: readonly string[]): void {
		for (const id of ids) {
			this.pending.delete(id);
			this.held.delete(id);
			this.inFlight.delete(id);
			this.announced.delete(id);
		}
		if (ids.length > 0) outstandingWork.committed(...ids);
	}

	/** A wait reply carried this run end to its caller: no boundary hands it over again. */
	take(id: string): void {
		this.announced.delete(id);
		this.pending.delete(id);
		this.held.delete(id);
	}

	get size(): number {
		return this.pending.size + this.inFlight.size;
	}

	reset(): void {
		this.pending.clear();
		this.held.clear();
		this.inFlight.clear();
		this.announced.clear();
		this.registered = false;
		this.busy = false;
		this.settling = false;
		this.pi = undefined;
		this.session = undefined;
		this.ui = undefined;
	}
}

/**
 * Owner decision 2026-11-21: a busy parent tells the person which results are ready. Pi hands them
 * to the model at a later boundary; this notice is not model-visible and makes no timing claim.
 */
function readyNotice(names: readonly string[]): string {
	return names.length === 1 ? `The result of ${names[0]} is ready.` : `The results of ${names.join(", ")} are ready.`;
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
 * model (codemode discards it), so every result it holds is handed over as one message that starts
 * no turn; when Pi commits the reply anyway, the second copy is capped like every copy.
 */
export function settleWaitReply(ids: readonly string[], reported: readonly string[], signal?: AbortSignal): void {
	const returned = new Set(reported);
	const aborted = signal?.aborted;
	const givenBack: string[] = [];
	for (const id of ids) {
		if (!aborted && returned.has(id)) {
			deliveryQueue.take(id);
			outstandingWork.release(id);
		} else givenBack.push(id);
	}
	if (aborted) deliveryQueue.giveBack(givenBack);
	else deliveryQueue.unhold(givenBack);
}

/**
 * The runs whose finished report these launch or resume replies carry. A started or pending reply
 * and a wait error (interrupted, timed out) carry none, so they deliver nothing; nor does a lookup
 * copy of an end that another wait already took (D16).
 */
export function reportedRunIds(replies: readonly { details?: unknown }[]): string[] {
	return replies.flatMap((reply) => {
		const details = reply.details as { id?: unknown; status?: string; lookup?: boolean } | undefined;
		return typeof details?.id === "string" && isFinishedStatus(details.status) && details.lookup !== true
			? [details.id]
			: [];
	});
}

/**
 * Runs whose parent closed (session shutdown): their ends no longer go to the parent unless a wait
 * holds them. Keyed by the run object, so a later run that reuses the id is not closed.
 */
let parentClosed = new WeakSet<RunningSubagent>();

export function closeParentDelivery(running: RunningSubagent): void {
	parentClosed.add(running);
}

export function isParentDeliveryClosed(running: RunningSubagent): boolean {
	return parentClosed.has(running);
}

/** Forget the session-scoped queue (test isolation and runtime reset). */
export function resetDeliveryQueue(): void {
	deliveryQueue.reset();
	parentClosed = new WeakSet();
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
