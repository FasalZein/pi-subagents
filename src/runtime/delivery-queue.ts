import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { outstandingWork } from "./outstanding-work.ts";

/** The parent message kinds that carry a run's end to the parent model. */
export type RunEndMessageType = "subagent_result" | "subagent_ping";

export interface RunEndMessage {
	customType: RunEndMessageType;
	content: string;
	display: true;
	details: object;
}

/**
 * D15: the one owner of run-end delivery to the parent. A result that no wait took leaves as a
 * message on Pi's steer queue: Pi drains that queue at the next turn boundary (also after a
 * terminating batch), or starts a turn at once when the parent is idle. No delivery waits for the
 * person's next prompt. Delivery is at least once; the outstanding-work lease keeps the run
 * reported until a settled turn has carried the message.
 *
 * `triggerTurn: false` exists only for verified fan-out adoption in a print-mode parent (D18).
 */
export function deliverRunEnd(
	pi: Pick<ExtensionAPI, "sendMessage">,
	id: string,
	message: RunEndMessage,
	options: { triggerTurn?: boolean } = {},
): void {
	outstandingWork.delivery(id, () =>
		pi.sendMessage(message, { triggerTurn: options.triggerTurn ?? true, deliverAs: "steer" }),
	);
}
