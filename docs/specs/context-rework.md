# Context rework: bounded parent context and better orchestration

Status: draft. Reworked on 2026-11-18 after the plan review returned BLOCKED; waits for a second review and then for owner approval. Baseline: upstream v2.9.2 (cf6dbf4). Branch: feat/context-rework. Date: 2026-11-18.

Terms in this document follow GLOSSARY.md. Decision records: docs/adr/0001, 0002 and 0003. The review and the answer to each of its findings are in ~/.pi/artifacts/pi-subagents/spec-plan-review.md and spec-plan-review-response.md.

## Problem Statement

I run long Pi sessions that delegate work to children. Two things go wrong.

The parent's context fills up. Each agent definition I add makes the parent prompt longer, because the roster lists every agent with every model it accepts. Each child that finishes puts its whole final message into the parent, with no limit. One report in my sessions was 29,993 characters. When I launch a batch, every result costs a parent turn and stays in context for the rest of the session.

The orchestration is not reliable enough to lean on. A parent cannot ask for the results of children it launched earlier, so it either blocks at launch or waits for messages one by one. Scratch tests against v2.9.2 reproduced a result that arrived twice, a result that nobody delivered, and a result that waited until I typed. A failed launch can leave an empty pane open. A background child that I stop is reported as completed or failed. A pane that I took over can close by itself. One malformed agent file stops every agent.

Measurements on 8 of my parent sessions (705 requests) corrected one belief. The extension's own text is about 4.4% of parent input. The parent's own tool calls and their results (reading, commands, and the code of those calls) are about 57%. So the larger saving is a parent that hands a batch to children and never sees the intermediate results.

I also move from the old herdr TUI to the Herdr app on herdr-core, and I use Rex. Neither has a backend. Each existing backend is a set of branches spread over at least seven files.

## Solution

A parent's context cost for delegation becomes flat and bounded, and delegation becomes dependable.

- I can add any number of agent definitions. The parent prompt holds a short index with a fixed maximum size. Full detail about one agent loads when the parent asks for it or when a launch needs it.
- Every run that ends while its parent watches it ends in one result with a typed outcome. The parent gets a summary of at most 1,500 characters and the path of a report file. The full report never enters the parent by itself.
- A parent can wait for runs it launched earlier. A workflow script can launch a batch, wait, branch on typed data, and return one digest, so the reports of the batch stay out of the parent.
- A result enters the parent model once. A result that a failed workflow script lost comes back once as a message. A result never waits for me to type, unless I pressed Esc at the moment it arrived. Results that are ready at the same turn boundary arrive as one message.
- When the context is under pressure, received results shrink to one-line stubs.
- Launch, stop, resume and takeover behave as their names say, and one bad agent file affects only that agent.
- deny-env holds on every backend. Pane children work in the Herdr app through herdr-core and in Rex, behind one backend interface that the five existing backends also use.

There is one mode. Nothing here is optional behavior behind a switch, except the two numeric settings named in the decisions.

## User Stories

Owner at the keyboard

1. As the owner, I want the parent prompt to stay the same size when I add agent definitions, so that I can keep one agent per job without paying for it in every request.
2. As the owner, I want each child result to cost the parent a bounded number of tokens, so that a long report cannot flood a session.
3. As the owner, I want the full report of every run that ends while its parent watches it kept in a file, so that nothing is lost when the summary is short.
4. As the owner, I want a result to reach the parent without my input, so that work continues while I am away.
5. As the owner, I want several results that are ready together to arrive as one message, so that a batch does not cost one parent turn per child.
6. As the owner, I want Esc during a wait to stop only the wait, so that I do not lose the work of running children.
7. As the owner, I want a child that I stop to be reported as cancelled, so that the parent does not treat it as finished or broken.
8. As the owner, I want a pane that I took over to stay open until I close it, so that an error does not take my session away.
9. As the owner, I want a failed launch to leave no empty pane, so that my layout stays clean.
10. As the owner, I want one malformed agent file to affect only that agent, so that a typo does not stop all delegation.
11. As the owner, I want to name a model by its provider and a short fragment of its name and have the launch pick the one matching model the agent accepts, so that I do not type full model refs.
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
22. As the owner, I want my agent definitions (10 on 2026-11-18) to work without edits, so that the switch to the fork is one step.
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
35. As a parent, I want a wait on a result I already received to return its outcome, data and report file without the summary, so that the same text does not enter my context twice.

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

Added after the plan review

54. As the owner, I want a child that outlives its parent to keep its session file and exit record, so that I can resume it by hand.
55. As the owner, I want the results that a wait returned to a workflow script that then failed or was aborted to reach the parent once as a message, so that finished work does not disappear.
56. As the owner, I want deny-env to hold on every backend, so that a name I deny never reaches a child.
57. As a workflow script, I want a launch that fails partway to return the run ids of the children that started, so that I can wait for them or stop them.
58. As the owner, I want to undo the switch to the fork in one step, so that a broken fork does not cost me a working setup.

## Implementation Decisions

Each decision has an id. Tickets cite these ids. A decision marked "(review)" changed or was added after the plan review of 2026-11-18; the response file maps each finding to it.

### Foundations

