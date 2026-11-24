import type { RunningSubagent } from "../types.ts";

/** Runtime-owned work: running children plus reports awaiting a settled continuation. */
class OutstandingWork {
	private pending = new Set<string>();
	/** Settle rule only: delivered reports the parent read, released at its next idle settle. */
	private consumed = new Set<string>();
	/**
	 * The release rule of the connected reporter: "delivery" (D30) or "settle" (old Herdr, cf6dbf4, D11).
	 * "starting" while the reporter connects: commits are kept in startupCommits, reads are marked, so
	 * either rule can apply once the reporter is known.
	 */
	private rule: "delivery" | "settle" | "starting" = "delivery";
	private startupCommits = new Set<string>();
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
			this.startupCommits.delete(id);
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
			this.startupCommits.delete(id);
			released = this.pending.delete(id) || released;
		}
		if (released) this.listener?.();
	}

	/** The reporter is connecting: keep early commits and reads until its release rule is known. */
	beginStartup(): void {
		this.rule = "starting";
	}

	/** Choose the release rule of the connected reporter: on delivery (D30) or after an idle settle (D11). */
	useSettleRule(on: boolean): void {
		const early = [...this.startupCommits];
		this.startupCommits.clear();
		this.rule = on ? "settle" : "delivery";
		if (!on) this.release(...early);
	}

	/** True when reads at the model-context boundary matter: settle rule or startup. */
	get tracksReads(): boolean {
		return this.rule !== "delivery";
	}

	/**
	 * A committed message carries these reports. Under the delivery rule each lease ends now (D30);
	 * under the settle rule the lease is kept until the parent reads the report and settles idle.
	 */
	committed(...ids: string[]): void {
		if (this.rule === "delivery") this.release(...ids);
		else if (this.rule === "starting") for (const id of ids) if (this.pending.has(id)) this.startupCommits.add(id);
	}

	/** Settle rule and startup: mark reports present at the model-context boundary, without releasing them yet. */
	consume(ids: readonly string[]): void {
		if (!this.tracksReads) return;
		for (const id of ids) if (this.pending.has(id)) this.consumed.add(id);
	}

	/** Settle rule and startup: release the reports that the just-settled idle parent continuation read. */
	settle(): void {
		if (this.consumed.size === 0) return;
		for (const id of this.consumed) {
			this.pending.delete(id);
			this.startupCommits.delete(id);
		}
		this.consumed.clear();
		this.listener?.();
	}

	/** Discard session-scoped delivery bookkeeping at shutdown. */
	reset(): void {
		this.pending.clear();
		this.consumed.clear();
		this.startupCommits.clear();
		this.rule = "delivery";
	}
}

class RunningWorkMap extends Map<string, RunningSubagent> {
	private changed: () => void;
	/**
	 * The owner session of each registered run id, kept after the run leaves the registry: its end
	 * still waits in the delivery queue then (the settle fold's task end asks whose it is).
	 */
	private owners = new Map<string, string | undefined>();
	constructor(changed: () => void) { super(); this.changed = changed; }
	/** The parent session that owns this run id; undefined for an unknown run or one without an owner. */
	ownerOf(id: string): string | undefined {
		return this.owners.get(id);
	}
	override set(id: string, running: RunningSubagent): this {
		super.set(id, running);
		this.owners.set(id, running.parentSessionId);
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
		this.owners.clear();
		this.changed();
	}
}

/** The same module-owned registry is shared by every launch, watcher and resume path. */
export const outstandingWork = new OutstandingWork();
