import { execFileAsync } from "./core.ts";
import { HC_COMMAND } from "./herdr-core-exit.ts";

/** The Herdr app's CLI (herdr-app 0.1.16 on the live checks of 2026-11-18). */
export const HERDR_APP_COMMAND = "herdr-app";
/** The hc label that puts a terminal into a tab of that Herdr app space (live check L5). */
const SPACE_LABEL_KEY = "herdr.space";
/** Bound of each app call, so a hung app cannot hold the focus transaction of every later launch. */
const APP_CALL_TIMEOUT_MS = 5_000;

export type ChildPlacement = "split" | "tab" | "hidden";

/** Runs one herdr-app call and parses its JSON reply; a failure is exit 1 with {"error": "..."} (live shapes). */
async function app(args: string[]): Promise<Record<string, unknown>> {
	const { stdout } = await execFileAsync(HERDR_APP_COMMAND, args, {
		encoding: "utf8",
		timeout: APP_CALL_TIMEOUT_MS,
		killSignal: "SIGKILL",
	});
	const reply = JSON.parse(stdout) as Record<string, unknown>;
	if (typeof reply.error === "string") throw new Error(`herdr-app ${args.join(" ")}: ${reply.error}`);
	return reply;
}

async function focusedPane(): Promise<string> {
	const pane = (await app(["status"])).focused_pane;
	if (typeof pane !== "string") throw new Error("herdr-app status gave no focused_pane");
	return pane;
}

/**
 * The split transaction (D27): terminal.keep splits the focused pane and moves focus (live checks L1, L2),
 * so save the focus, focus the parent by address, keep the child as a split, and focus the saved pane
 * again, also when a step fails. Without a saved focus nothing has moved, so nothing is restored.
 */
async function splitBesideParent(child: string, parent: string): Promise<void> {
	const saved = await focusedPane();
	try {
		await app(["do", "pane.focus", "--terminal", parent]);
		const kept = await app(["do", "terminal.keep", "--terminal", child, "--place", "right"]);
		if (typeof kept.pane !== "string") throw new Error(`herdr-app terminal.keep gave no pane for ${child}`);
	} finally {
		await app(["do", "pane.focus", "--pane", saved]).catch(() => undefined);
	}
}

/** The tab fallback (D27): the parent's space label on the same terminal; no focus moves (live checks L4, L5). */
async function tabInParentSpace(child: string, parent: string): Promise<void> {
	const { stdout } = await execFileAsync(HC_COMMAND, ["get", parent, "--json"], { encoding: "utf8" });
	const space = (JSON.parse(stdout) as { labels?: Record<string, string> }).labels?.[SPACE_LABEL_KEY];
	if (!space) throw new Error(`parent terminal ${parent} has no ${SPACE_LABEL_KEY} label`);
	await execFileAsync(HC_COMMAND, ["label", child, `${SPACE_LABEL_KEY}=${space}`], { encoding: "utf8" });
}

/**
 * Tail of the focus transactions of this process. The app has one focus, so at most one transaction
 * runs at a time: a second launch never focuses its parent between the first one's focus and split.
 * Limit: the chain is per process; a child Pi that launches its own children in the same app has its
 * own chain. Revisit with a lock file when nested launches overlap in practice.
 */
let focusQueue: Promise<unknown> = Promise.resolve();

function inFocusTransaction<T>(step: () => Promise<T>): Promise<T> {
	const run = focusQueue.then(step, step);
	focusQueue = run.catch(() => undefined);
	return run;
}

/**
 * Gives a started child terminal a pane: a split beside the parent, else a tab in the parent's space.
 * When both fail the terminal keeps running without a pane ("hidden"); its result still arrives
 * through the exit watch, so a placement failure never fails the launch or starts a second terminal.
 */
export async function placeChildTerminal(child: string, parent: string): Promise<ChildPlacement> {
	try {
		await inFocusTransaction(() => splitBesideParent(child, parent));
		return "split";
	} catch {
		try {
			await tabInParentSpace(child, parent);
			return "tab";
		} catch {
			return "hidden";
		}
	}
}
