import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Opt-in diagnostic trace (PI_SUBAGENT_TRACE_LOG). Callers pass ids, reasons and sizes, never payload
 * values such as task text, prompts, summaries, typed data or ping messages; the file is owner-only.
 */
export function traceSubagentLaunch(event: string, details: Record<string, unknown>): void {
	const logPath = process.env.PI_SUBAGENT_TRACE_LOG?.trim();
	if (!logPath) return;

	try {
		mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
		appendFileSync(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`, {
			mode: 0o600,
		});
	} catch {
		// Tracing is best-effort and must never break subagent launch.
	}
}
