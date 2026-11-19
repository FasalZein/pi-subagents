import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getSessionArtifactDir } from "../artifact-storage.ts";
import type { DataSchema } from "../tools/data-schema.ts";

interface ArtifactContext {
	sessionManager: { getSessionId(): string };
	cwd: string;
}

interface SessionHeaderArtifactContext {
	id: string;
	cwd?: string;
}

function getArtifactDir(cwd: string, sessionId: string): string {
	return getSessionArtifactDir(cwd, sessionId);
}

function safeArtifactName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * The child reads this file after its process starts, so each launch gets its own file, created
 * exclusively under a random name: a same-name sibling started in the same second never replaces
 * it. Owner-only (0600 in a 0700 folder), because a task or system prompt can hold private text.
 */
function writeContextArtifact(name: string, text: string, ctx: ArtifactContext, suffix = ""): string {
	const folder = join(getArtifactDir(ctx.cwd, ctx.sessionManager.getSessionId()), "context");
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	chmodSync(folder, 0o700);
	const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const stem = `${safeArtifactName(name) || "subagent"}${suffix ? `-${suffix}` : ""}-${ts}-${randomUUID()}`;
	const artifactPath = join(folder, `${stem}.md`);
	writeFileSync(artifactPath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
	return artifactPath;
}

export function writeTaskArtifact(name: string, task: string, ctx: ArtifactContext): string {
	return writeContextArtifact(name, task, ctx);
}

function safeArtifactSessionId(value: unknown, fallback: string): string {
	const raw = typeof value === "string" && value ? value : fallback;
	const safe = raw.replace(/[^a-zA-Z0-9._-]/g, "-");
	return safe && safe !== "." && safe !== ".." ? safe : fallback;
}

function readSessionHeaderArtifactContext(sessionFile: string): SessionHeaderArtifactContext {
	const fallbackId = basename(sessionFile, ".jsonl");
	try {
		const firstLine = readFileSync(sessionFile, "utf8").split("\n", 1)[0];
		const header = JSON.parse(firstLine) as Record<string, unknown>;
		return {
			id: safeArtifactSessionId(header.id, fallbackId),
			cwd: typeof header.cwd === "string" && header.cwd ? header.cwd : undefined,
		};
	} catch {
		return { id: fallbackId };
	}
}

export function writeResumeTaskArtifact(name: string, task: string, sessionFile: string, cwd: string): string {
	const header = readSessionHeaderArtifactContext(sessionFile);
	return writeTaskArtifact(name, task, {
		cwd: header.cwd ?? cwd,
		sessionManager: { getSessionId: () => header.id },
	});
}

/**
 * D12: the checked launch schema of one child as JSON; the child's completion call reads it. Each
 * launch gets its own file, created exclusively under a random name, so same-name siblings never
 * share one; owner-only (0600 in a 0700 folder), because a schema can hold private values.
 */
export function writeDataSchemaArtifact(name: string, schema: DataSchema, ctx: ArtifactContext): string {
	const folder = join(getArtifactDir(ctx.cwd, ctx.sessionManager.getSessionId()), "schemas");
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	chmodSync(folder, 0o700);
	const artifactPath = join(folder, `${safeArtifactName(name) || "subagent"}-${randomUUID()}.json`);
	writeFileSync(artifactPath, JSON.stringify(schema.schema), { encoding: "utf8", flag: "wx", mode: 0o600 });
	return artifactPath;
}

export function writeSystemPromptArtifact(name: string, systemPrompt: string, ctx: ArtifactContext): string {
	return writeContextArtifact(name, systemPrompt, ctx, "sysprompt");
}
