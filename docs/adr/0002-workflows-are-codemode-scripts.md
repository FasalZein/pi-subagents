---
status: accepted
---

# Workflow scripts run in Pi codemode with a wait tool

Measurements on 8 real parent sessions showed that this extension's own text is about 4.4% of parent input, while the parent's own reading and command output is about 57%. The largest saving is a parent that delegates a batch and never sees the intermediate results. That needs a place where code can launch children, wait, and keep results in variables.

We decided that this place is Pi's built-in codemode. The extension adds one blocking wait tool and typed tool results. It ships no script runner, no sandbox and no journal of its own.

## Considered options

- A workflow runner inside the extension with its own sandbox, journal and resume, as two other Pi extensions have. Rejected: a second scripting runtime of a week or more, and a second way to do one thing.
- A coordinator child that absorbs the batch. Kept as a recipe, not as a feature: it puts a model in the middle and is less repeatable than a script.

## Consequences

- A waiting script holds one of the two codemode workers of the Pi process and blocks the parent turn until it returns. Esc stops the wait, and the children keep running.
- A host without codemode still has the wait tool as a plain tool call. It gets the join, not the saving from script variables.
- A script cannot be resumed from the middle. A rerun launches the batch again.
