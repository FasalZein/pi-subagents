/**
 * D15 and D30: the shape of a run-end message in the parent session. One run end is a
 * subagent_result or subagent_ping message whose details carry its run id. All run ends handed
 * over at one turn boundary leave as one subagent_result message whose details list every
 * run end; readers expand both shapes with runEnds() and release by runEndIds().
 */
export type RunEndType = "subagent_result" | "subagent_ping";

export interface RunEndMessage {
	customType: RunEndType;
	content: string;
	display: true;
	details: { id: string };
}

/** One run end read back from a message, single or grouped. */
export interface RunEndEntry {
	customType: RunEndType;
	content: string;
	details: Record<string, unknown>;
}

interface GroupedRunEndDetails {
	ids: string[];
	results: RunEndEntry[];
}

interface GroupedRunEndMessage {
	customType: "subagent_result";
	content: string;
	display: true;
	details: GroupedRunEndDetails;
}

/** Separates the capped renderings in a grouped message; each copy keeps its own cap (D15). */
const RESULT_SEPARATOR = "\n\n";

/** One run end leaves in its own shape; several leave as one grouped subagent_result message. */
export function groupRunEnds(messages: readonly RunEndMessage[]): RunEndMessage | GroupedRunEndMessage {
	if (messages.length === 1) return messages[0];
	return {
		customType: "subagent_result",
		content: messages.map((message) => message.content).join(RESULT_SEPARATOR),
		display: true,
		details: {
			ids: messages.map((message) => message.details.id),
			results: messages.map((message) => ({
				customType: message.customType,
				content: message.content,
				details: message.details as Record<string, unknown>,
			})),
		},
	};
}

function isRunEndType(value: unknown): value is RunEndType {
	return value === "subagent_result" || value === "subagent_ping";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** The run ends a message carries: the entries of a grouped message, or the message itself. */
export function runEnds(customType: unknown, content: unknown, details: unknown): RunEndEntry[] {
	if (!isRunEndType(customType) || !isRecord(details)) return [];
	if (Array.isArray(details.results)) {
		return details.results.flatMap((entry) =>
			isRecord(entry) && isRunEndType(entry.customType) && isRecord(entry.details)
				? [
						{
							customType: entry.customType,
							content: typeof entry.content === "string" ? entry.content : "",
							details: entry.details,
						},
					]
				: [],
		);
	}
	return [{ customType, content: typeof content === "string" ? content : "", details }];
}

/** Run ids a committed parent message carries; old messages carry one id in details.id. */
export function runEndIds(message: unknown): string[] {
	if (!isRecord(message) || message.role !== "custom") return [];
	return runEnds(message.customType, message.content, message.details).flatMap((entry) =>
		typeof entry.details.id === "string" ? [entry.details.id] : [],
	);
}
