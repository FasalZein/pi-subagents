import { readdirSync } from "node:fs";
import { getSessionArtifactDir, getSessionResultsDir } from "../../src/artifact-storage.ts";
import { launchBackgroundSubagent } from "../../src/launch/background.ts";
import { registerSubagentResumeTool } from "../../src/tools/resume-tool.ts";
import { assert, createTestDir, describe, existsSync, it, join, mkdirSync, writeFileSync } from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";

// A Pi session header is read from disk and its id is checked only for its type. The artifact
// storage boundary takes that id as one folder name, so an id that is not one plain path component
// is refused before any lookup or folder creation (review b1 g1/g3 P1).

const UNSAFE_SESSION_IDS = ["../../outside", "..", ".", "", "a/b", "a\\b", "/abs", "a\u0000b"];

function listTree(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { recursive: true }).map(String).sort();
}

function withArtifactRoot(dir: string): () => void {
	const saved = { root: process.env.PI_ARTIFACT_PROJECT_ROOT, pi: process.env.PI_SUBAGENT_PI_COMMAND };
	process.env.PI_ARTIFACT_PROJECT_ROOT = join(dir, "artifacts");
	// A missing executable: a launch that got past the boundary fails at spawn, never runs Pi.
	process.env.PI_SUBAGENT_PI_COMMAND = join(dir, "missing-pi");
	return () => {
		if (saved.root === undefined) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
		else process.env.PI_ARTIFACT_PROJECT_ROOT = saved.root;
		if (saved.pi === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
		else process.env.PI_SUBAGENT_PI_COMMAND = saved.pi;
	};
}

const isUnsafeSessionId = (error: unknown) => /session id is not one path component/.test(String(error));

describe("session id path containment", () => {
	it("refuses a session id that is not one plain path component and accepts a Pi session id", () => {
		const cwd = createTestDir();
		for (const id of UNSAFE_SESSION_IDS) {
			assert.throws(() => getSessionArtifactDir(cwd, id), isUnsafeSessionId, JSON.stringify(id));
			assert.throws(() => getSessionResultsDir(cwd, id), isUnsafeSessionId, JSON.stringify(id));
		}
		const id = "019a6f2e-3b1c-7d40-9e8f-0123456789ab";
		assert.equal(getSessionResultsDir(cwd, id), join(getSessionArtifactDir(cwd, id), "results"));
	});

	it("a launch from an imported session id with parent components creates nothing", async () => {
		const dir = createTestDir();
		const restore = withArtifactRoot(dir);
		try {
			mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
			writeFileSync(join(dir, ".pi", "agents", "probe.md"), "---\nname: probe\nmode: background\n---\nProbe body.");
			const parentSession = join(dir, "parent.jsonl");
			writeFileSync(
				parentSession,
				`${JSON.stringify({ type: "session", version: 3, id: "../../outside", cwd: dir })}\n`,
			);
			const before = listTree(dir);
			await assert.rejects(
				launchBackgroundSubagent(
					{ name: "probe-child", title: "Probe child", task: "Probe.", agent: "probe" },
					{
						cwd: dir,
						sessionManager: {
							getSessionFile: () => parentSession,
							getSessionId: () => "../../outside",
							getLeafId: () => null,
						},
					},
					{ getContextWindow: () => undefined },
				),
				isUnsafeSessionId,
			);
			assert.deepEqual(listTree(dir), before, "the launch created no file or folder");
		} finally {
			restore();
		}
	});

	it("a resume by run id from an imported session id with parent components looks up nothing", async () => {
		const dir = createTestDir();
		const restore = withArtifactRoot(dir);
		try {
			const tools = new Map<string, any>();
			registerSubagentResumeTool(
				{ registerTool: (definition: any) => tools.set(definition.name, definition) } as any,
				() => true,
				{} as any,
				{ mayLaunch: () => true },
			);
			const ctx = { cwd: dir, hasUI: false, sessionManager: { getSessionId: () => "../../outside" } };
			const before = listTree(dir);
			await assert.rejects(
				tools.get("subagent_resume").execute("c1", { runId: "0123abcd", task: "go on" }, undefined, undefined, ctx),
				isUnsafeSessionId,
			);
			assert.deepEqual(listTree(dir), before, "the resume created no file or folder");
		} finally {
			restore();
		}
	});
});
