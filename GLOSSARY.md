# pi-subagents

A Pi extension that lets one Pi session start other Pi sessions from agent definitions, follow them, and get their results back. This glossary fixes the words for that work.

## Language

### Sessions and runs

**Parent**:
The Pi session that launches children and gets their results.
_Avoid_: main session, orchestrator, caller, coordinator

**Child**:
A Pi session that a parent launched from an agent definition.
_Avoid_: subagent session, helper, worker

**Agent definition**:
A file that describes one kind of child: its purpose, model, tools and limits.
_Avoid_: agent type, role, persona

**Run**:
One execution of a child, from its launch or resume to its result. A resume starts a new run on the same child session.
_Avoid_: job, task, invocation

**Run id**:
The short name of one run. Replies, waits, resume and stop use it in place of a session path.
_Avoid_: handle, session reference

**Batch**:
The runs that one launch call starts.
_Avoid_: group, fan-out (as a noun for the set)

**Pane child**:
A child that runs in a surface where a person can watch it and type.
_Avoid_: interactive child, visible child

**Headless child**:
A child that runs as a process without a surface.
_Avoid_: background child, hidden child

**Takeover**:
The moment a person types or presses Esc in a pane child. From then on the child does not close by itself.
_Avoid_: operator mode, manual mode

### Results

**Result**:
The record that a run ends with: an outcome, a summary and a report file. A run has a result only when it ends while its parent process watches it, or when it is a verified fan-out winner that the origin or an authorized ancestor adopts.
_Avoid_: completion, output, response

**Outcome**:
The one-word state of a result: done, partial, blocked, failed, timed out or cancelled.
_Avoid_: status, verdict, exit state

**Completion call**:
The call a child makes to state its outcome, its summary, its artifacts and optional data.
_Avoid_: done call, final call, report call

**Typed result**:
A result whose outcome and summary come from a completion call. An **untyped result** is built by the parent from the child's last message because no completion call was made.

**Summary**:
The part of a result that enters the parent's context. It has a fixed maximum length.
_Avoid_: preview, digest (a digest belongs to a workflow script), body

**Report**:
The full final text of a child. It is kept in the report file and never enters the parent's context by itself.
_Avoid_: body, output, transcript

**Report file**:
The file that holds one run's report.
_Avoid_: handle, artifact (an artifact is a file the child chose to write)

**Delivery**:
The handover of one result to the parent: a wait returns it, or a message that carries it is committed to the parent session. Delivery happens at least once and does not mean that the model read the result.
_Avoid_: receipt, consumption

**Lookup**:
A request for a copy of a delivered result by its run id, or for the list of recently ended runs of a parent session. It changes nothing.
_Avoid_: replay, retrieval

### Orchestration

**Wait**:
The parent's blocking request for the results of named runs, or of all its outstanding runs.
_Avoid_: join, await, blocking launch

**Turn boundary**:
The point in a parent turn after a set of tool calls has ended and before the next model request, or the end of the turn.

**Workflow script**:
A script that the parent writes to launch a batch, wait for it and return one digest.
_Avoid_: workflow, pipeline, orchestration script

**Digest**:
The text that a workflow script returns to the parent.

**Launch cap**:
The largest number of runs a parent may start between two session starts.

### Finding agents

**Index**:
The short list of agent definitions that is always in the parent's system prompt. Its size has a fixed maximum.
_Avoid_: roster, catalog, ambient awareness

**Pinned agent**:
An agent definition that its author marked to appear first in the index.

**Model ref**:
The full name of a model with its provider and an optional thinking level. A **short model name** is a fragment that matches exactly one model ref an agent accepts.
_Avoid_: alias

### Multiplexers

**Backend**:
The adapter for one terminal multiplexer.
_Avoid_: mux type, driver

**Surface**:
A pane or tab that a backend opened for one pane child.
_Avoid_: window, terminal (herdr-core uses "terminal" for its own object)
