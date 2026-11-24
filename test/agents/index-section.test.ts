import { execFileSync } from "node:child_process";
import { cpSync, readdirSync, writeFileSync } from "node:fs";
import { type AgentListEntry, getAgentListEntries } from "../../src/agents/agent-list.ts";
import {
	AGENT_INDEX_MAX_CHARS,
	AGENT_INDEX_SECTION_NAME,
	applyAgentIndexSection,
	INDEX_MORE_TOOLS,
	type IndexLaunchPolicy,
	indexFallbackMessages,
	renderAgentIndexRequestText,
	renderAgentIndexSection,
	selectIndexTargets,
} from "../../src/agents/index-section.ts";
import { parseSpawnEnv } from "../../src/spawn/policy.ts";
import { loadExtension } from "../support/extension-host.ts";
import { afterEach, assert, createTestDir, describe, it, join, mkdirSync } from "../support/index.ts";

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
// An interactive session with a mux that was started with a prompt: the first
// prompt forces a wait, the next ones use the pane policy.
const STARTUP: IndexLaunchPolicy = { paneAvailable: true, forcesWait: true };
const HEADLESS: IndexLaunchPolicy = { paneAvailable: false, forcesWait: false };
const COUNT_LINE = /^\+\d+ more: subagent_agents with a query$/;
// T87: the call forms a parent needs, so it does not look the signatures up (audit row 7).
const MORE_TOOLS_LINE =
	"More tools: subagent_resume({runId, task?}), subagent_kill({runId}), subagent_agents({query?, name?}) (search; name: full detail).";
// D06: the cf6dbf4 routing rules in short form. Sources (git show cf6dbf4:<path>):
// src/tools/subagent-tools.ts promptSnippet "Do small direct work yourself: ... tiny one-shot edits",
// "include each named agent exactly once. Do not substitute one agent for another",
// "Do not redo delegated work", "Ask the user only when ... ownership is ambiguous";
// src/agents/agent-list.ts "do not suggest a different listed agent".
const UPSTREAM_RULES_LINE =
	"Do tiny work yourself. Use each named helper once, no substitutes. Do not redo delegated work. Ask when ownership is unclear.";

type ModelLineRenderer = (entry: AgentListEntry) => string | undefined;

/**
 * The differential oracle (D19, owner 2026-11-21): renderDefaultModelLine and
 * renderModelsLine taken from `git show cf6dbf4:src/agents/agent-list.ts`, run
 * on cf6dbf4's own src/agents/model-refs.ts.
 */
async function loadUpstreamModelLines(): Promise<{ defaultModel: ModelLineRenderer; models: ModelLineRenderer }> {
	const show = (path: string) =>
		execFileSync("git", ["show", `cf6dbf4:${path}`], { cwd: import.meta.dirname, encoding: "utf8" });
	const agentList = show("src/agents/agent-list.ts");
	const extract = (name: string) => {
		const match = agentList.match(new RegExp(`^function ${name}\\([\\s\\S]*?\\n}\\n`, "m"));
		assert.ok(match, `cf6dbf4 has ${name}`);
		return `export ${match[0]}`;
	};
	const dir = createTestDir();
	writeFileSync(join(dir, "model-refs.ts"), show("src/agents/model-refs.ts"));
	writeFileSync(
		join(dir, "model-lines.ts"),
		[
			'import { buildModelRef, parseAllowedModels } from "./model-refs.ts";',
			extract("renderDefaultModelLine"),
			extract("renderModelsLine"),
		].join("\n"),
	);
	const oracle = await import(join(dir, "model-lines.ts"));
	return { defaultModel: oracle.renderDefaultModelLine, models: oracle.renderModelsLine };
}