**D1. Fork and branch.** All work stays in the fork on branch feat/context-rework. Nothing is pushed and nothing is merged to main. No GitHub issue, comment or pull request is published. The owner uses the branch locally until upstream v3 arrives.

**D2. Pi version.** The extension requires Pi 1.5.2 or later. Compatibility with 0.85 ends. The peer and development dependencies move to 1.5.x, the pi-server pin is removed, and the one test fixture that fails to typecheck on 1.5.2 is fixed.

**D3. One mode.** (review) Orchestrator mode is removed with its controller, configuration, policy, prompt, overlay view, environment switch and tests. No handler in a parent session returns a whole system prompt; prompt additions use named sections or the append collection that Pi provides. A child keeps its whole-prompt returns (the time-limit text, and the composition of skills and appended system text) until D33 moves them (owner, 2026-11-18). The switch that turns off the coordinator-only turn (PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN) stays. The README gets a short migration note for the removed delegation-only restriction; there is no second mode.

**D4. Compatibility surface.** These stay as they are in v2.9.2: every agent frontmatter key and its meaning; the tool names subagent, subagent_resume, subagent_kill, subagent_done, caller_ping and set_tab_title; the environment variables; the launch metadata entry in child sessions; the message type subagent_result. Additions are new and optional: the frontmatter key pinned, the tools subagent_wait and subagent_agents, new optional tool parameters, two environment variables (D9, D17). Removed or changed, on purpose: the top-level single form of the launch parameters (D21), the roster message (D19), the subagent_ping message type for new deliveries (D13), and orchestrator mode (D3). Old sessions that contain roster or ping messages still load and render. (review) The unused fork session manager module stays until the rebase; removing it saves no tokens (owner accepted the cut, 2026-11-18).

### Runs

**D5. Run record.** One run has one record with one phase field and, at the end, one outcome. Phases: starting, running, soft limit reached, wrapping up, stopping, ended. The flags that today express the same facts (the dead execution-state field, the three delivery flags, the separate timeout markers) are derived from the phase or removed. The old delivery flags are deleted only after every consumer reads the phase.

**D6. Launch undoes what it made.** A launch registers each thing it creates as it creates it: the seeded child session file, the surface, the environment capsule, the spawn slot. When any later step fails, the launch removes all of them in reverse order and then reports the error. A spawn slot is released only by the run that holds it; releasing a count without an owner is removed. This fixes the open pane after a failed launch and the double slot release after a failed verified fan-out. (review) A fresh launch may delete a session file that it seeded. A resume never deletes the session it resumes; its cleanup leaves that file's bytes and its earlier exit record as they were.

**D7. Stop and abort.** A stop request decides the outcome. A run that was asked to stop ends as cancelled on every backend and for headless children, whatever the dying child wrote. The abort signal of a tool call reaches every wait, including the wait of a launch whose agent definition says the launch waits. (review) A time limit that expires gives timed out, never cancelled. Without a stop, the first outcome that reaches the exit record wins; a completion written before the hard deadline is never relabeled as timed out.

**D8. Resume.** (review) A resume accepts the run id of an earlier result or a session file. The two guards (the child ended under context pressure; the child was stopped by a time limit that forbids resume) are checked in the resume itself, so every caller gets them; the overlay keeps its explicit operator override. A resume reserves its session file before any asynchronous step, so a second resume of the same file is refused even when both start together. It reads the earlier exit and time-limit records, then moves them aside under a name of this resume before the new child starts. When the start fails, it puts them back, so the block-resume verdict still holds; when the child has started, it deletes them. Any exit record that exists after the start therefore belongs to the new run.

**D9. Launch cap.** (review) A parent starts at most 64 runs between two session starts. The count starts at 0 when Pi starts or replaces the session (new, resume, fork); a reload keeps it (owner, 2026-11-18). The count is held in memory. Every path that starts a child (the launch tool, the overlay and resume) takes its slot of the cap before any side effect, and gives it back when the child never starts. Each child in a children list counts once; a verified fan-out counts each candidate, as its spawn slots do; the internal wrap-up of a time limit does not count. A launch over the cap is refused with the count and the cap. The environment variable PI_SUBAGENT_LAUNCH_CAP changes the number. Spawn width, spawn depth, time limits and the context warning are unchanged.

**D10. Missing extensions.** (review) Before a launch and before a resume, each extension entry that does not resolve is dropped: a local path that does not exist, and an npm or git package entry that is not installed. The child starts with the entries that are left. Each dropped entry is named once in the launch or resume reply as "dropped missing extension: <entry>". The mandatory pi-subagents entry is never dropped; when it is missing the start fails as today. A resume keeps the saved list minus the missing entries and does not switch to the agent definition's current list. This changes one v2.9.2 behavior on purpose, as the prune brief asks: today an uninstalled npm or git entry passes to Pi, which resolves it as a temporary package at start; after this change it is dropped and named. An empty explicit list still means "no extensions" and stays distinct from no list. Trusted project scope, exact git refs and the mandatory entry behave as today.

