/**
 * Exclusive claim of one sample key: a marker file made with O_EXCL. Only the
 * holder runs the sample and publishes its record. A claim whose owner process
 * is gone (pid plus start time) is taken over through a short exclusive
 * takeover lock, so two jobs cannot both take over one stale claim.
 */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { identityAlive, processIdentity } from "./sample-home.mjs";

// A takeover lock lives for a few file operations; one this old was left by a crash.
const TAKEOVER_STALE_MS = 60_000;

function createExclusive(path, text) {
	const fd = openSync(path, "wx", 0o600);
	try {
		writeSync(fd, text);
	} finally {
		closeSync(fd);
	}
}

function readClaim(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/**
 * @param {string} markerPath
 * @param {{identity?: {pid: number, start: string | null}, alive?: (identity: object) => boolean}} [options]
 * @returns {{token: string} | {busy: string}}
 */
export function acquireClaim(markerPath, options = {}) {
	const identity = options.identity ?? processIdentity();
	const alive = options.alive ?? identityAlive;
	const token = randomUUID();
	const text = JSON.stringify({ token, owner: identity });
	try {
		createExclusive(markerPath, text);
		return { token };
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	const current = readClaim(markerPath);
	if (current && alive(current.owner))
		return { busy: `another job holds this sample (pid ${current.owner.pid})` };
	const lockPath = `${markerPath}.takeover`;
	try {
		if (
			existsSync(lockPath) &&
			Date.now() - statSync(lockPath).mtimeMs > TAKEOVER_STALE_MS
		)
			rmSync(lockPath, { force: true });
		createExclusive(lockPath, token);
	} catch (error) {
		if (error.code === "EEXIST")
			return { busy: "another job is taking over this sample" };
		throw error;
	}
	try {
		// Under the takeover lock: recheck that the claim is still the stale one we judged.
		const again = readClaim(markerPath);
		if (again && (again.token !== current?.token || alive(again.owner)))
			return { busy: "the claim changed during takeover" };
		rmSync(markerPath, { force: true });
		createExclusive(markerPath, text);
		return { token };
	} finally {
		rmSync(lockPath, { force: true });
	}
}

/** Release only the claim this job holds. */
export function releaseClaim(markerPath, token) {
	if (readClaim(markerPath)?.token !== token) return false;
	const parked = `${markerPath}.release-${token}`;
	renameSync(markerPath, parked);
	rmSync(parked, { force: true });
	return true;
}

/** True when this job still holds the claim (checked before publishing). */
export function holdsClaim(markerPath, token) {
	return readClaim(markerPath)?.token === token;
}