function entry(name: string, extra: Partial<AgentListEntry> = {}): AgentListEntry {
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

	for (const [mode, policy] of [
		["pane", PANE],
		["print", PRINT],
		["startup-prompt", STARTUP],
		["headless", HEADLESS],
	] as const)
		it(`lists every agent of the sanitized fixture with the three fixed lines within the limit (${mode})`, () => {
			const dir = createTestDir();
			const configDir = join(dir, "agent-root");
			mkdirSync(configDir, { recursive: true });
			cpSync(FIXTURE_AGENTS, join(configDir, "agents"), { recursive: true });
			process.env.PI_CODING_AGENT_DIR = configDir;
			const entries = getAgentListEntries(dir, (agent) => agent.sessionMode ?? "lineage-only");
			const names = readdirSync(FIXTURE_AGENTS).map((file) => file.replace(/\.md$/, ""));
			assert.equal(entries.length, names.length);
			const section = renderAgentIndexSection(entries, policy);
			assert.ok(section);
			const rendered = renderAgentIndexRequestText(section);
			assert.ok(rendered.length <= AGENT_INDEX_MAX_CHARS, `${rendered.length} characters\n${rendered}`);
			const lines = section.split("\n");
			assert.match(lines[0], /^Helpers: launch with subagent \(a children list\)\./);
			assert.equal(lines[1], UPSTREAM_RULES_LINE);
			assert.equal(lines[2], MORE_TOOLS_LINE);
			for (const name of names)
				assert.ok(
					lines.some((line) => line.startsWith(`- ${name}: `)),
					name,
				);
			assert.ok(!lines.some((line) => COUNT_LINE.test(line)));
		});

	for (const pinned of [false, true]) {
		it(`keeps 100 ${pinned ? "pinned" : "generated"} definitions within the limit and ends with a count line`, () => {
			const entries = Array.from({ length: 100 }, (_, i) => entry(`agent-${String(i).padStart(3, "0")}`, { pinned }));
			const section = renderAgentIndexSection(entries, PANE);
			assert.ok(section);
			const rendered = renderAgentIndexRequestText(section).length;
			assert.ok(rendered <= AGENT_INDEX_MAX_CHARS, `${rendered} characters`);
			const lines = section.split("\n");
			const shown = lines.filter((line) => line.startsWith("- ")).length;
			assert.ok(shown > 0);
			assert.equal(lines.at(-1), `+${100 - shown} more: subagent_agents with a query`);
		});
	}

	it("follows each agent line with the cf6dbf4 model lines of that agent, byte for byte (D19)", async () => {
		const upstream = await loadUpstreamModelLines();
		// Made-up refs. A suffix that is no Pi thinking level (`m:free`) is left
		// out: the fork keeps it in the model id on purpose and shows the ref the
		// child runs on (D22; parent decision 2026-11-21 on review 88994379).
		const cases = [
			entry("bare"),
			entry("default-only", { model: "prov/model-a", thinking: "high" }),
			entry("suffixed", { model: "prov/model-a:low", thinking: "high" }),
			entry("listed", {
				model: "prov/model-a",
				thinking: "medium",
				allowedModels: "prov/model-b:xhigh, prov/model-a:medium ,prov/model-c,, ",
			}),
			entry("list-no-default", { allowedModels: "prov/model-b, prov/model-b" }),
			entry("blank-list", { model: "prov/model-a", allowedModels: "  " }),
			entry("locked", { model: "prov/model-a", thinking: "low", allowModelOverride: false }),
			entry("locked-bare", { allowModelOverride: false, allowedModels: "prov/model-b" }),
			entry("open", { model: "prov/model-a", allowModelOverride: true }),
		];
		for (const policy of [PANE, PRINT]) {
			const lines = renderAgentIndexSection(cases, policy)?.split("\n") ?? [];
			for (const item of cases) {
				const at = lines.findIndex((line) => line.startsWith(`- ${item.name}: `));
				assert.ok(at >= 0, item.name);
				const end = lines.findIndex((line, i) => i > at && !line.startsWith("  "));
				const expected = [upstream.defaultModel(item), upstream.models(item)].filter((line) => line !== undefined);
				assert.deepEqual(lines.slice(at + 1, end === -1 ? undefined : end), expected, item.name);
			}
		}
	});

	it("keeps or drops an agent line together with its model lines, pinned agents first (D19)", () => {
		const models = { model: "prov/model-a", thinking: "high", allowedModels: "prov/model-b, prov/model-c:low" };
		const entries = Array.from({ length: 30 }, (_, i) =>
			entry(`agent-${String(i).padStart(3, "0")}`, { ...models, pinned: i >= 25 }),
		);
		const section = renderAgentIndexSection(entries, PANE) ?? "";
		assert.ok(renderAgentIndexRequestText(section).length <= AGENT_INDEX_MAX_CHARS);
		const lines = section.split("\n");
		const shown = lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2, line.indexOf(":")));
		assert.ok(shown.length > 0 && shown.length < 30, `${shown.length} shown`);
		assert.deepEqual(shown.slice(0, 5), ["agent-025", "agent-026", "agent-027", "agent-028", "agent-029"]);
		for (const name of shown) {
			const at = lines.findIndex((line) => line.startsWith(`- ${name}: `));
			assert.deepEqual(lines.slice(at + 1, at + 3), [
				"  default_model: prov/model-a:high",
				"  models: prov/model-a:high | prov/model-b | prov/model-c:low",
			]);
		}
		assert.equal(lines.at(-1), `+${30 - shown.length} more: subagent_agents with a query`);
	});

	it("puts a pinned definition before unpinned ones, each group by name", () => {
		const section = renderAgentIndexSection(
			[entry("alpha"), entry("zeta", { pinned: true }), entry("beta"), entry("omega", { pinned: true })],
			PANE,
		);
		const names = section
			?.split("\n")
			.filter((line) => line.startsWith("- "))
			.map((line) => line.slice(2, line.indexOf(":")));
		assert.deepEqual(names, ["omega", "zeta", "alpha", "beta"]);
	});

	it("flags only agents that differ from the common case and cuts descriptions to 100 characters", () => {
		const section = renderAgentIndexSection(
			[
				entry("plain"),
				entry("pane", { mode: "interactive", autoExit: undefined }),
				entry("forked", { sessionMode: "fork", async: false }),
				entry("long", { description: "x".repeat(300) }),
			],
			PANE,
		);
		const lines = section?.split("\n") ?? [];
		assert.ok(lines.includes(`- plain: ${entry("plain").description?.slice(0, 100).trimEnd()}`));
		assert.ok(lines.some((line) => line.startsWith("- pane: ") && line.endsWith(" [pane] [manual]")));
		assert.ok(lines.some((line) => line.startsWith("- forked: ") && line.endsWith(" [fork] [waits]")));
		assert.ok(lines.includes(`- long: ${"x".repeat(100)}`));
	});

	it("flags lines by the solo launch policy of a headless or forced-wait session", () => {
		const lines =
			renderAgentIndexSection(
				[
					entry("manual-pane", { mode: "interactive", autoExit: false }),
					entry("bg-manual", { mode: "background", autoExit: false }),
					entry("blocking", { async: false }),
				],
				PRINT,
			)?.split("\n") ?? [];
		// A print parent launches every agent headless, closes it and waits
		// (shouldUseBackgroundLaunch, applySynchronousLaunchPolicy).
		const manualPane = lines.find((line) => line.startsWith("- manual-pane: "));
		assert.ok(manualPane);
		assert.doesNotMatch(manualPane, /\[pane\]|\[manual\]/);
		assert.doesNotMatch(lines.find((line) => line.startsWith("- bg-manual: ")) ?? "", /\[manual\]/);
		assert.doesNotMatch(lines.find((line) => line.startsWith("- blocking: ")) ?? "", /\[waits\]/);
		assert.ok(lines.includes("Launches wait."));
		assert.equal(
			lines.slice(0, 3).join("\n"),
			renderAgentIndexSection([entry("x")], PANE)
				?.split("\n")
				.slice(0, 3)
				.join("\n"),
		);
		// In a pane session a background agent closes itself whatever auto-exit says.
		const pane = renderAgentIndexSection([entry("bg-manual", { mode: "background", autoExit: false })], PANE);
		assert.doesNotMatch(pane ?? "", /\[manual\]/);
	});

	it("never lists the caller and matches the launch tool's spawn policy", () => {
		const entries = [entry("coordinator", { spawning: true }), entry("scout")];
		const names = (env: Record<string, string>) => selectIndexTargets(entries, parseSpawnEnv(env)).map((e) => e.name);
		assert.deepEqual(names({ PI_SUBAGENT_AGENT: "coordinator", PI_SUBAGENT_SPAWNABLE: "true" }), ["scout"]);
		assert.deepEqual(names({ PI_SUBAGENT_AGENT: "coordinator", PI_SUBAGENT_SPAWNABLE: "coordinator" }), []);
		assert.deepEqual(names({ PI_SUBAGENT_AGENT: "coordinator", PI_SUBAGENT_SPAWN_BUDGET: "0" }), []);
		assert.deepEqual(names({}), ["coordinator", "scout"]);
	});

	it("names no wait tool: a result arrives as a message (owner 2026-11-24)", () => {
		const section = renderAgentIndexSection([entry("solo")], PANE) ?? "";
		assert.ok(!section.includes("subagent_wait"), section);
		assert.equal(
			section.split("\n")[0],
			"Helpers: launch with subagent (a children list). A result arrives as a message. A helper sees only its task text unless marked [fork].",
		);
	});

	it("returns no section when no agent may be launched", () => {
		assert.equal(renderAgentIndexSection([], PANE), undefined);
		assert.equal(renderAgentIndexSection([entry("blank", { description: "  " })], PANE), undefined);
	});

	it("names only the tools the session may call and names every hidden agent without subagent_agents (D06)", () => {
		const entries = [
			...Array.from({ length: 40 }, (_, i) => entry(`agent-${String(i).padStart(3, "0")}`)),
			entry("bare", { description: undefined }),
		];
		const section =
			renderAgentIndexSection(entries, PANE, { callable: new Set(["subagent_resume", "subagent_kill"]) }) ?? "";
		const lines = section.split("\n");
		assert.equal(lines[2], "More tools: subagent_resume({runId, task?}), subagent_kill({runId}).");
		assert.ok(!section.includes("subagent_agents"), section);
		assert.ok(renderAgentIndexRequestText(section).length <= AGENT_INDEX_MAX_CHARS);
		// Every launchable name is in the section, on a line or on the names line, the descriptionless one too.
		const namesLine = lines.at(-1) ?? "";
		assert.match(namesLine, /^More agents: [\w-]+(, [\w-]+)*\.$/);
		for (const { name } of entries)
			assert.ok(lines.some((line) => line.startsWith(`- ${name}: `)) || namesLine.includes(name), name);
		assert.ok(namesLine.includes("agent-039"), "an agent without a line is named");
		const coded = renderAgentIndexSection(entries, PANE, { callable: new Set(["subagent_kill"]) }) ?? "";
		assert.equal(coded.split("\n")[2], "More tools: subagent_kill({runId}).");
		const none = renderAgentIndexSection([entry("solo")], PANE, { callable: new Set() });
		assert.ok(!none?.includes("More tools"), none);
		// A lone descriptionless agent is still reachable without the lookup.
		assert.match(
			renderAgentIndexSection([entry("bare", { description: undefined })], PANE, { callable: new Set() }) ?? "",
			/\nMore agents: bare\.$/,
		);
	});

	it("names each management tool with a call form that its registered parameter schema accepts (T87)", async () => {
		const { tools } = await loadExtension(createTestDir());
		const line = renderAgentIndexSection([entry("solo")], PANE)?.split("\n")[2] ?? "";
		const forms = [...line.matchAll(/(subagent_\w+)\(\{([^}]*)\}\)/g)];
		assert.deepEqual(
			forms.map(([, name]) => name),
			["subagent_resume", "subagent_kill", "subagent_agents"],
			line,
		);
		for (const [form, name, args] of forms) {
			const schema = (tools.get(name) as unknown as { parameters: { properties: object; required?: string[] } })
				.parameters;
			const named = args.split(", ").map((arg) => ({ key: arg.replace(/\?$/, ""), optional: arg.endsWith("?") }));
			for (const { key, optional } of named) {
				assert.ok(key in schema.properties, `${form}: ${key} is a parameter`);
				if (optional) assert.ok(!schema.required?.includes(key), `${form}: ${key} is optional`);
			}
			for (const key of schema.required ?? [])
				assert.ok(
					named.some((arg) => arg.key === key && !arg.optional),
					`${form}: names required ${key}`,
				);
		}
	});

	it("keeps 500 long names within the limit without subagent_agents and counts the unnamed ones", () => {
		const entries = Array.from({ length: 500 }, (_, i) =>
			entry(`agent-with-a-rather-long-name-${String(i).padStart(3, "0")}`),
		);
		const section = renderAgentIndexSection(entries, PANE, { callable: new Set() }) ?? "";
		assert.ok(renderAgentIndexRequestText(section).length <= AGENT_INDEX_MAX_CHARS, `${section.length}`);
		const last = section.split("\n").at(-1) ?? "";
		const named = (last.match(/agent-with/g) ?? []).length;
		assert.ok(named > 0);
		assert.ok(last.endsWith(`, +${500 - named} not shown.`), last);
	});

	it("marks pane flags as conditional while no launch has detected a multiplexer (D06)", () => {
		const unknown: IndexLaunchPolicy = { paneAvailable: "unknown", forcesWait: false };
		const manual = entry("manual-pane", { mode: "interactive", autoExit: false });
		const lines = renderAgentIndexSection([manual], unknown)?.split("\n") ?? [];
		assert.ok(
			lines.includes(`- manual-pane: ${manual.description?.slice(0, 100).trimEnd()} [pane] [manual]`),
			lines.join("\n"),
		);
		assert.ok(
			lines.includes("[pane] and [manual] need a multiplexer; without one a helper runs headless and closes itself."),
		);
		// Known: no note; known absent: no pane flags (the launch runs it headless and it closes itself).
		assert.ok(!renderAgentIndexSection([manual], PANE)?.includes("need a multiplexer"));
		assert.ok(!renderAgentIndexSection([manual], HEADLESS)?.includes("[pane]"));
		assert.ok(!renderAgentIndexSection([entry("plain")], unknown)?.includes("need a multiplexer"));
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

	it("puts the index in front of a request whose system prompt lacks it, and only then (D06)", () => {
		const tagged = renderAgentIndexRequestText("INDEX");
		const history = [{ role: "user" }];
		assert.deepEqual(indexFallbackMessages(history, "PARENT PROMPT", "INDEX"), [
			{ role: "custom", customType: "subagent-index", content: tagged, display: false, timestamp: 0 },
			...history,
		]);
		assert.equal(indexFallbackMessages(history, `PROMPT\n\n${tagged}\n\nMORE`, "INDEX"), undefined);
	});
});
