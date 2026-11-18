import { cpSync, readdirSync } from "node:fs";
import {
	type AgentListEntry,
	getAgentListEntries,
} from "../../src/agents/agent-list.ts";
import {
	AGENT_INDEX_MAX_CHARS,
	AGENT_INDEX_SECTION_NAME,
	applyAgentIndexSection,
	type IndexLaunchPolicy,
	renderAgentIndexRequestText,
	renderAgentIndexSection,
	selectIndexTargets,
} from "../../src/agents/index-section.ts";
import { parseSpawnEnv } from "../../src/spawn/policy.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	join,
	mkdirSync,
} from "../support/index.ts";

const FIXTURE_AGENTS = join(
	import.meta.dirname,
	"..",
	"..",
	"scripts",
	"orchestration-benchmark",
	"agent-fixture",
	"agents",
);
const PANE: IndexLaunchPolicy = { paneAvailable: true, forcesWait: false };
const PRINT: IndexLaunchPolicy = { paneAvailable: false, forcesWait: true };
const COUNT_LINE = /^\+\d+ more: subagent_agents with a query$/;

function entry(
	name: string,
	extra: Partial<AgentListEntry> = {},
): AgentListEntry {
	return {
		name,
		source: "global",
		mode: "background",
		sessionMode: "standalone",
		autoExit: true,
		description: `Agent ${name} does one kind of work and reports back with a short summary of the result for the caller.`,
		spawning: false,
		visibleTo: ["all"],
		...extra,
	};
}

