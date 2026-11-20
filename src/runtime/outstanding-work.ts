import type { RunningSubagent } from "../types.ts";

/** Runtime-owned work: running children plus reports awaiting a settled continuation. */
class OutstandingWork {
	private pending = new Set<string>();
	/** Settle rule only: delivered reports the parent read, released at its next idle settle. */
	private consumed = new Set<string>();
	/** True while the connected reporter follows the cf6dbf4 settle rule (old Herdr, D11). */
	private releaseAfterSettle = false;
	private listener?: () => void;
	/** Registry changes, including resume/adoption and clear, share one notification boundary. */
	readonly running = new RunningWorkMap(() => this.listener?.());

	/** Subscribe for the lifetime of the owning session. */
	subscribe(listener: () => void): () => void {
		this.listener = listener;
		return () => { if (this.listener === listener) this.listener = undefined; };
	}

	/** Count each logical delegation once; foreign verified-run observers own no work. */
	get count(): number {
		const ids = new Set(this.pending);
		for (const running of this.running.values()) {
			if (!running.verifiedRunCancelDenied) ids.add(running.id);
		}
		return ids.size;
	}

	delivery(id: string, send: () => void): void {
		// No consumer means no reporting state to retain (headless/non-Herdr).
		if (!this.listener) { send(); return; }
		this.pending.add(id);
		this.listener();
		try { send(); } catch (error) {
			this.pending.delete(id);
			this.consumed.delete(id);
			this.listener?.();
			throw error;
		}
	}

	/**
	 * A wait returned these reports or a committed message carries them: they are delivered (D15),
	 * so each lease ends now, once by id. A second copy of a run releases nothing.
	 */
	release(...ids: string[]): void {
		let released = false;
		for (const id of ids) {
			this.consumed.delete(id);
			released = this.pending.delete(id) || released;
		}
		if (released) this.listener?.();
	}

	/** Choose the release rule of the connected reporter: on delivery (D30) or after an idle settle (D11). */
	useSettleRule(on: boolean): void {
		this.releaseAfterSettle = on;
	}

	/**
	 * A committed message carries these reports. Under the delivery rule each lease ends now (D30);
	 * under the settle rule the lease is kept until the parent reads the report and settles idle.
	 */
	committed(...ids: string[]): void {
		if (!this.releaseAfterSettle) this.release(...ids);
	}

	/** Settle rule: mark reports present at the model-context boundary, without releasing their leases yet. */
	consume(ids: readonly string[]): void {
		if (!this.releaseAfterSettle) return;
		for (const id of ids) if (this.pending.has(id)) this.consumed.add(id);
	}

	/** Settle rule: release the reports that the just-settled idle parent continuation read. */
	settle(): void {
		if (this.consumed.size === 0) return;
		for (const id of this.consumed) this.pending.delete(id);
		this.consumed.clear();
		this.listener?.();
	}

	/** Discard session-scoped delivery bookkeeping at shutdown. */
	reset(): void {
		this.pending.clear();
		this.consumed.clear();
		this.releaseAfterSettle = false;
	}
}

class RunningWorkMap extends Map<string, RunningSubagent> {
	private changed: () => void;
	constructor(changed: () => void) { super(); this.changed = changed; }
	override set(id: string, running: RunningSubagent): this {
		super.set(id, running);
		this.changed();
		return this;
	}
	override delete(id: string): boolean {
		const removed = super.delete(id);
		if (removed) this.changed();
		return removed;
	}
	override clear(): void {
		super.clear();
		this.changed();
	}
}

/** The same module-owned registry is shared by every launch, watcher and resume path. */
export const outstandingWork = new OutstandingWork();
