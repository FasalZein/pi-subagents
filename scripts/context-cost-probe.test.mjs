import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { generateAgentDir, LOADOUTS, probe } from "./context-cost-probe.mjs";

const FIXTURE = fileURLToPath(new URL("./orchestration-benchmark/agent-fixture", import.meta.url));
// Caps of the spec (docs/specs/context-rework.md, Measurement plan, G1.1 and G1.2).
// The total grew from 6,000 by the largest measured delta of the D19 model lines
// (2,805 with 100 generated definitions; 1,869 with the fixture), and the section
// cap is AGENT_INDEX_MAX_CHARS (owner 2026-11-21).
const TOTAL_CAP = 8_805;
const SECTION_CAP = 4_400;
const AGENTS_NO_ARG_CAP = 200;
// D21: management tools are direct without a discovery tool and deferred with codemode.
const EXPECTED_DECLARED = {
	none: ["subagent", "subagent_agents", "subagent_kill", "subagent_resume", "subagent_wait"],
	on: ["subagent"],
	only: [],
};

describe("context cost probe (G1.1)", () => {
	for (const loadout of LOADOUTS) {
		it(`stays within the caps with the sanitized fixture, loadout ${loadout}`, async () => {
			const report = await probe(FIXTURE, loadout);
			assert.ok(report.total > 0, "the extension adds prompt text");
			assert.ok(report.total <= TOTAL_CAP, `total ${report.total}`);
			assert.ok(report.section > 0 && report.section <= SECTION_CAP, `section ${report.section}`);
			// Only the section grows with the agents, so the total cap holds for any agent count (T87).
			const fixed = report.total - report.section;
			assert.ok(fixed + SECTION_CAP <= TOTAL_CAP, `fixed part ${fixed}`);
			assert.match(report.indexText, /^<index>\n[\s\S]*\n<\/index>$/);
			// The section is the whole system prompt growth, up to the separator newlines.
			assert.ok(report.systemPrompt.delta >= report.section, "section counted in the prompt delta");
			assert.deepEqual(report.declarations.map((d) => d.name).sort(), EXPECTED_DECLARED[loadout]);
			if (loadout === "none") assert.equal(report.codemodeDescription.with, null);
			if (loadout === "only") {
				// Mode only embeds the launch tool in the codemode description.
				assert.ok(report.codemodeDescription.with > report.codemodeDescription.without);
				assert.ok(!report.otherTools.includes("read"), "mode only leaves out direct tools");
			}
			if (loadout === "on") assert.equal(report.codemodeDescription.with, report.codemodeDescription.without);
		});
	}
});

describe("context cost probe declaration sizes", () => {
	for (const loadout of LOADOUTS) {
		it(`counts each declaration as the complete object in the request, loadout ${loadout}`, async () => {
			const report = await probe(FIXTURE, loadout);
			for (const side of ["with", "without"]) {
				assert.ok(report.tools[side].length > 0);
				for (const tool of report.tools[side]) {
					assert.equal(tool.chars, tool.request.length, `${side} ${tool.name}`);
				}
			}
		});
	}
});

describe("context cost probe with 100 definitions (G1.2)", () => {
	const dirs = [];
	after(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});
	for (const pinned of [false, true]) {
		it(`stays flat with 100 ${pinned ? "pinned" : "generated"} definitions`, async () => {
			const dir = generateAgentDir(FIXTURE, 100, { pinned });
			dirs.push(dir);
			const files = readdirSync(join(dir, "agents"));
			assert.equal(files.length, 100);
			const pinnedCount = files.filter((file) =>
				/^pinned: true$/m.test(readFileSync(join(dir, "agents", file), "utf8")),
			).length;
			assert.equal(pinnedCount, pinned ? 100 : 0);
			for (const loadout of LOADOUTS) {
				const report = await probe(dir, loadout, { extras: loadout === "none" });
				assert.ok(report.total <= TOTAL_CAP, `${loadout} total ${report.total}`);
				assert.ok(report.section <= SECTION_CAP, `${loadout} section ${report.section}`);
				assert.ok(report.indexShown < 100, "the index lists only some agents");
				assert.match(report.indexText, /\+\d+ more: subagent_agents/);
				assert.equal(report.indexShown + report.indexOmitted, 100, `${loadout} index coverage`);
				assert.equal(report.pass.indexCoverage, true);
				if (loadout !== "none") continue;
				assert.equal(report.agentsNoArg.ok, true, report.agentsNoArg.text);
				assert.ok(report.agentsNoArg.chars > 0 && report.agentsNoArg.chars <= AGENTS_NO_ARG_CAP);
				assert.match(report.agentsNoArg.text, /100 agents/);
				assert.ok(report.outsideLaunch, "an agent outside the index exists");
				assert.ok(!report.indexText.includes(`- ${report.outsideLaunch.agent}:`));
				assert.equal(report.outsideLaunch.launched, report.outsideLaunch.agent, report.outsideLaunch.reply);
			}
		});
	}
});
