import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFileAsync } from "./core.ts";
import { APP_CHECK_TIMEOUT_MS } from "./herdr-core.ts";

/** Rex API revisions that the live checks of 2026-11-18 ran on (D28, live-rex-pane-checks.md). */
export const REX_TESTED_API_REVISIONS: readonly number[] = [16];
/** rex capture has no line limit and returns all scrollback; at most this many bytes are kept (D28). */
export const REX_CAPTURE_MAX_BYTES = 256 * 1024;

/** A failed rex call; stderr tells a connect timeout from a request timeout (live check 13). */
export class RexCallError extends Error {
	readonly stderr: string;
	constructor(message: string, stderr: string) {
		super(message);
		this.stderr = stderr;
	}
}

function isExecutableFile(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** rex on PATH, else in REX_BIN_DIR: inside a Rex block rex is not on PATH (D28, live check 6). */
export function resolveRexBinary(): string | undefined {
	for (const dir of [...(process.env.PATH ?? "").split(delimiter), process.env.REX_BIN_DIR]) {
		if (dir && isExecutableFile(join(dir, "rex"))) return join(dir, "rex");
	}
	return undefined;
}

function requireRexBinary(): string {
	const binary = resolveRexBinary();
	if (!binary) throw new Error("rex not found on PATH or in REX_BIN_DIR");
	return binary;
}

/** Accepted revisions by binary path: read once per binary, at first use (D28). */
const revisionByBinary = new Map<string, number>();

/** The binary answers rex whoami with a tested API revision; the call is bounded like herdr-core's app check. */
export function rexRevisionAccepted(binary: string): boolean {
	let revision = revisionByBinary.get(binary);
	if (revision === undefined) {
		try {
			const out = execFileSync(binary, ["whoami", "--json"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: APP_CHECK_TIMEOUT_MS,
				killSignal: "SIGKILL",
			});
			const value = (JSON.parse(out) as { api_revision?: unknown }).api_revision;
			if (typeof value !== "number") return false;
			revision = value;
			revisionByBinary.set(binary, revision);
		} catch {
			// No answer is not cached: the server can start later.
			return false;
		}
	}
	return REX_TESTED_API_REVISIONS.includes(revision);
}

/** The hint for the current rex binary when its API revision was read and is not tested. */
export function rexRevisionHint(): string | undefined {
	const binary = resolveRexBinary();
	const revision = binary === undefined ? undefined : revisionByBinary.get(binary);
	if (revision === undefined || REX_TESTED_API_REVISIONS.includes(revision)) return undefined;
	return (
		`Rex API revision ${revision} is not supported: pi-subagents is tested with revision ${REX_TESTED_API_REVISIONS.join(", ")}. ` +
		"Update pi-subagents or Rex, or set PI_SUBAGENT_MUX to another backend."
	);
}

function callError(args: readonly string[], error: unknown): RexCallError {
	const stderr = String((error as { stderr?: unknown }).stderr ?? "");
	const detail = stderr.trim() || (error instanceof Error ? error.message : String(error));
	return new RexCallError(`rex ${args.slice(0, 2).join(" ")} failed: ${detail}`, stderr);
}

export function rexSync(args: readonly string[]): string {
	const binary = requireRexBinary();
	try {
		return execFileSync(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		throw callError(args, error);
	}
}

export async function rexAsync(args: readonly string[]): Promise<string> {
	const binary = requireRexBinary();
	try {
		return (await execFileAsync(binary, [...args], { encoding: "utf8" })).stdout;
	} catch (error) {
		throw callError(args, error);
	}
}

/**
 * The last REX_CAPTURE_MAX_BYTES of the file, from the first whole line on.
 * Reads only that tail, so memory holds at most the cap.
 */
function readCappedTail(fd: number): string {
	const size = fstatSync(fd).size;
	const start = Math.max(0, size - REX_CAPTURE_MAX_BYTES);
	const buffer = Buffer.alloc(size - start);
	readSync(fd, buffer, 0, buffer.length, start);
	const text = buffer.toString("utf8");
	if (start === 0) return text;
	const firstBreak = text.indexOf("\n");
	return firstBreak === -1 ? "" : text.slice(firstBreak + 1);
}

/**
 * Runs a capture with its stdout in a private temp file, so that a long scrollback is never
 * buffered in memory, and returns the capped tail. The file is removed after the read.
 */
async function withCaptureFile(run: (fd: number) => Promise<void> | void): Promise<string> {
	const path = join(tmpdir(), `pi-rex-capture-${randomUUID()}`);
	const fd = openSync(path, "wx+", 0o600);
	try {
		await run(fd);
		return readCappedTail(fd);
	} finally {
		closeSync(fd);
		rmSync(path, { force: true });
	}
}

function withCaptureFileSync(run: (fd: number) => void): string {
	const path = join(tmpdir(), `pi-rex-capture-${randomUUID()}`);
	const fd = openSync(path, "wx+", 0o600);
	try {
		run(fd);
		return readCappedTail(fd);
	} finally {
		closeSync(fd);
		rmSync(path, { force: true });
	}
}

export function rexCaptureSync(args: readonly string[]): string {
	const binary = requireRexBinary();
	return withCaptureFileSync((fd) => {
		const run = spawnSync(binary, args, { stdio: ["ignore", fd, "pipe"], encoding: "utf8" });
		if (run.error) throw callError(args, run.error);
		if (run.status !== 0) throw callError(args, { stderr: run.stderr });
	});
}

export function rexCaptureAsync(args: readonly string[]): Promise<string> {
	const binary = requireRexBinary();
	return withCaptureFile(
		(fd) =>
			new Promise<void>((resolve, reject) => {
				const child = spawn(binary, args, { stdio: ["ignore", fd, "pipe"] });
				let stderr = "";
				child.stderr?.setEncoding("utf8");
				child.stderr?.on("data", (chunk: string) => {
					if (stderr.length < 4096) stderr += chunk;
				});
				child.on("error", (error) => reject(callError(args, error)));
				child.on("close", (code) => (code === 0 ? resolve() : reject(callError(args, { stderr }))));
			}),
	);
}