**D11. Takeover.** After a takeover, nothing in the child requests shutdown. A provider error, a third run that ends at a tool call, or a recovery that runs out is shown in the pane, and the pane stays open until the person closes it or re-arms auto-exit. (review) After a takeover, a completion call records the result and does not close the pane (D12).

### Results

**D12. Completion call.** (review) Every child that can end by itself has the completion tool (the existing subagent_done, with new optional parameters): outcome (done, partial or blocked), summary, artifacts (paths the child wrote) and data (any JSON). A manual pane child has it too. The brief of each child states the 1,500 character limit and the call, in place of today's sentence about the final message. The tool refuses a summary over the limit once and states the limit; a second summary over the limit is cut and marked. A result is typed only when the call has a valid outcome and a summary that is not empty. A call without both (for example the old call with no arguments) still ends the child, and its result is untyped.

The report comes from this run only, that is, from the session entries after its launch or resume: the last assistant text written before the completion call or, without a call, before the nudge. Text written after the nudge counts only when there was none before it. The report is never the output of another tool and never text from before this run (fork history, or an earlier run of a resumed session). A run with no assistant text gets a report file that holds its summary and the line "no report beyond the summary".

When an auto-exit child is about to exit without a completion call, it gets one nudge per run. If it still makes no call, the parent builds an untyped result. A child never fails for a missing completion call. A child in report-only wrap-up (the time limit of D7) gets no nudge, because every tool is blocked there; its result is untyped, has outcome timed out, and is built from its text on the original deadline.

A caller_ping is recorded as outcome blocked, typed. Its message has the same 1,500 character limit as a summary, with the same one refusal, and the full message is also the report.

After a takeover, a completion call records the result and the pane stays open. When the pane closes, the result uses the last completion call if no assistant text came after it; otherwise the result is untyped and built from the last text.

**D13. Result record.** (review) A result is identified by its run id and its generation. Every run has generation 1; a verified fan-out retry adds a generation (D18). One result has one record with these fields: run id, generation, name, agent, title, model ref, outcome (done, partial, blocked, failed, timed out, cancelled), typed (yes or no), summary (at most 1,500 characters), report file, session file, artifacts, data, data error, elapsed time, exit facts (code, signal, reason), time-limit facts, context usage, and whether the run can be resumed, with the reason when it cannot. The record names the report file and does not hold the report text. The record and the report are two files in a results folder under the parent session's artifact folder. The extension does not delete them.

Only the parent process that watched the run writes them, once per run id and generation. Each file is written under a temporary name and then renamed. The report is written first, so a record never names a missing report. A second write with the same content changes nothing; a write with other content for the same run id and generation is refused and logged. A failed write (a full disk, a missing folder) keeps the summary in the result text and adds the line "report not saved: <error>"; a result never names a path that does not exist.

Results exist only for runs that end while their parent process watches them (owner, 2026-11-18). A child with parent-close-policy: continue that is still running when its parent process exits gets no result from the extension; its session file and its exit record stay, and the person resumes it by hand. No agent definition of the owner uses that policy today. For a no-session child the report is read from its temporary session file before that file is deleted, so the full text is kept; such a run cannot be resumed, and its record says so.

