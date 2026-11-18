# Context rework: bounded parent context and better orchestration

Status: draft for owner approval. Baseline: upstream v2.9.2 (cf6dbf4). Branch: feat/context-rework. Date: 2026-11-18.

Terms in this document follow GLOSSARY.md. Decision records: docs/adr/0001, 0002 and 0003.

## Problem Statement

I run long Pi sessions that delegate work to children. Two things go wrong.

The parent's context fills up. Each agent definition I add makes the parent prompt longer, because the roster lists every agent with every model it accepts. Each child that finishes puts its whole final message into the parent, with no limit. One report in my sessions was 29,993 characters. When I launch a batch, every result costs a parent turn and stays in context for the rest of the session.

The orchestration is not reliable enough to lean on. A parent cannot ask for the results of children it launched earlier, so it either blocks at launch or waits for messages one by one. Scratch tests against v2.9.2 reproduced a result that arrived twice, a result that nobody delivered, and a result that waited until I typed. A failed launch can leave an empty pane open. A background child that I stop is reported as completed or failed. A pane that I took over can close by itself. One malformed agent file stops every agent.

Measurements on 8 of my parent sessions (705 requests) corrected one belief. The extension's own text is about 4.4% of parent input. The parent's own reading and command output is about 57%. So the larger saving is a parent that hands a batch to children and never sees the intermediate results.

I also move from the old herdr TUI to the Herdr app on herdr-core, and I use Rex. Neither has a backend. Each existing backend is a set of branches spread over at least seven files.

## Solution

A parent's context cost for delegation becomes flat and bounded, and delegation becomes dependable.

- I can add any number of agent definitions. The parent prompt holds a short index with a fixed maximum size. Full detail about one agent loads when the parent asks for it or when a launch needs it.
- Every run ends in one result with a typed outcome. The parent gets a summary of at most 1,500 characters and the path of a report file. The full report never enters the parent by itself.
- A parent can wait for runs it launched earlier. A workflow script can launch a batch, wait, branch on typed data, and return one digest, so the reports of the batch stay out of the parent.
- A result reaches the parent exactly once. It never waits for me to type. Results that are ready at the same turn boundary arrive as one message.
- When the context is under pressure, consumed results shrink to one-line stubs in one step.
- Launch, stop, resume and takeover behave as their names say, and one bad agent file affects only that agent.
- Pane children work in the Herdr app through herdr-core and in Rex, behind one backend interface that the five existing backends also use.

There is one mode. Nothing here is optional behavior behind a switch, except the two numeric settings named in the decisions.

## User Stories

Owner at the keyboard

1. As the owner, I want the parent prompt to stay the same size when I add agent definitions, so that I can keep one agent per job without paying for it in every request.
2. As the owner, I want each child result to cost the parent a bounded number of tokens, so that a long report cannot flood a session.
3. As the owner, I want the full report of every run kept in a file, so that nothing is lost when the summary is short.
4. As the owner, I want a result to reach the parent without my input, so that work continues while I am away.
5. As the owner, I want several results that are ready together to arrive as one message, so that a batch does not cost one parent turn per child.
6. As the owner, I want Esc during a wait to stop only the wait, so that I do not lose the work of running children.
7. As the owner, I want a child that I stop to be reported as cancelled, so that the parent does not treat it as finished or broken.
8. As the owner, I want a pane that I took over to stay open until I close it, so that an error does not take my session away.
9. As the owner, I want a failed launch to leave no empty pane, so that my layout stays clean.
10. As the owner, I want one malformed agent file to affect only that agent, so that a typo does not stop all delegation.
11. As the owner, I want to say "use cpa/opus" and have the launch pick the one matching model the agent accepts, so that I do not type full model refs.
12. As the owner, I want a model named without a provider to use the provider of the agent's default model, so that the agent definition decides where the cost goes.
13. As the owner, I want every launch reply to name the model ref that runs, so that I see the provider at the moment it matters.
14. As the owner, I want a launch cap per session, so that a script loop cannot start hundreds of children.
15. As the owner, I want old results to shrink to stubs only when the context is under pressure, so that I do not pay a cache miss for a small saving.
16. As the owner, I want pane children to open beside my parent pane in the Herdr app, so that I can watch them as I do in old herdr.
17. As the owner, I want a pane child in the Herdr app to end with its parent unless its agent definition says otherwise, so that closed sessions leave nothing running.
18. As the owner, I want pane children in Rex to open as a split and then in a new tab, so that the parent pane keeps its size.
19. As the owner, I want the Herdr app and Rex to show that a parent still has outstanding children, so that I do not close it early.
20. As the owner, I want a resume of a child session to work after I removed an extension that the session once loaded, so that a review round does not fail on old configuration.
21. As the owner, I want every dropped extension named in the launch or resume result, so that a configuration error stays visible.
22. As the owner, I want my 12 agent definitions to work without edits, so that the switch to the fork is one step.
23. As the owner, I want to switch my Pi to the fork once, after both goals pass, so that live sessions stay on v2.9.2 during the build.

