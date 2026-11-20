import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { outstandingWork } from "../../src/runtime/outstanding-work.ts";
import type { RunId } from "../../src/runtime/result-record.ts";
import { completedSubagentResults } from "../../src/runtime/state.ts";
import { wireSubagentSteerBack } from "../../src/runtime/wiring.ts";
import { registerOutstandingWorkReporting, type WorkReporterSession } from "../../src/runtime/work-reporting.ts";
import { registerSubagentMessageRenderers } from "../../src/tools/message-renderers.ts";
import { buildCompletedItems } from "../../src/tools/overlay/data.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	childSessionFile,
	endWatchedChild,
	failWatcher,
	type Parent,
	recordingReply,
	startParent,
	waitFor,
} from "../support/delivery-parent.ts";
import { assert, createTestDir, describe, it } from "../support/index.ts";

// T22 at the extension boundary (D15, D30): a real Pi parent session, three children that end
// during one parent tool batch, the production delivery queue and the production work reporting.

/** A watched child that ends with caller_ping: a blocked record (D12). */
async function pingChild(parent: Parent, name: string): Promise<RunId> {
	const reservation = parent.store.reserve();
	parent.runIds.push(reservation.runId);
	const sessionFile = childSessionFile();
	const running = {
		id: reservation.runId,
		name,
		task: "Work",
		agent: "scout",
		mode: "background",
		phase: "running",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		resultTarget: { store: parent.store, reservation, parentCwd: createTestDir(), warnings: [] },
	} as unknown as RunningSubagent;
	wireSubagentSteerBack(
		parent.pi,
		running,
		Promise.resolve({
			name,
			task: "Work",
			summary: "",
			exitCode: 0,
			elapsed: 1,
			sessionFile,
			ping: { name, message: "Need a decision on the schema." },
		}),
	);
	await new Promise((resolve) => setImmediate(resolve));
	return reservation.runId;
}

/** One parent tool call during which three children end: done, failed and blocked. */
function threeChildrenTool(parent: () => Parent, onEnded: () => void): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "launch_three",
			label: "launch_three",
			description: "Launches three children that end at once.",
			parameters: Type.Object({}),
			async execute() {
				await endWatchedChild(parent(), "child-done");
				await endWatchedChild(parent(), "child-failed", 1);
				await pingChild(parent(), "child-blocked");
				onEnded();
				return { content: [{ type: "text", text: "launched" }], details: {} };
			},
		});
	};
}

interface SessionEntry {
	type?: string;
	customType?: string;
	details?: { results?: Array<{ details?: { id?: string } }> };
}

function sessionEntries(file: string): SessionEntry[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as SessionEntry);
}

function runEndEntries(file: string): SessionEntry[] {
	return sessionEntries(file).filter(
		(entry) =>
			entry.type === "custom_message" &&
			(entry.customType === "subagent_result" || entry.customType === "subagent_ping"),
	);
}

const REPORTER_SESSION: WorkReporterSession = { mode: "tui", sessionManager: { getSessionFile: () => "parent.jsonl" } };