describe("agent index section", () => {
	const savedDir = process.env.PI_CODING_AGENT_DIR;
	afterEach(() => {
		if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedDir;
	});

	it("lists every agent of the sanitized fixture with the three fixed lines within the limit", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		mkdirSync(configDir, { recursive: true });
		cpSync(FIXTURE_AGENTS, join(configDir, "agents"), { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;
		const entries = getAgentListEntries(
			dir,
			(agent) => agent.sessionMode ?? "lineage-only",
		);
		const names = readdirSync(FIXTURE_AGENTS).map((file) =>
			file.replace(/\.md$/, ""),
		);
		assert.equal(entries.length, names.length);
		const section = renderAgentIndexSection(entries, PANE);
		assert.ok(section);
		const rendered = renderAgentIndexRequestText(section);
		assert.ok(
			rendered.length <= AGENT_INDEX_MAX_CHARS,
			`${rendered.length} characters\n${rendered}`,
		);
		const lines = section.split("\n");
		assert.match(
			lines[0],
			/^Helpers: launch with subagent \(a children list\)\./,
		);
		assert.match(lines[1], /^Do not do delegated work yourself\./);
		assert.match(
			lines[1],
			/A script that launches waits in the same script with a time limit and returns the pending ids\./,
		);
		assert.match(
			lines[2],
			/^More tools: subagent_wait, subagent_resume, subagent_kill, subagent_agents/,
		);
		for (const name of names)
			assert.ok(
				lines.some((line) => line.startsWith(`- ${name}: `)),
				name,
			);
		assert.ok(!lines.some((line) => COUNT_LINE.test(line)));
	});

	for (const pinned of [false, true]) {
		it(`keeps 100 ${pinned ? "pinned" : "generated"} definitions within the limit and ends with a count line`, () => {
			const entries = Array.from({ length: 100 }, (_, i) =>
				entry(`agent-${String(i).padStart(3, "0")}`, { pinned }),
			);
			const section = renderAgentIndexSection(entries, PANE);
			assert.ok(section);
			const rendered = renderAgentIndexRequestText(section).length;
			assert.ok(rendered <= AGENT_INDEX_MAX_CHARS, `${rendered} characters`);
			const lines = section.split("\n");
			const shown = lines.filter((line) => line.startsWith("- ")).length;
			assert.ok(shown > 0);
			assert.equal(
				lines.at(-1),
				`+${100 - shown} more: subagent_agents with a query`,
			);
		});
	}

	it("puts a pinned definition before unpinned ones, each group by name", () => {
		const section = renderAgentIndexSection([
			entry("alpha"),
			entry("zeta", { pinned: true }),
			entry("beta"),
			entry("omega", { pinned: true }),
		], PANE);
		const names = section
			?.split("\n")
			.filter((line) => line.startsWith("- "))
			.map((line) => line.slice(2, line.indexOf(":")));
		assert.deepEqual(names, ["omega", "zeta", "alpha", "beta"]);
	});

	it("flags only agents that differ from the common case and cuts descriptions to 100 characters", () => {
		const section = renderAgentIndexSection([
			entry("plain"),
			entry("pane", { mode: "interactive", autoExit: undefined }),
			entry("forked", { sessionMode: "fork", async: false }),
			entry("long", { description: "x".repeat(300) }),
		], PANE);
		const lines = section?.split("\n") ?? [];
		assert.ok(
			lines.includes(
				`- plain: ${entry("plain").description?.slice(0, 100).trimEnd()}`,
			),
		);
		assert.ok(
			lines.some(
				(line) =>
					line.startsWith("- pane: ") && line.endsWith(" [pane] [manual]"),
			),
		);
		assert.ok(
			lines.some(
				(line) =>
					line.startsWith("- forked: ") && line.endsWith(" [fork] [waits]"),
			),
		);
		assert.ok(lines.includes(`- long: ${"x".repeat(100)}`));
	});

	it("flags lines by the solo launch policy of a headless or forced-wait session", () => {
		const lines =
			renderAgentIndexSection([
				entry("manual-pane", { mode: "interactive", autoExit: false }),
				entry("bg-manual", { mode: "background", autoExit: false }),
				entry("blocking", { async: false }),
			], PRINT)?.split("\n") ?? [];
		// A print parent launches every agent headless, closes it and waits
		// (shouldUseBackgroundLaunch, applySynchronousLaunchPolicy).
		const manualPane = lines.find((line) => line.startsWith("- manual-pane: "));
		assert.ok(manualPane);
		assert.doesNotMatch(manualPane, /\[pane\]|\[manual\]/);
		assert.doesNotMatch(lines.find((line) => line.startsWith("- bg-manual: ")) ?? "", /\[manual\]/);
		assert.doesNotMatch(lines.find((line) => line.startsWith("- blocking: ")) ?? "", /\[waits\]/);
		assert.ok(lines.includes("Every launch here waits for its result."));
		assert.equal(lines.slice(0, 3).join("\n"), renderAgentIndexSection([entry("x")], PANE)?.split("\n").slice(0, 3).join("\n"));
		// In a pane session a background agent closes itself whatever auto-exit says.
		const pane = renderAgentIndexSection([entry("bg-manual", { mode: "background", autoExit: false })], PANE);
		assert.doesNotMatch(pane ?? "", /\[manual\]/);
	});

	it("never lists the caller and matches the launch tool's spawn policy", () => {
		const entries = [entry("coordinator", { spawning: true }), entry("scout")];
		const names = (env: Record<string, string>) =>
			selectIndexTargets(entries, parseSpawnEnv(env)).map((e) => e.name);
		assert.deepEqual(names({ PI_SUBAGENT_AGENT: "coordinator", PI_SUBAGENT_SPAWNABLE: "true" }), ["scout"]);
		assert.deepEqual(names({ PI_SUBAGENT_AGENT: "coordinator", PI_SUBAGENT_SPAWNABLE: "coordinator" }), []);
		assert.deepEqual(names({ PI_SUBAGENT_AGENT: "coordinator", PI_SUBAGENT_SPAWN_BUDGET: "0" }), []);
		assert.deepEqual(names({}), ["coordinator", "scout"]);
	});

	it("returns no section when no agent may be launched", () => {
		assert.equal(renderAgentIndexSection([], PANE), undefined);
		assert.equal(
			renderAgentIndexSection([entry("blank", { description: "  " })], PANE),
			undefined,
		);
	});

	it("appends the section to a whole prompt only in a child", () => {
		const forced = () => ({
			systemPromptOptions: { sections: {}, forceSystemPrompt: "WHOLE" },
		});
		assert.equal(applyAgentIndexSection(forced(), "INDEX", false), undefined);
		const tagged = `<${AGENT_INDEX_SECTION_NAME}>\nINDEX\n</${AGENT_INDEX_SECTION_NAME}>`;
		assert.deepEqual(applyAgentIndexSection(forced(), "INDEX", true), {
			systemPrompt: `WHOLE\n\n${tagged}`,
		});
		const already = {
			systemPromptOptions: {
				sections: {},
				forceSystemPrompt: `WHOLE\n\n${tagged}`,
			},
		};
		assert.equal(applyAgentIndexSection(already, "INDEX", true), undefined);
	});
});
