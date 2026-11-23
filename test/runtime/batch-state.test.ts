import {
	getSubagentBatchStopMetadata,
	isSubagentBatchBlocking,
	isSubagentBatchStopRequested,
	markSubagentBatchBlocking,
	requestSubagentBatchStop,
	resetSubagentBatchStopRequest,
} from "../../src/runtime/state.ts";
import { assert, describe, it } from "../support/index.ts";

type BatchEvent = "reset" | "markBlocking" | "requestStop";
type Observed = { blocking: boolean; terminate: boolean; stopRequested: boolean };

const EVENTS: readonly BatchEvent[] = ["reset", "markBlocking", "requestStop"];
const KILL_SWITCH = "PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN";

function apply(event: BatchEvent): void {
	if (event === "reset") resetSubagentBatchStopRequest();
	else if (event === "markBlocking") markSubagentBatchBlocking();
	else requestSubagentBatchStop();
}

function observe(): Observed {
	return {
		blocking: isSubagentBatchBlocking(),
		terminate: getSubagentBatchStopMetadata().terminate === true,
		stopRequested: isSubagentBatchStopRequested(),
	};
}

/** Reference: the two module flags of state.ts before ticket H (feat/context-rework 4adc766). */
function referenceRun(events: readonly BatchEvent[], killSwitch: boolean): Observed {
	let stop = false;
	let blocking = false;
	for (const event of events) {
		if (event === "reset") {
			stop = false;
			blocking = false;
		} else if (event === "markBlocking") {
			blocking = true;
		} else if (!killSwitch) {
			stop = true;
		}
	}
	return { blocking, terminate: stop && !blocking, stopRequested: stop };
}

function runFromOpen(events: readonly BatchEvent[]): Observed {
	resetSubagentBatchStopRequest();
	for (const event of events) apply(event);
	return observe();
}

function allSequences(maxLength: number): BatchEvent[][] {
	const sequences: BatchEvent[][] = [[]];
	let frontier: BatchEvent[][] = [[]];
	for (let length = 1; length <= maxLength; length++) {
		frontier = frontier.flatMap((prefix) => EVENTS.map((event) => [...prefix, event]));
		sequences.push(...frontier);
	}
	return sequences;
}

const OPEN: Observed = { blocking: false, terminate: false, stopRequested: false };
const BLOCKING: Observed = { blocking: true, terminate: false, stopRequested: false };
const BLOCKING_STOP_ASKED: Observed = { blocking: true, terminate: false, stopRequested: true };
const STOP_AFTER: Observed = { blocking: false, terminate: true, stopRequested: true };

// Each state is reached from open by a short event path; the expected readers come from the ticket-H
// rules (blocking absorbs a stop request; only stopAfter ends the turn) and the reader contract in state.ts.
const STATES: ReadonlyArray<{ name: string; path: BatchEvent[]; observed: Observed }> = [
	{ name: "open", path: [], observed: OPEN },
	{ name: "blocking", path: ["markBlocking"], observed: BLOCKING },
	{ name: "blocking, stop asked", path: ["markBlocking", "requestStop"], observed: BLOCKING_STOP_ASKED },
	{ name: "stopAfter", path: ["requestStop"], observed: STOP_AFTER },
];

const EXPECTED_AFTER: Record<string, Record<BatchEvent, Observed>> = {
	open: { reset: OPEN, markBlocking: BLOCKING, requestStop: STOP_AFTER },
	blocking: { reset: OPEN, markBlocking: BLOCKING, requestStop: BLOCKING_STOP_ASKED },
	"blocking, stop asked": { reset: OPEN, markBlocking: BLOCKING_STOP_ASKED, requestStop: BLOCKING_STOP_ASKED },
	stopAfter: { reset: OPEN, markBlocking: BLOCKING_STOP_ASKED, requestStop: STOP_AFTER },
};

describe("subagent batch state", () => {
	for (const state of STATES) {
		it(`reaches ${state.name} from open`, () => {
			assert.deepEqual(runFromOpen(state.path), state.observed);
		});
		for (const event of EVENTS) {
			it(`${state.name} + ${event}`, () => {
				assert.deepEqual(runFromOpen([...state.path, event]), EXPECTED_AFTER[state.name]?.[event]);
			});
		}
	}

	it("keeps a blocking batch blocking when a stop is requested", () => {
		const observed = runFromOpen(["markBlocking", "requestStop"]);
		assert.equal(observed.blocking, true);
		assert.deepEqual(getSubagentBatchStopMetadata(), {});
	});

	it("ignores a stop request under the kill switch, in every state", () => {
		process.env[KILL_SWITCH] = "1";
		assert.deepEqual(runFromOpen(["requestStop"]), OPEN);
		assert.deepEqual(runFromOpen(["markBlocking", "requestStop"]), BLOCKING);
	});

	it("answers every reader as the two-flag reference does, for every event sequence up to length 5", () => {
		for (const killSwitch of [false, true]) {
			if (killSwitch) process.env[KILL_SWITCH] = "1";
			else delete process.env[KILL_SWITCH];
			for (const events of allSequences(5)) {
				assert.deepEqual(runFromOpen(events), referenceRun(events, killSwitch), `${killSwitch} ${events.join(",")}`);
			}
		}
	});
});
