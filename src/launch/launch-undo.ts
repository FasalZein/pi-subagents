/**
 * D6: a launch registers each thing it creates as it creates it: the seeded child session file,
 * the run folder, the surface, the environment capsule. When a later step fails, the launch removes
 * them in reverse order and then reports the error. Once the child runs, the launch commits and
 * the child owns them. Spawn slots are not registered here: only the run that holds a slot
 * releases it (src/runtime/spawn-width.ts).
 */
export class LaunchUndo {
	private steps: Array<() => void> = [];

	add(step: () => void): void {
		this.steps.push(step);
	}

	/** The child started: from here on, nothing it was given is removed. */
	commit(): void {
		this.steps = [];
	}

	/** Runs every step, newest first. A failed step does not stop the others or hide the launch error. */
	undo(): void {
		const steps = this.steps.reverse();
		this.steps = [];
		for (const step of steps) {
			try {
				step();
			} catch {
				// Best effort: the launch error is the one the caller must see.
			}
		}
	}
}

/** Runs one launch; a throw undoes what it registered and is then rethrown, a return commits. */
export async function withLaunchUndo<T>(launch: (undo: LaunchUndo) => Promise<T>): Promise<T> {
	const undo = new LaunchUndo();
	try {
		const result = await launch(undo);
		undo.commit();
		return result;
	} catch (error) {
		undo.undo();
		throw error;
	}
}
