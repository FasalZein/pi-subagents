import type { RunningSubagent } from "../types.ts";

/** Runtime-owned work: running children plus reports awaiting a settled continuation. */
class OutstandingWork {
	private pending = new Set<string>();
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
		for (const id of ids) released = this.pending.delete(id) || released;
		if (released) this.listener?.();
	}

	/** Discard session-scoped delivery bookkeeping at shutdown. */
	reset(): void {
		this.pending.clear();
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
