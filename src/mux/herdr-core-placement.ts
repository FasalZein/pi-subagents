import { execFileAsync } from "./core.ts";
import { HC_COMMAND } from "./herdr-core-exit.ts";

/** The Herdr app's CLI (herdr-app 0.1.16 on the live checks of 2026-11-18). */
export const HERDR_APP_COMMAND = "herdr-app";
/** The hc label that puts a terminal into a tab of that Herdr app space (live check L5). */
const SPACE_LABEL_KEY = "herdr.space";
/**
 * Bound of each app and fallback call, so a hung app or hc cannot hold the focus transaction of every
 * later launch, nor hold a started child before the runtime registers it.
 */
const PLACEMENT_CALL_TIMEOUT_MS = 5_000;
const BOUNDED = { encoding: "utf8", timeout: PLACEMENT_CALL_TIMEOUT_MS, killSignal: "SIGKILL" } as const;

/** Runs one bounded call; a failure names the call and its reply (herdr-app and hc print errors on stdout). */
async function run(command: string, args: string[]): Promise<string> {
	try {
		return (await execFileAsync(command, args, BOUNDED)).stdout;
	} catch (error) {
		const failed = error as { killed?: boolean; stdout?: string; message: string };
		const detail = failed.killed
			? `no reply within ${PLACEMENT_CALL_TIMEOUT_MS} ms`
			: failed.stdout?.trim() || failed.message;
		throw new Error(`${command} ${args.join(" ")}: ${detail}`);
	}
}

/** Runs one herdr-app call and parses its JSON reply; a failure is exit 1 with {"error": "..."} (live shapes). */
async function app(args: string[]): Promise<Record<string, unknown>> {
	const reply = JSON.parse(await run(HERDR_APP_COMMAND, args)) as Record<string, unknown>;
	if (typeof reply.error === "string") throw new Error(`herdr-app ${args.join(" ")}: ${reply.error}`);
	return reply;
}

/** pane.focus answers {"ok": true} (live shapes); any other reply is not an acknowledged focus. */
async function focus(args: string[]): Promise<void> {
	const reply = await app(["do", "pane.focus", ...args]);
	if (reply.ok !== true) throw new Error(`herdr-app do pane.focus ${args.join(" ")} gave no ok: true`);
}

/** Where the owner looks: the shown space and tab and the focused pane (status, live baseline). */
type AppFocus = { space?: string; tab?: string; pane: string };

async function readFocus(): Promise<AppFocus> {
	const status = await app(["status"]);
	if (typeof status.focused_pane !== "string") throw new Error("herdr-app status gave no focused_pane");
	const text = (value: unknown) => (typeof value === "string" ? value : undefined);
	return { space: text(status.space), tab: text(status.tab), pane: status.focused_pane };
}

/**
 * Focuses the saved pane, then reads the status again and compares space, tab and pane: an
 * acknowledged focus is not proof that the view is back. Adapted from upstream PR #33
 * (restoreFocus/sameFocus in its herdr-app.ts). PR #33 also selects space and tab; here pane.focus
 * alone restored all three on the live check L2, so a mismatch is reported, not repaired.
 */
async function restoreFocus(want: AppFocus): Promise<void> {
	await focus(["--pane", want.pane]);
	const now = await readFocus();
	if (now.pane !== want.pane || (want.space && now.space !== want.space) || (want.tab && now.tab !== want.tab)) {
		throw new Error(`herdr-app status shows ${JSON.stringify(now)} instead of ${JSON.stringify(want)}`);
	}
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The split transaction (D27): terminal.keep splits the focused pane and moves focus (live checks L1, L2),
 * so save the focus, focus the parent by address, keep the child as a split, and restore the saved focus,
 * also when a step fails. Without a saved focus nothing has moved, so nothing is restored. A failed
 * restore is a warning of its own: the split result does not depend on it.
 * Recorded limit: the app's terminal.keep has no target-pane argument (herdr-app 0.1.16), so an owner
 * who selects another pane between the parent focus and keep gets the split there, and the restore
 * can override that newer choice.
 */
async function splitBesideParent(child: string, parent: string, warn: (warning: string) => void): Promise<void> {
	const saved = await readFocus();
	try {
		await focus(["--terminal", parent]);
		const kept = await app(["do", "terminal.keep", "--terminal", child, "--place", "right"]);
		if (typeof kept.pane !== "string") throw new Error(`herdr-app terminal.keep gave no pane for ${child}`);
	} finally {
		await restoreFocus(saved).catch((error) =>
			warn(`the Herdr app focus was not restored to pane ${saved.pane} after placing ${child}: ${message(error)}`),
		);
	}
}

/** The tab fallback (D27): the parent's space label on the same terminal; no focus moves (live checks L4, L5). */
async function tabInParentSpace(child: string, parent: string): Promise<void> {
	const parentTerminal = await run(HC_COMMAND, ["get", parent, "--json"]);
	const space = (JSON.parse(parentTerminal) as { labels?: Record<string, string> }).labels?.[SPACE_LABEL_KEY];
	if (!space) throw new Error(`parent terminal ${parent} has no ${SPACE_LABEL_KEY} label`);
	await run(HC_COMMAND, ["label", child, `${SPACE_LABEL_KEY}=${space}`]);
}

/**
 * Tail of the focus transactions of this Pi process: at most one runs at a time, so a second launch
 * never focuses its parent between the first one's focus and split (D27). Exclusion, not order, is the
 * requirement; the promise chain gives both.
 * Recorded limit: the exclusion covers this process only. Two Pi processes in one Herdr app (for
 * example a pane child that launches its own pane child while its parent launches) can interleave
 * their focus transactions. Revisit when the app can split beside a given pane without focus.
 */
let focusQueue: Promise<unknown> = Promise.resolve();

function inFocusTransaction<T>(step: () => Promise<T>): Promise<T> {
	const run = focusQueue.then(step, step);
	focusQueue = run.catch(() => undefined);
	return run;
}

/**
 * Gives a started child terminal a pane: a split beside the parent, else a tab in the parent's space.
 * When both fail the terminal keeps running without a pane; its result still arrives through the exit
 * watch, so a placement failure never fails the launch or starts a second terminal. It is a warning.
 */
export async function placeChildTerminal(
	child: string,
	parent: string,
	warn: (warning: string) => void,
): Promise<void> {
	try {
		await inFocusTransaction(() => splitBesideParent(child, parent, warn));
	} catch (splitError) {
		try {
			await tabInParentSpace(child, parent);
		} catch (tabError) {
			warn(
				`the child terminal ${child} runs without a pane in the Herdr app: split failed (${message(splitError)}); tab failed (${message(tabError)})`,
			);
		}
	}
}
