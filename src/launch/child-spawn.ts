import type { ChildProcess } from "node:child_process";

/**
 * D6: spawn() returns a handle before the process exists; a missing executable
 * emits `error` afterwards. A launch hands its resources to the child only after
 * this resolves, and a rejection runs the launch undo.
 */
export function waitForChildSpawn(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		const onSpawn = () => {
			child.off("error", onError);
			resolve();
		};
		const onError = (error: Error) => {
			child.off("spawn", onSpawn);
			reject(error);
		};
		child.once("spawn", onSpawn);
		child.once("error", onError);
	});
}
