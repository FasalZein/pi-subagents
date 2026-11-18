---
status: accepted
---

# Workflow scripts run in Pi codemode with a wait tool

Measurements on 8 real parent sessions showed that this extension's own text is about 4.4% of parent input, while the parent's own tool calls and their results are about 57%. The largest saving is a parent that delegates a batch and never sees the intermediate results. That needs a place where code can launch children, wait, and keep results in variables.

We decided that this place is Pi's built-in codemode. The extension adds one blocking wait tool and typed tool results. It ships no script runner, no sandbox and no journal of its own.

## Considered options

- A workflow runner inside the extension with its own sandbox, journal and resume, as two other Pi extensions have. Rejected: a second scripting runtime of a week or more, and a second way to do one thing.
- A coordinator child that absorbs the batch. Kept as a recipe, not as a feature: it puts a model in the middle and is less repeatable than a script.

## Consequences

- A waiting script holds one of the two default codemode workers of the Pi process and blocks the parent turn until it returns. A third script waits up to 60 seconds for a worker and then fails without running. The recipe puts a time limit on each wait. Esc stops the wait, and the children keep running.
- A host without codemode still has the wait tool as a plain tool call. It gets the join, not the saving from script variables.
- A script cannot be resumed from the middle. After a failure the parent recovers the results by lookup, by run id or from the list of recent runs (ADR 0001), instead of launching the batch again.
- Amended 2026-11-18: inside codemode, the rule that a batch of only launches ends the parent turn, and the rule that a launch next to another call waits, do not apply. Pi gives an extension no way to end the turn after a codemode call, and a script receives a nested launch's data instead of its text. The rule against doing delegated work is therefore in the index, which the model always sees.
- A launch that fails partway returns the run ids of the children that started, so a script can wait for them or stop them.
