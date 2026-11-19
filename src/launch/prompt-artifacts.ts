import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getSessionArtifactDir } from "../artifact-storage.ts";

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

function getSubagentArtifactPath(name: string, ctx: ArtifactContext, suffix = "", extension = "md"): string {
	const sessionId = ctx.sessionManager.getSessionId();
	const artifactDir = getArtifactDir(ctx.cwd, sessionId);
	const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const safeName = name
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return join(artifactDir, `context/${safeName || "subagent"}${suffix ? `-${suffix}` : ""}-${ts}.${extension}`);
}

export function writeTaskArtifact(name: string, task: string, ctx: ArtifactContext): string {
	const artifactPath = getSubagentArtifactPath(name, ctx);
	mkdirSync(dirname(artifactPath), { recursive: true });
	writeFileSync(artifactPath, task, "utf8");
	return artifactPath;
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

/** D12: the launch schema of one child as JSON; the child's completion call reads it. */
export function writeDataSchemaArtifact(name: string, schema: unknown, ctx: ArtifactContext): string {
	const artifactPath = getSubagentArtifactPath(name, ctx, "schema", "json");
	mkdirSync(dirname(artifactPath), { recursive: true });
	writeFileSync(artifactPath, JSON.stringify(schema), "utf8");
	return artifactPath;
}

export function writeSystemPromptArtifact(name: string, systemPrompt: string, ctx: ArtifactContext): string {
	const artifactPath = getSubagentArtifactPath(name, ctx, "sysprompt");
	mkdirSync(dirname(artifactPath), { recursive: true });
	writeFileSync(artifactPath, systemPrompt, "utf8");
	return artifactPath;
}
