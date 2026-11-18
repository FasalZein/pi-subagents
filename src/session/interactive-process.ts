export function getInteractiveProcessFile(doneSentinelFile: string): string {
	return `${doneSentinelFile}.pid`;
}

/** True when no process has this id. Permission and unknown probe failures count as alive. */
export function isProcessGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "ESRCH";
	}
}