Parent session (the model that delegates)

24. As a parent, I want one line per agent in my prompt, so that I can route common work without a lookup.
25. As a parent, I want to search all agent definitions by words, so that I can find an agent that is not in the index.
26. As a parent, I want the full definition of one agent on request, so that model lists and limits cost tokens only when I need them.
27. As a parent, I want the launch reply to say how each child's result returns, so that I do not need a rules block to know whether to wait.
28. As a parent, I want a refused launch to name the accepted values, so that one corrected call follows.
29. As a parent, I want an unknown agent name answered with the closest names, so that a near miss costs one retry.
30. As a parent, I want to wait for named runs or for all my running children, so that I can do other work between launch and join.
31. As a parent, I want a wait with a time limit to return the finished results and the ids still pending, so that a slow child does not block the others.
32. As a parent, I want each result to carry its run id, so that resume and stop need no session path in my context.
33. As a parent, I want an outcome word on every result, so that I can tell done from partial and blocked without reading prose.
34. As a parent, I want an untyped result marked as untyped, so that I check it before I trust it.
35. As a parent, I want a wait on a result I already received to return a pointer, so that the same text does not enter my context twice.

Workflow script (code the parent writes)

36. As a workflow script, I want the launch call to return run ids as data, so that I can pass them to the wait.
37. As a workflow script, I want the wait to return results as objects, so that I can branch on outcome and data without parsing text.
38. As a workflow script, I want to name a JSON schema at launch and get data that matches it, so that a review verdict is a field and not a sentence.
39. As a workflow script, I want a result whose data failed the schema to say so, so that I can retry or stop.
40. As a workflow script, I want the reports of my batch to stay in files, so that my digest is all the parent sees.

Child session

41. As a child, I want my brief to state the summary limit and the completion call, so that I write a summary that fits.
42. As a child, I want one nudge when I end without a completion call, so that a slip does not downgrade my result.
43. As a child, I want a completion call with outcome blocked to carry my question, so that the parent can resume me with an answer.
44. As a child that may launch children, I want the same index, wait and result rules as a parent, so that a coordinator child works the same way.

Agent author

45. As an agent author, I want to mark an agent as pinned, so that it appears first in the index.
46. As an agent author, I want the first 100 characters of my description to be what the parent routes on, so that I know what to write first.
47. As an agent author, I want the parse error of my file shown when I ask for the agent, so that I can fix it.

Maintainer of the fork

48. As the maintainer, I want one run record with one phase field, so that a run's state is readable in one place.
49. As the maintainer, I want one assembler for every result path, so that a change to the result text is one change.
50. As the maintainer, I want the delivery rules as a pure state machine with the chart rules as tests, so that a delivery defect fails a test.
51. As the maintainer, I want a new backend to be one adapter that passes one contract suite, so that Rex and herdr-core do not add branches to shared code.
52. As the maintainer, I want agent frontmatter, tool names, environment variables and child session metadata unchanged, so that a rebase onto upstream v3 stays cheap.
53. As the maintainer, I want both goals measured by scripts I can rerun, so that a later change cannot regress them unseen.

## Implementation Decisions

Each decision has an id. Tickets cite these ids.

### Foundations

**D1. Fork and branch.** All work stays in the fork on branch feat/context-rework. Nothing is pushed and nothing is merged to main. No GitHub issue, comment or pull request is published. The owner uses the branch locally until upstream v3 arrives.