**D14. One assembler, one rendering.** (review) One pure module turns the facts of a finished run (how it ended, the child's session entries of this run, the completion call if any) into a result record and its report text (D12). Every path uses it: headless and pane children, the time-limit wrap-up, a time-limit kill, a stop, a watcher error, a ping, and the winner of a verified fan-out. With no completion call, the summary is the start of the report cut at a line end within the limit, with a mark that the result is untyped. One renderer turns a record into the text the parent sees: one header line (name, agent, outcome, elapsed time, typed or untyped, and "data error" when the data failed its schema), the summary, and a footer with the report file, the run id, the reason when the run cannot be resumed, and the context usage line when the agent definition asks for it (report-context-usage). Everything around the summary, warnings and the verifier footer included, is at most 400 characters. When the report path does not fit, the footer names the run id only, and subagent_wait on that id returns the path. The session path and the resume command line leave the text; the run id replaces them.

**D15. Delivery and receipt.** (review) The result of an ended run is in exactly one state: held (a wait claims it), queued (it waits for the next turn boundary), delivered (it was handed over: a wait reply returned it, or a message that carries it was committed to the session), received, or stub.

A delivered result becomes received when Pi starts a model request whose context holds the entry that carries it: the result message, the direct tool result of a wait or a launch, or the result of the codemode call whose script waited for it. A codemode result counts only when the script did not fail. When the script fails or is aborted after its wait returned, the results that the wait returned are queued again and go out once as a message (owner, 2026-11-18). Pi marks each nested call with the id of the codemode call that made it, and marks a failed script result as an error, so the extension knows which script had which result.

The transitions are a pure state machine. Events: a wait starts, the child ends, the wait returns, Esc during a wait, a turn boundary, a model request starts, a codemode call ends (with or without error), the turn ends (normally or aborted), the parent is idle, the context passes the threshold, the session closes or is replaced. A hold belongs to one wait call in one session; a session replacement releases every hold. Rules that the machine keeps, each a test:

- R1. The summary of a result enters scripts at most once and the parent model's context at most once.
- R2. While the session is open, the result of an ended run is in exactly one state.
- R3. A result is never queued or held while the parent is idle.
- R4. A result becomes a stub only after it was received.
- R5. A queued result is delivered at the next turn boundary, or at once when the parent is idle; a held result is returned or released when its wait ends; a delivered result is received at the next model request.

Queued results leave as one message of type subagent_result at the next turn boundary. When the parent is idle, the message is sent at once and starts a turn. One exception: results that are delivered or queued again in a turn that the person aborted with Esc are committed as one message that does not start a turn; they enter the next request when the person types (owner, 2026-11-18). Results of runs that end after that still start turns. No result is parked until the next user prompt in any other case. A wait that starts while a result is queued takes it. A result that was received stays received when the person moves to another branch of the session tree; a wait on its run id returns its record. When the session closes, queued and delivered results stay in their files and are not delivered. The existing rules for when a launch call waits (the agent definition says so, a headless or one-shot parent, a launch next to another tool call in one assistant message) stay, and such a launch waits through the same machine. The existing rule that a batch of only launches ends the parent turn stays for direct calls; D16 says why it cannot apply inside codemode. In a print-mode parent, the adoption of verified fan-out results at session start still starts no extra turn; the adopted message is received with the first request of the print run.

**D16. Wait tool and launch replies.** (review) subagent_wait takes a list of run ids (default: every run of this parent whose result is not yet delivered and that no other wait holds), a mode (all or any, default all) and an optional time limit in seconds. It returns when the mode is met or the limit passes. The reply has the rendered text of each result and, as structured data for scripts, the list of result records and the list of ids still pending. A run that another wait holds is listed as pending with the note "held by another wait" and is not claimed. A wait on a delivered or received result returns its record without the summary: outcome, typed, data, data error and report file, read from the record file. When the record file of a run id is missing (for example after the artifact root changed, or for a result from before this change), the wait says so and names the session file when it is known; it never invents a path. Esc stops the wait and releases its runs; they keep running and report by message.

The launch call and the resume call return the same structured data: for each child its run id, name, agent, model ref, whether it is a pane child, and its state, started or ended. A child whose launch waited (D15) is ended and carries its record. When a later child of a batch fails to launch, the reply is an error that names the children that started and carries their data, so a script can wait for them or stop them.

Inside codemode a launch returns at once unless the launch waits by the rules of D15. The mixed-batch rule and the launch-only turn end apply only to direct calls: Pi gives an extension no way to end the turn after a codemode call (a tool_result handler cannot set terminate, and codemode does not pass terminate on from a nested call). The launch reply says how results return and that the parent must not do the delegated work itself.

**D17. Stubs.** (review) When a parent turn ends, the context use is known, and it is at or above 60% of the model's window, every received result that is not yet a stub is replaced by its stub: one line per result with name, outcome, report file and run id. Each entry is edited at most once. In a reply that holds other text (warnings, several results), only the result blocks are replaced. A result whose report file is missing keeps its summary. Messages from before this change: a roster message is replaced by one line that says the agent list is now in the index; an old result or ping message gets a stub with its name and session file when it has one, and stays as it is otherwise. No stub names a file that does not exist. The replacement uses Pi's context edit entries, so the session file keeps the original. When the context use is unknown (for example just after a compaction), the step does not run. The environment variable PI_SUBAGENT_STUB_AT sets the percentage; 0 turns the step off. Results that a wait returned inside a workflow script were never in the parent context and are not touched. The first step after a crossing rewrites the cache from the oldest replaced result onward; later steps touch only recent entries. The live check of this decision measures cache read and cache write tokens before and after one step.

**D18. Verified fan-out.** (review) The feature stays. Its deliverable is a run id plus a result generation; a retry makes a new generation. Its winner report goes through the assembler and the renderer, so the summary limit, the report file and the 400-character envelope (verifier footer included) apply. The extension writes the delivery receipt of a generation at the moment the result is received (D15), not by searching the parent session file for a delivery id, because Pi does not save nested results. Adoption skips a generation that has a receipt. The lease, the authorization of recipients, the supervisor, the candidate isolation and the refusal to resume an attempt are unchanged. Its slots follow D6.

### Agent context, just in time

**D19. Index.** The roster message is no longer sent. At the start of each prompt the extension writes one named system-prompt section. Pi stores the section with the session, patches it only when it changed, and keeps it through compaction, resume and reload. The section is at most 1,600 characters. It holds two fixed lines and one line per agent:

    Helpers: launch with subagent (a children list). A result arrives as a message; subagent_wait joins now. A helper sees only its task text unless marked [fork].
    More tools: subagent_wait, subagent_resume, subagent_kill, subagent_agents (search, full detail).
    - reviewer: <first 100 characters of the description>
    - design: <first 100 characters> [pane] [manual]
    +488 more: subagent_agents with a query

Pinned agents come first, by name; then the others, by name; lines are added until the limit; the last line counts the rest. A flag appears only when the agent differs from the common case: [pane], [fork], [manual] (stays open until a person closes it), [waits] (the launch call waits). No model data, no rules block. An agent without a description is not in the index, as today. A child that may launch children gets the same section, filtered by what it may launch. (review) A child that may launch nothing gets no section and no launch tools, as in v2.9.2.

**D20. Agents tool.** (review) subagent_agents covers only the agent definitions that the caller may launch. With a name it returns that agent's full definition view: description, default model ref, accepted model refs grouped by provider, kind of child, session mode, limits, and what it may launch. With a query it returns the best matches (default 5), one line each. With no argument it returns the count and one line on how to search; it does not list pinned names. A malformed agent file is named here with its parse error when its name is one that the caller may launch. The overlay keeps its full operator view.

**D21. Tool declarations.** (review) The launch tool has one parameter shape: a children list of 1 to the spawn width, each with agent, name, title, task, and optional model, thinking and schema. The top-level single form is removed. Each rule is stated once: the rule about leaving the model unset sits in the model parameter only. The launch tool is declared in every session that may launch; the registration rules of v2.9.2 stay (no agent definitions, deny-tools, a spawn depth of zero). The wait, resume, stop and agents tools are registered as deferred when the session has codemode or tool search active, so their declarations cost nothing until asked for; in a host with neither they are declared directly. The choice is made at session start, after Pi has bound the runtime, because the active tool list cannot be read while the extension loads. A deferred tool stays callable from codemode when it is not active, so each tool also checks at call time that the caller may use it. Tool descriptions are one sentence. There is no separate prompt snippet per tool.

**D22. Model resolution.** (review) With no model in the call, the child runs on the agent's default. With a model in the call, the launch looks inside the agent's accepted model refs: an exact ref wins; otherwise the provider part must be equal and the model part may be a fragment, and exactly one accepted model must match. A fragment that matches two models of one provider is refused. A model named without a provider that matches under several providers takes the provider of the agent's default model, and is refused when that provider is not among the matches. When the accepted list has the matched model at several thinking levels, the thinking parameter picks one; without it the agent's default level applies if the list accepts it, else the first listed level. An agent without an accepted list takes any exact ref that Pi knows, and a fragment is matched against Pi's model list by the same rules. An agent with no accepted list and no default model runs on the parent's model, as today. The agent's default model counts as accepted even when its accepted list does not name it, as today. Every refusal names at most 8 matching candidates, grouped by provider, and points to subagent_agents with the agent name. An agent definition whose override switch is off ignores a model in the call and says so in the launch reply. A resume with a model applies the same rules. There is no alias table and no rewrite hook.

**D23. Facts at the point of use.** The launch reply has one line per child: agent, name, run id, the model ref that runs, pane or headless. It has one line for the batch that says how results return. Warnings and dropped extensions (D10) follow. An unknown agent name is refused with the three closest names among the agents the caller may launch. (review) A launch that fails partway names the children that started (D16).

**D24. One bad file.** (review) A malformed agent file is skipped. The other agents load. A launch of the bad agent is refused with its parse error. A malformed project file whose name matches a valid global agent is refused the same way; the global agent is not launched in its place. The person sees one notice per session that names the file.

### Children

**D33. Child prompt parity.** (review) A child keeps the whole-prompt returns of v2.9.2 (the time-limit and wrap-up text, the composition of skills and appended system text) until one slice moves them to named sections and appended text and proves the same behavior: skill visibility for =auto and =manual skills, an appended system text that the child inherits, the time-limit and wrap-up text, the fork boundary, and a child whose only tool host is codemode. That slice is not on the path to either goal.

### Workflow scripts

**D25. Recipe, not a runner.** (review) The README gets one recipe: a workflow script launches a batch, waits with a time limit, reads data, and returns a digest of at most about 1,500 tokens with report file paths and run ids. A script checks outcome, typed and data error before it branches on data. The recipe states these limits. At most two codemode workers run per Pi process by default (PI_CODEMODE_MAX_WORKERS changes it); a waiting script holds one. A third script waits up to 60 seconds, or less when its own deadline is shorter, and then fails without running. A cancelled worker keeps its slot until it exits. A waiting script must not depend on another script to unblock it. A script cannot be resumed from the middle; after a failure the parent recovers by run id (subagent_wait) or takes the results that come back as a message, and does not launch the batch again blindly. A steer is not an interrupt. Time and random values must come from outside the script if a rerun should repeat. A second recipe shows a child that may launch children as the coordinator of a batch. The extension ships no agent definitions.

### Backends

**D26. Backend interface.** One interface replaces the per-backend branches. A backend can: say whether it is available; open a surface with a placement request; start a command in a surface, or start a program directly as the surface's own process; read the last lines of a surface; close a surface; rename. Two optional abilities: report that the surface's process exited with its code, signal and reason; and accept a status record. Shared code asks for an ability and never tests the backend's name. cmux, tmux, zellij, wezterm and old herdr move behind the interface with no change in behavior, pinned by their existing fake-binary tests. One contract suite runs against every backend. (review) Each retained backend that is installed on this Mac also gets one live launch, resume and close check, including the zellij direct command and the old herdr work reporter. A backend that is not installed is reported as not run, never as passed.

**D34. Environment boundary.** (review) On every backend the child's environment is exactly: the parent's environment minus the names that deny-env and PI_SUBAGENT_ENV_DENY match, then the identity of the child's own surface, then the controlled overrides. The child launcher builds it, as in v2.9.2, so a name that only the multiplexer daemon has never reaches the child. The identity patterns gain the herdr-core names (HC_*) and the Rex names (REX_*), so a child sees its own terminal or block and never the parent's. A backend claims parity only after a presence check with synthetic marker names (a denied name in the parent, a denied name that only the daemon has, a wildcard deny) on launch, resume and time-limit restart. The check reports only whether each marker is present; it never prints an environment.

**D27. herdr-core backend.** (review) It is selected when the parent runs in an herdr-core terminal. A pane child is started through herdr-core's own API with the parent's terminal as its caller, notes to the parent turned off, and a unique label with the child's title. The terminal's own program is the child launcher with its capsule, and the launcher starts Pi with the environment of D34 (owner, 2026-11-18): herdr-core adds its daemon environment to any environment map, and a map cannot remove a name. The extension passes no environment map. There is no shell, no pasted command and no ready delay, and the launcher passes Pi's exit code and signal on. The child takes its surface name from its own HC_TERMINAL_ID, as a zellij child does from its pane id. The backend reports the exit through herdr-core's finished event: after it subscribes, it reads the terminal's state once, so a child that finished before the subscription still ends the watch with its exit facts. When a start request gets no answer, the backend looks the label up before any retry, so it never makes a second terminal. The result still comes from the child's exit record and session, as on every backend. Closing a surface is kill, then remove. Placement asks the app to give the new terminal a pane as a split beside the parent, and restores focus; when the app does not answer or the command fails, the child gets a new tab in the parent's space through a label. Placement is built only after the app checks prove it; when neither the split nor the tab is proved, pane children on this backend are reported as unavailable instead of opening without a visible surface. A child outlives the parent only when its agent definition says parent-close-policy: continue; in every other case the extension stops it when the parent session closes, because herdr-core ties children to the shell, not to Pi. When Pi dies without an orderly shutdown, its children keep running until the parent terminal's program ends. Detection, placement planning, focus restore and test fakes come from upstream PR #33, with credit in the commit. Headless children stay plain processes outside herdr-core.

**D28. Rex backend.** (review) It is selected when the Rex session and block variables are set and the rex binary is found. At first use it reads the Rex API revision and accepts only the range that the adapter was tested against (14 and later revisions that the checks of the Rex ticket confirm); any other revision makes the backend unavailable with a hint. A pane child opens as a split to the right of the parent block without taking focus, at most 2 per tab, then in a new tab. The new block gets a unique title. When a create command times out, the backend looks that title up before any retry, because a timed-out command may have succeeded. Text is sent, then Enter as a key. The screen capture is cut to the last lines and the extension buffers at most 256 KB of it, because rex capture has no line limit. The backend never sends to or closes the parent's own block, and it never acts on a parent block that no longer exists. Remote Rex servers and minimized layers are out of scope. The backend is built only after the Rex pane checks pass.

**D29. Detection order.** PI_SUBAGENT_MUX forces a backend, also when markers of several backends are present. Otherwise the order is herdr-core, Rex, old herdr, cmux, tmux, zellij, wezterm. Old herdr is detected only with its own pane variable, so the herdr variables that linger in a shell do not match.

**D30. Work status.** (review) On herdr-core and Rex the parent publishes one OSC 7501 side record that says how many children are outstanding. A run counts from its launch until its result is received, or until it is released by a stop or a session close; a queued, held or delivered result still counts, and a message with several results releases each of them. The record is cleared at zero. The extension clears only its own record, never Pi's status. One writer serves both backends. Old herdr keeps its present reporter.

### Rollout

**D31. One switch.** (review) The owner's Pi keeps loading the upstream package until every ticket has landed on the branch and both goals pass. Then the package entry and the agent definitions that name the upstream package switch to the local fork in one step. Before the switch, one command copies the package configuration, every agent definition that the switch changes, and both stand-in extension files into one snapshot folder; one restore command puts all of them back. A dry run goes forward and back once, with a child session saved before the switch, before anything is deleted. The owner approves the switch and, later, the removal of the stand-in files.

**D32. Upstream v3.** When v3 appears, the owner decides between a rebase and a port. D4 keeps both cheap. This spec plans neither.

## Testing Decisions

A good test here calls the extension the way Pi does, or calls one pure module with plain data, and checks what a parent, a child or a person can observe: tool replies, messages, files, calls to a fake multiplexer binary. It does not reach into a watcher's private state.

Seams, highest first:

1. **Extension boundary.** The existing pattern: a mock Pi that records tool registrations and fires events, fake multiplexer binaries on PATH, fake child processes. All tool, index, launch, stop, resume and delivery behavior is tested here, including the Pi scheduling cases of D15: a boundary append, Esc while the turn settles, a nested wait inside a script that fails, two overlapping waits, mode any and all with simultaneous ends, a partial time limit, and a session replacement. Tests assert a next model request that holds the result, or a result that a wait on its run id returns; the absence of a duplicate alone is not enough. Prior art: the launch result, wait, result router, spawn width and interactive delivery failure suites.
2. **Result assembler** (new pure module, D14). Input: run-end facts and session entries. Output: a record and a report text. Tests cover every outcome, the typed and untyped paths, the report source rules of D12, the limits, and the rendering length.
3. **Delivery state machine** (new pure module, D15). (review) Tests visit every distinct reachable state of two runs and two claimants (two waits, or one wait and the message path) and check R1 to R5 after each step. The test does not enumerate every event sequence up to a fixed length (owner accepted the cut, 2026-11-18). No new dependency.
4. **Backend contract suite** (D26). One set of tests that each backend must pass with its fake binary. Prior art: the herdr, cmux, zellij and poll suites.

The twelve reproduced or read defects each get one regression test at seam 1. (review) The ticket draft maps each of the 13 replays, and the three roster defects that were only read, to one named acceptance check. A scratch test that asserts the buggy value (for example a slot count of 0 where 1 is correct) is turned around, so the regression test is red on cf6dbf4 and green after the fix. The four target charts and R1 to R5 are the specification of D5 to D7, D11, D15 and D19; their rules are the names of the tests.

Live validation follows AGENTS.md: temporary agent definitions, a temporary session folder, parent and child sessions inspected, outcomes classed as duplicate, auxiliary or clean yield. (review) The live matrix covers detached, blocking, Esc, mixed, codemode-only and one-shot parents, resume, time limits, takeover, fork, frontmatter branches, environment-variable branches in both states, and the backend lifecycle. A live check that is skipped is not a pass. Live runs use two models of one family, and the behavior checks run once more on a model of another family. The owner names the model refs for each live run; they are written neither in the repository nor in the tickets.

(review) While a slice is built, only the affected tests run. The full suite and the structure gates of AGENTS.md (typecheck, biome, knip, file sizes) run once per landed batch (owner accepted the cut, 2026-11-18).

### Measurement plan

(review) Both goals are gated by checks that run without a person. Character counts gate the bounds in tests. A token figure in this section is an estimate, characters divided by 4. Live runs report real provider tokens for each request next to that estimate (owner, 2026-11-18): code and non-Latin text use more tokens per character, and recorded input in the measured sessions was 1.14 to 1.47 times the estimate.

Fixtures: a sanitized copy of the owner's agent definitions (10 on 2026-11-18) with their description lengths, flags and model lists, frozen with the probe; a generator for 100 definitions. Model refs come from the environment.

Goal 1, parent context.

| Check | Method | Pass |
|---|---|---|
| G1.1 Fixed cost | The probe loads the extension into a mock Pi with the frozen fixture and captures the section text and every declaration that a request carries, in three loadouts: codemode on, codemode only, neither. Live, for information: one request with the extension on and one with it off, with the same prompt and active tools; the difference in recorded input tokens per model | At most 6,000 characters (about 1,500 tokens) in each loadout |
| G1.2 Flat in agents | The same probe with 100 generated definitions, and with 100 that are all pinned | The same 6,000 character cap; the section at most 1,600 characters; subagent_agents with no argument at most 200 characters; a launch of an agent that is not in the index works |
| G1.3 Bounded result | Render results whose reports are 400 to 30,000 characters, typed and untyped, with code, non-Latin text, a 600-character report path, warnings, a verifier footer and a data error | Every rendered text at most 1,900 characters (about 475 tokens) |
| G1.4 Scripted batch | Live: a workflow script launches 8 children that each write a 20,000 character report with a first and a last marker, waits, and returns a digest that lists all 8 validated outcomes and their report files. Endpoint growth is the number of characters the parent context gained from the request before the script to the request after it, read from the session file | Growth at most 10,000 characters (about 2,500 tokens); all 8 report files exist and hold both markers; recorded input tokens reported |
| G1.5 Share, for information | After the switch, rerun the session share measurement on at least 5 new parent sessions, with cache read and cache write tokens | Reported, no limit |

Goal 2, orchestration better than v2.9.2.

| Check | Method | Pass |
|---|---|---|
| G2.1 Benchmark | Three frozen scenarios on v2.9.2 (cf6dbf4) and on the branch commit under test, both on Pi 1.5.2, each on two models with a fixed thinking level, three runs each, medians per model. (a) A recon batch of 6 read-only children, launched directly; the fixture repository holds 6 planted facts, one per child, and one more fact that is only in a report and not in its summary. (b) A batch of 8 review children with 8 planted verdicts (known pass or fail), through a workflow script on the branch and through direct launches on v2.9.2. (c) One build child that fixes a failing test, then a review child, then one fix round; a test run decides the outcome. Interactive parents get the prompt after startup. One retry on a provider error, counted. Per run: cumulative parent input (input plus cache read plus cache write over all parent requests), the parent request count, the outcome classes, and the results duplicated, lost or parked, counted by run id with a deadline of 10 minutes without user input | (a) and (b): cumulative parent input at least 30% lower; (c): not higher. Every counted run gives all 7 facts in (a), all 8 verdicts in (b) and a passing test in (c); a wrong answer fails the run. The share of clean-yield outcomes is not lower in any scenario. Zero results duplicated, lost or parked on the branch. Parent requests not higher. Child cost reported, not gated |
| G2.2 Checklist | One test or live repro each | A parent joins runs launched in an earlier call; results ready at one boundary arrive as one message; every result has an outcome; a launch over the cap is refused; Esc stops a wait and the children continue; a script that fails after its wait gives its results back once |
| G2.3 Rules | The tests named after R1 to R5 and the chart rules | All pass |

(review) Order: the benchmark harness and the v2.9.2 baseline runs come first, before any rewrite. One early run of scenario (a) on the branch follows the first real result path, so the first saving is measured early. The branch runs for the gate come last, one scenario and one model per job. The fixtures (the repository, the temporary agent definitions, the prompts, the planted facts and verdicts) live with the benchmark script.

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
- (review) Results of runs that end after their parent process exited (D13), and any daemon or process that would write them.
- (review) A way to end the parent turn after a workflow script that only launches; Pi has no mechanism for it (D16).
- (review) A list of recent results in the wait tool; with the receipt of D15, a failed script's results come back as a message.
- (review) A tokenizer per model in the tests.
- (review) Removal of the unused fork session manager module (until the rebase).
- A push, a merge to main, or any publication on GitHub.
- A plan for upstream v3.

## Further Notes

### Not verified yet

Each item is a ticket step or an acceptance check, not an assumption to build on.

1. The Herdr app did not answer on its socket in two tries. Unverified: the app command that gives an herdr-core terminal a pane as a split, its focus effect, whether it changes the terminal's keep setting, the tab created through a label, a label added later, how the app shows a child without a pane, the JSON of the app's list, status and layout commands on 0.1.21, whether herdr-core types a note into the parent, and how the app shows a side status record. Observed without the app: ending only the foreground program leaves children alive; the environment map merges; the caller alone sets the parent; the finished event carries the exit code; the first line of an event stream is a snapshot, not an event. (review) Not run: a terminal whose program is the child launcher, and a label lookup after a start request without an answer.
2. Rex: split, send, capture and close were read from help text and other projects, not run inside a Rex pane. Whether text plus Enter reaches a Pi pane reliably is unknown. (review) Also unknown: whether the shell of a new block sets REX_BLOCK to that block, and how a timed-out create looks.
3. Pi 1.5.2 behavior read from code and docs, not run: a waiting codemode script has no time limit; the abort reaches the nested tool; a steer sent during a script is delivered after the tool batch; a context edit can target a custom message and take a short replacement; a section is patched in place and survives compaction; a deferred tool is reachable from codemode without tool search. Also from the earlier recon: the child skills rewrite still matches the 1.5.2 prompt; a handler that returns a whole system prompt forces the prompt; the prompt-start hook also fires for runs that a message started; a child started without extensions has no codemode unless its extension list names it. (review) Also read, not run: nested calls carry the id of the codemode call that made them (types.d.ts:879-901); a failed script result is marked as an error (codemode execute.js:576); entries returned at the settle boundary are committed when the run is aborted, and the continuation is suppressed (extensions.md:695); a tool_result handler cannot set terminate (types.d.ts:1134-1140).
4. The three roster defects (two copies after reload or resume, none after compaction, stale after a file change) were read from code and not replayed. D19 removes the mechanism.
5. The cost of one stub step is reasoned, not measured: the first step after a crossing rewrites the cache from the oldest replaced result; later steps rewrite only recent entries. The live check of D17 and G1.5 measure it.
6. No measurement exists of parent tokens for scripted against direct batches on this extension. G2.1 is that measurement. (review) Risk: in scenario (a) the saving comes from bounded results alone, and the 4.4% share does not predict whether it reaches 30%. The early run after the first real result path shows the trend; if (a) misses, the owner decides.

### Evidence

All under ~/.pi/artifacts/pi-subagents/:

- session-context-share.md, context-cost-map.md: the measurements and the two probes.
- internals-map.md, sm-delivery-turn.md, sm-run-lifecycle.md, sm-child-side.md, sm-roster-policy.md: how v2.9.2 works, as transition tables.
- statecharts/pi-subagents-statecharts.html: eight checked charts, four of v2.9.2 and four of this design, with their TLA+ models beside them. (review) The result chart models one child and one wait and does not model receipt; R1 to R5 and seam 3 replace it as the specification of D15.
- bugpath-replay.md and bugpath-replay-tests/: the 13 replays.
- pi-api-recon.md, pi-codemode-facts.md: Pi 1.5.2 mechanisms.
- herdr-core-recon.md, hc-owned-children-facts.md, hc-live-checks.md, rex-backend-brief.md: the two new backends.
- reviewer-time-share.md: where child and parent time goes.
- orchestration-patterns.md, pi-subagent-variants.md, agent-scale-research.md: outside patterns.
- spec-plan-review.md, spec-plan-review-response.md, review-claims-verification.md: the plan review, the answer to each finding, and a fact check of its code citations.
- ~/.pi/artifacts/pi-pstack/product-briefs/pi-subagents-prune-missing-extensions.md: the brief behind D10.

### One measured correction

The owner expected reviewers to take most of the time. In 1,748 child runs, workers take 43.8% of child wall time and reviewers 20.4%; 85% of reviewer runs already overlap another child; parents are idle with no child running for 77% of session time. Typed data helps a script route on a verdict. It does not shorten reviews.