describe("one message per turn boundary (T22, D15, D30)", () => {
	it("a watcher error message keeps its session target and failed outcome: overlay row and failed header", async () => {
		const parent = await startParent({
			replies: (p) => [fauxAssistantMessage("Nothing to do."), recordingReply(p, "Read the result.")],
		});
		try {
			await parent.prompt("hello");
			const runId = failWatcher(parent, "child-broken");
			await waitFor(() => parent.requests.length === 1, "the turn that the result starts");
			const [message] = runEndEntries(parent.sessionFile());
			const details = message?.details as Record<string, unknown> | undefined;
			assert.equal(details?.id, runId);
			assert.equal(details?.outcome, "failed");
			// T70: the message names the ender of the saved record.
			const saved = parent.store.read(runId);
			assert.ok(saved?.endedBy, "the saved record names its ender");
			assert.equal(details?.endedBy, saved?.endedBy);
			assert.match(String(details?.sessionFile), /child\.jsonl$/);
			const renderers = new Map<string, (...args: any[]) => any>();
			registerSubagentMessageRenderers(
				{ registerMessageRenderer: (n: string, r: any) => renderers.set(n, r) } as any,
				(s) => `${s}s`,
			);
			const plain = { fg: (_: string, t: string) => t, bg: (_: string, t: string) => t, bold: (t: string) => t };
			const lines: string[] = renderers.get("subagent_result")!(
				message,
				{ expanded: false, outputPad: 0 },
				plain,
			).render(80);
			assert.ok(
				lines.some((line) => /^✗ child-broken .*failed/.test(line.trim())),
				JSON.stringify(lines),
			);
			const overlayCtx = {
				cwd: createTestDir(),
				sessionManager: { getSessionFile: () => parent.sessionFile() },
			} as never;
			for (const when of ["before reload", "after reload"]) {
				if (when === "after reload") completedSubagentResults.clear();
				const row = (await buildCompletedItems(overlayCtx)).find((item) => item.id === runId);
				assert.equal(row?.status, "failed", `${when}: failed row`);
				assert.equal(row?.canResume, true, `${when}: resumable`);
			}
		} finally {
			await parent.dispose();
		}
	});

	it("three children that end during one tool batch leave as one message; the count holds 3 until it is committed", async () => {
		let countWhenEnded: number | undefined;
		const counts: number[] = [];
		let reporting: ReturnType<typeof registerOutstandingWorkReporting> | undefined;
		const parent = await startParent({
			extensions: (p) => [
				threeChildrenTool(p, () => {
					countWhenEnded = outstandingWork.count;
				}),
				(pi) => {
					reporting = registerOutstandingWorkReporting(pi, async () => ({
						publish: async (count) => {
							counts.push(count);
						},
						stop: async () => {},
					}));
				},
			],
			replies: (p) => [
				fauxAssistantMessage([fauxToolCall("launch_three", {}, { id: "l1" })], { stopReason: "toolUse" }),
				recordingReply(p, "Read the results."),
			],
		});
		const unsubscribeCounts = outstandingWork.subscribe(() => counts.push(outstandingWork.count));
		try {
			// biome-ignore lint/style/noNonNullAssertion: the extension factory ran in startParent.
			await reporting!.start(REPORTER_SESSION as never);
			await parent.prompt("delegate");
			const [done, failed, blocked] = parent.runIds;
			assert.equal(parent.runIds.length, 3);

			// One subagent_result message with three results.
			const messages = runEndEntries(parent.sessionFile());
			assert.equal(messages.length, 1, `run-end messages: ${JSON.stringify(messages.map((m) => m.details))}`);
			assert.equal(messages[0]?.customType, "subagent_result");
			const memberIds = (messages[0]?.details?.results ?? []).map((member) => member.details?.id);
			assert.deepEqual(memberIds.sort(), [done, failed, blocked].sort());
			assert.equal(messages[0]?.details?.results?.length, 3);

			// The next request carries each run once.
			const request = parent.requests[0]?.text ?? "";
			for (const id of [done, failed, blocked]) {
				assert.equal(request.split(`run: ${id}`).length - 1, 1, `request carries run ${id} once`);
			}

			// D30: 3 outstanding until the message is committed, then 0, with no zero gap before.
			assert.equal(countWhenEnded, 3);
			assert.equal(outstandingWork.count, 0);
			const firstWork = counts.findIndex((count) => count > 0);
			const released = counts.indexOf(0, firstWork);
			assert.ok(firstWork >= 0 && released > firstWork, `counts ${JSON.stringify(counts)}`);
			assert.ok(counts.slice(firstWork, released).includes(3), `counts ${JSON.stringify(counts)}`);

			// The /subagents overlay reads the group back as three rows with their resume targets.
			const overlayCtx = {
				cwd: createTestDir(),
				sessionManager: { getSessionFile: () => parent.sessionFile() },
			} as never;
			const expectRows = async (when: string) => {
				const items = await buildCompletedItems(overlayCtx);
				const byName = new Map(items.map((item) => [item.name, item]));
				for (const name of ["child-done", "child-failed", "child-blocked"]) {
					const item = byName.get(name);
					assert.ok(item, `${when}: row for ${name} in ${JSON.stringify([...byName.keys()])}`);
					assert.equal(item.canResume, true, `${when}: ${name} offers resume`);
					assert.match(item.sessionFile ?? "", /child\.jsonl$/, `${when}: ${name} resume target`);
				}
				assert.equal(byName.get("child-done")?.status, undefined, `${when}: done shows no status`);
				assert.equal(byName.get("child-failed")?.status, "failed", `${when}: failed status`);
				assert.equal(byName.get("child-blocked")?.status, "blocked", `${when}: blocked status`);
				assert.equal(items.length, 3, `${when}: three rows`);
			};
			await expectRows("before reload");
			// A reload keeps only the session file.
			completedSubagentResults.clear();
			await expectRows("after reload");
		} finally {
			unsubscribeCounts();
			await reporting?.stop();
			await parent.dispose();
		}
	});
});