**D2. Pi version.** The extension requires Pi 1.5.2 or later. Compatibility with 0.85 ends. The peer and development dependencies move to 1.5.x, the pi-server pin is removed, and the one test fixture that fails to typecheck on 1.5.2 is fixed.

**D3. One mode.** Orchestrator mode is removed with its controller, configuration, policy, prompt, overlay view, environment switch and tests. No handler returns a whole system prompt. Prompt additions use named sections or the append collection that Pi provides.

**D4. Compatibility surface.** These stay as they are in v2.9.2: every agent frontmatter key and its meaning; the tool names subagent, subagent_resume, subagent_kill, subagent_done, caller_ping and set_tab_title; the environment variables; the launch metadata entry in child sessions; the message type subagent_result. Additions are new and optional: the frontmatter key pinned, the tools subagent_wait and subagent_agents, new optional tool parameters, two environment variables (D9, D17). Removed or changed, on purpose: the top-level single form of the launch parameters (D21), the roster message (D19), the subagent_ping message type for new deliveries (D13), orchestrator mode (D3), and the unused fork session manager module. Old sessions that contain roster or ping messages still load and render.

### Runs

**D5. Run record.** One run has one record with one phase field and, at the end, one outcome. Phases: starting, running, soft limit reached, wrapping up, stopping, ended. The flags that today express the same facts (the dead execution-state field, the three delivery flags, the separate timeout markers) are derived from the phase or removed.

**D6. Launch undoes what it made.** A launch registers each thing it creates as it creates it: the seeded child session file, the surface, the environment capsule, the spawn slot. When any later step fails, the launch removes all of them in reverse order and then reports the error. A spawn slot is released only by the run that holds it; releasing a count without an owner is removed. This fixes the open pane after a failed launch and the double slot release after a failed verified fan-out.

**D7. Stop and abort.** A stop request decides the outcome. A run that was asked to stop ends as cancelled on every backend and for headless children, whatever the dying child wrote. The abort signal of a tool call reaches every wait, including the wait of a launch whose agent definition says the launch waits.

**D8. Resume.** A resume accepts the run id of an earlier result or a session file. The two guards (the child ended under context pressure; the child was stopped by a time limit that forbids resume) are checked in the resume itself, so every caller gets them; the overlay keeps its explicit operator override. The exit and timeout records of the earlier run are cleared only after the new child process has started.

**D9. Launch cap.** One parent session starts at most 64 runs, counted per Pi process; a resume counts as a run. A launch over the cap is refused with the count and the cap. The environment variable PI_SUBAGENT_LAUNCH_CAP changes the number. Spawn width, spawn depth, time limits and the context warning are unchanged.

**D10. Missing extensions.** Before a launch and before a resume, each extension entry that does not resolve is dropped: a local path that does not exist, and an npm or git package entry that is not installed. The child starts with the entries that are left. Each dropped entry is named once in the launch or resume reply as "dropped missing extension: <entry>". The mandatory pi-subagents entry is never dropped; when it is missing the start fails as today. A resume keeps the saved list minus the missing entries and does not switch to the agent definition's current list.

**D11. Takeover.** After a takeover, nothing in the child requests shutdown. A provider error, a third run that ends at a tool call, or a recovery that runs out is shown in the pane, and the pane stays open until the person closes it or re-arms auto-exit.

### Results

**D12. Completion call.** Every child that can end by itself has the completion tool (the existing subagent_done, with new optional parameters): outcome (done, partial or blocked), summary, artifacts (paths the child wrote) and data (any JSON). The brief of each child states the 1,500 character limit and the call, in place of today's sentence about the final message. The tool refuses a summary over the limit once and states the limit; a second summary over the limit is cut and marked. When an auto-exit child is about to exit without a completion call, it gets one nudge. If it still makes no call, the parent builds an untyped result. A child never fails for a missing completion call. A caller_ping is recorded as outcome blocked with the ping text as summary. A manual pane child may make the call; its result is still delivered when the pane closes.

**D13. Result record.** One run produces one record with these fields: run id, name, agent, title, model ref, outcome (done, partial, blocked, failed, timed out, cancelled), typed (yes or no), summary (at most 1,500 characters), report file, session file, artifacts, data, data error, elapsed time, exit facts (code, signal, reason), time-limit facts, context usage, and whether the run can be resumed. The record and the report are two files per run in a results folder under the parent session's artifact folder. Only the parent process that watched the run writes them, once. The extension does not delete them.

**D14. One assembler, one rendering.** One pure module turns the facts of a finished run (how it ended, the child's session entries, the completion call if any) into a result record. Every path uses it: headless and pane children, the time-limit wrap-up, a time-limit kill, a stop, a watcher error, a ping, and the winner of a verified fan-out. The report is the child's last message with text, uncut, as today. With no completion call, the summary is the start of the report cut at a line end within the limit, with a mark that the result is untyped. One renderer turns a record into the text the parent sees: one header line (name, agent, outcome, elapsed time, typed or untyped), the summary, and one line with the report file and the run id. The text around the summary is at most 400 characters. The session path and the resume command line leave the text; the run id replaces them.

**D15. Delivery.** A result is in exactly one delivery state: held for a wait, queued, delivered, or stub. The transitions are a pure state machine that takes events (a wait starts, the child ends, the wait returns, Esc, a turn boundary, the parent is idle, the turn ends, the context passes the threshold). Rules that the machine keeps, each a test:

- R1. The summary of a result enters a parent context or a script once.
- R2. A result of an ended run is never without an owner while the session is open.
- R3. A result is never queued or held while the parent is idle.
- R4. A result becomes a stub only after it was consumed.

Queued results leave as one message of type subagent_result at the next turn boundary. When the parent is idle, the message is sent at once and starts a turn. No result is parked until the next user prompt. A wait that starts while a result is queued takes it. A wait on a delivered result returns the outcome and the report file without the summary. When the session closes, queued results stay in their files and are not delivered. The existing rules for when a launch call waits (the agent definition says so, a headless or one-shot parent, a launch next to another tool call in one assistant message) stay, and such a launch waits through the same machine. The existing rule that a batch of only launches ends the parent turn stays.

**D16. Wait tool.** subagent_wait takes a list of run ids (default: every running child of this parent that no wait holds), a mode (all or any, default all) and an optional time limit in seconds. It returns when the mode is met or the limit passes. The reply has the rendered text of each result and, as structured data for scripts, the list of result records and the list of ids still pending. The launch call also returns structured data: for each child its run id, name, agent, model ref and whether it is a pane child. Esc stops the wait and releases its runs; they keep running and report by message.

**D17. Stubs.** When a parent turn ends and the context use is at or above 60% of the model's window, every consumed result message is replaced in one step by its stub: one line per result with name, outcome, report file and run id. Old roster messages and consumed ping messages from before this change go in the same step. The replacement uses Pi's context edit entries, so the session file keeps the original. The environment variable PI_SUBAGENT_STUB_AT sets the percentage; 0 turns the step off. Results that a wait returned inside a workflow script were never in the parent context and are not touched.

**D18. Verified fan-out.** The feature stays. Its winner report goes through the assembler and the renderer, so the summary limit and the report file apply. Its lease and receipt protocol and its supervisor are unchanged. Its slots follow D6.

### Agent context, just in time

**D19. Index.** The roster message is no longer sent. At the start of each prompt the extension writes one named system-prompt section. Pi stores the section with the session, patches it only when it changed, and keeps it through compaction, resume and reload. The section is at most 1,600 characters. It holds two fixed lines and one line per agent:

    Helpers: launch with subagent (a children list). A result arrives as a message; subagent_wait joins now. A helper sees only its task text unless marked [fork].
    More tools: subagent_wait, subagent_resume, subagent_kill, subagent_agents (search, full detail).
    - reviewer: <first 100 characters of the description>
    - design: <first 100 characters> [pane] [manual]
    +488 more: subagent_agents with a query

Pinned agents come first, by name; then the others, by name; lines are added until the limit; the last line counts the rest. A flag appears only when the agent differs from the common case: [pane], [fork], [manual] (stays open until a person closes it), [waits] (the launch call waits). No model data, no rules block. An agent without a description is not in the index, as today. A child that may launch children gets the same section, filtered by what it may launch.

**D20. Agents tool.** subagent_agents with a name returns that agent's full definition view: description, default model ref, accepted model refs grouped by provider, kind of child, session mode, limits, and what it may launch. With a query it returns the best matches over all agent definitions (default 5), one line each. With no argument it returns the count and the pinned names. A malformed agent file is named here with its parse error.

**D21. Tool declarations.** The launch tool has one parameter shape: a children list of 1 to the spawn width, each with agent, name, title, task, and optional model, thinking and schema. The top-level single form is removed. Each rule is stated once: the rule about leaving the model unset sits in the model parameter only. The launch tool is declared in every session. The wait, resume, stop and agents tools are registered as deferred when the session has codemode or tool search active, so their declarations cost nothing until asked for; in a host with neither they are declared directly. Tool descriptions are one sentence. There is no separate prompt snippet per tool.

**D22. Model resolution.** With no model in the call, the child runs on the agent's default. With a model in the call, the launch looks inside the agent's accepted model refs: an exact ref wins; otherwise the provider part must be equal and the model part may be a fragment, and exactly one accepted model must match. A model named without a provider that matches under several providers takes the provider of the agent's default model, and is refused when that provider is not among the matches. When the accepted list has the matched model at several thinking levels, the thinking parameter picks one; without it the agent's default level applies if the list accepts it, else the first listed level. An agent without an accepted list takes any exact ref that Pi knows, and a fragment is matched against Pi's model list by the same rules. Every refusal names the accepted refs, grouped by provider. An agent definition whose override switch is off ignores a model in the call and says so in the launch reply. There is no alias table and no rewrite hook.

**D23. Facts at the point of use.** The launch reply has one line per child: agent, name, run id, the model ref that runs, pane or headless. It has one line for the batch that says how results return. Warnings and dropped extensions (D10) follow. An unknown agent name is refused with the three closest names.

**D24. One bad file.** A malformed agent file is skipped. The other agents load. A launch of the bad agent is refused with its parse error. The person sees one notice per session that names the file.

### Workflow scripts

**D25. Recipe, not a runner.** The README gets one recipe: a workflow script launches a batch, waits, reads data, and returns a digest of at most about 1,500 tokens with report file paths. It states three limits: a waiting script holds one of two codemode workers; a script cannot be resumed from the middle; time and random values must come from outside the script if a rerun should repeat. A second recipe shows a child that may launch children as the coordinator of a batch. The extension ships no agent definitions.

### Backends

**D26. Backend interface.** One interface replaces the per-backend branches. A backend can: say whether it is available; open a surface with a placement request; start a command in a surface, or start a program directly as the surface's own process; read the last lines of a surface; close a surface; rename. Two optional abilities: report that the surface's process exited with its code, signal and reason; and accept a status record. Shared code asks for an ability and never tests the backend's name. cmux, tmux, zellij, wezterm and old herdr move behind the interface with no change in behavior, pinned by their existing fake-binary tests. One contract suite runs against every backend.

**D27. herdr-core backend.** It is selected when the parent runs in an herdr-core terminal. A pane child is started through herdr-core's own API with the parent's terminal as its caller, an environment map, notes to the parent turned off, and a label with the child's title. Pi is the terminal's own program: no shell, no pasted command, no ready delay. The backend reports the exit through herdr-core's finished event. The result still comes from the child's exit record and session, as on every backend. Closing a surface is kill, then remove. Placement asks the app to give the new terminal a pane as a split beside the parent, and restores focus; when the app does not answer or the command fails, the child gets a new tab in the parent's space through a label. A child outlives the parent only when its agent definition says parent-close-policy: continue; in every other case the extension stops it when the parent session closes, because herdr-core ties children to the shell, not to Pi. Detection, placement planning, focus restore and test fakes come from upstream PR #33, with credit in the commit. Headless children stay plain processes outside herdr-core.

**D28. Rex backend.** It is selected when the Rex session and block variables are set and the rex binary is found. At first use it reads the Rex version: an API revision below 14, or outside what the binary says it supports, makes the backend unavailable with a hint. A pane child opens as a split to the right of the parent block without taking focus, at most 2 per tab, then in a new tab. Text is sent, then Enter as a key. The screen is captured trimmed and cut to the last lines. The backend never sends to or closes the parent's own block. Remote Rex servers and minimized layers are out of scope.

**D29. Detection order.** PI_SUBAGENT_MUX forces a backend. Otherwise the order is herdr-core, Rex, old herdr, cmux, tmux, zellij, wezterm. Old herdr is detected only with its own pane variable, so the herdr variables that linger in a shell do not match.

**D30. Work status.** On herdr-core and Rex the parent publishes one OSC 7501 side record that says how many children are outstanding (running, or delivered and not yet consumed) and clears it at zero. One writer serves both backends. Old herdr keeps its present reporter.

### Rollout

**D31. One switch.** The owner's Pi keeps loading the upstream package until every ticket has landed on the branch and both goals pass. Then the package entry and the agent definitions that name the upstream package switch to the local fork in one step. The stand-in extension files in the owner's Pi folder are removed after the switch. Rollback is the old entry.

**D32. Upstream v3.** When v3 appears, the owner decides between a rebase and a port. D4 keeps both cheap. This spec plans neither.

## Testing Decisions

A good test here calls the extension the way Pi does, or calls one pure module with plain data, and checks what a parent, a child or a person can observe: tool replies, messages, files, calls to a fake multiplexer binary. It does not reach into a watcher's private state.

Seams, highest first:

1. **Extension boundary.** The existing pattern: a mock Pi that records tool registrations and fires events, fake multiplexer binaries on PATH, fake child processes. All tool, index, launch, stop, resume and delivery behavior is tested here. Prior art: the launch result, wait, result router, spawn width and interactive delivery failure suites.
2. **Result assembler** (new pure module, D14). Input: run-end facts and session entries. Output: a record. Tests cover every outcome, the typed and untyped paths, the limits, and the rendering length.
3. **Delivery state machine** (new pure module, D15). Tests enumerate every event sequence up to a fixed length and check R1 to R4 after each step. No new dependency.
4. **Backend contract suite** (D26). One set of tests that each backend must pass with its fake binary. Prior art: the herdr, cmux, zellij and poll suites.

The twelve reproduced or read defects each get one regression test at seam 1, taken from the scratch tests in the replay report. The four target charts are the specification of D5 to D7, D11, D15 and D19; their rules are the names of the tests.

Live validation follows AGENTS.md: temporary agent definitions, a temporary session folder, parent and child sessions inspected, outcomes classed as duplicate, auxiliary or clean yield. Live runs use two Claude models through one provider, and the behavior checks run once more on a model of another family. The model refs are in the ticket draft, not in the repository.

### Measurement plan

Goal 1, parent context. Token figures are characters divided by 4; recorded input in the measured sessions was 1.14 to 1.47 times that figure, so each number is also checked once against recorded input in a live session.

| Check | Method | Pass |
|---|---|---|
| G1.1 Fixed cost | The probe from the context cost report: load the extension into a mock Pi, capture the section text and every declaration that is in the prompt, with the owner's 12 agent definitions, in a host with codemode | At most 1,500 tokens |
| G1.2 Flat in agents | The same probe with 100 generated agent definitions | The same number as G1.1, within 20 tokens |
| G1.3 Bounded result | Render results whose reports are 400 to 30,000 characters, typed and untyped | Every rendered text at most 1,900 characters (475 tokens) |
| G1.4 Scripted batch | Live: a workflow script launches 8 children that each write a 20,000 character report, waits, returns a digest. Measure the growth of the parent context from the session file with the method of the session share report | At most 2,500 tokens |
| G1.5 Share, for information | After the switch, rerun the session share measurement on at least 5 new parent sessions | Reported, no limit |

Goal 2, orchestration better than v2.9.2.

| Check | Method | Pass |
|---|---|---|
| G2.1 Benchmark | Three scenarios on v2.9.2 and on the branch, each on two models, three runs each, medians: (a) a recon batch of 6 read-only children, launched directly; (b) a batch of 8 children through a workflow script on the branch and through direct launches on v2.9.2; (c) one build child followed by a review child, with one fix round | Parent input tokens at least 30% lower in (a) and (b), not higher in (c); the share of clean-yield outcomes not lower in any scenario; zero results duplicated, lost or parked on the branch; parent requests not higher |
| G2.2 Checklist | One test or live repro each | A parent joins runs launched in an earlier call; results ready at one boundary arrive as one message; every result has an outcome; a launch over the cap is refused; Esc stops a wait and the children continue |
| G2.3 Rules | The tests named after the chart rules | All pass |

The benchmark fixtures (a small repository, the temporary agent definitions, the three prompts) live with the benchmark script. Model refs come from the environment.

## Out of Scope

- A workflow runner, sandbox, journal or resume of scripts inside the extension.
- Token, cost or turn budgets across children.
- Enforcement of a single writer. The rule stays advice in one line of the launch tool.
- A cap on the copied history of fork session mode.
- Headless children as herdr-core terminals.
- Remote Rex servers and Rex minimized layers.
- A second prompt mode, a model alias table, or any rewrite hook.
- Shipping agent definitions with the extension.
- Changes to the verified fan-out protocol beyond D18 and D6.
- A push, a merge to main, or any publication on GitHub.
- A plan for upstream v3.

## Further Notes

### Not verified yet

Each item is a ticket step or an acceptance check, not an assumption to build on.

1. The Herdr app did not answer on its socket in two tries. Unverified: the app command that gives an herdr-core terminal a pane as a split, its focus effect, whether it changes the terminal's keep setting, the tab created through a label, a label added later, how the app shows a child without a pane, the JSON of the app's list, status and layout commands on 0.1.21, whether herdr-core types a note into the parent, and how the app shows a side status record. Observed without the app: ending only the foreground program leaves children alive; the environment map merges; the caller alone sets the parent; the finished event carries the exit code.
2. Rex: split, send, capture and close were read from help text and other projects, not run inside a Rex pane. Whether text plus Enter reaches a Pi pane reliably is unknown.
3. Pi 1.5.2 behavior read from code and docs, not run: a waiting codemode script has no time limit; the abort reaches the nested tool; a steer sent during a script is delivered after the tool batch; a context edit can target a custom message and take a short replacement; a section is patched in place and survives compaction; a deferred tool is reachable from codemode without tool search. Also from the earlier recon: the child skills rewrite still matches the 1.5.2 prompt; a handler that returns a whole system prompt forces the prompt; the prompt-start hook also fires for runs that a message started; a child started without extensions has no codemode unless its extension list names it.
4. The three roster defects (two copies after reload or resume, none after compaction, stale after a file change) were read from code and not replayed. D19 removes the mechanism.
5. The cost of one stub step (one cache miss on the context after the first replaced message) is reasoned, not measured. G1.5 reports the cache figures after the switch.
6. No measurement exists of parent tokens for scripted against direct batches on this extension. G2.1 is that measurement.

### Evidence

All under ~/.pi/artifacts/pi-subagents/:

- session-context-share.md, context-cost-map.md: the measurements and the two probes.
- internals-map.md, sm-delivery-turn.md, sm-run-lifecycle.md, sm-child-side.md, sm-roster-policy.md: how v2.9.2 works, as transition tables.
- statecharts/pi-subagents-statecharts.html: eight checked charts, four of v2.9.2 and four of this design, with their TLA+ models beside them.
- bugpath-replay.md and bugpath-replay-tests/: the 13 replays.
- pi-api-recon.md, pi-codemode-facts.md: Pi 1.5.2 mechanisms.
- herdr-core-recon.md, hc-owned-children-facts.md, hc-live-checks.md, rex-backend-brief.md: the two new backends.
- reviewer-time-share.md: where child and parent time goes.
- orchestration-patterns.md, pi-subagent-variants.md, agent-scale-research.md: outside patterns.
- ~/.pi/artifacts/pi-pstack/product-briefs/pi-subagents-prune-missing-extensions.md: the brief behind D10.

### One measured correction

The owner expected reviewers to take most of the time. In 1,748 child runs, workers take 43.8% of child wall time and reviewers 20.4%; 85% of reviewer runs already overlap another child; parents are idle with no child running for 77% of session time. Typed data helps a script route on a verdict. It does not shorten reviews.
