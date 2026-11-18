---
status: accepted
---

# herdr-core owns pane children on the Herdr app backend

The owner moves from the old herdr TUI to the Herdr app on herdr-core. Upstream PR #33 adds a Herdr app backend that asks the app to create each pane. Those terminals have no parent in herdr-core, so herdr-core cannot wait for them, cannot report their exit code, and does not tie their life to the parent.

We decided that the extension starts each pane child through herdr-core with the parent's terminal as its parent, and uses herdr-core's own exit signal. The app is asked only to give that terminal a pane. Detection, the placement planners, focus restore and the test fakes of PR #33 are reused.

## Considered options

- Take PR #33 as it is. Rejected: screen scraping for exit, no parent link, children always outlive the parent.
- Run headless children as hidden herdr-core terminals too. Deferred: a headless child's output is a pipe, and a herdr-core terminal is a PTY.

## Consequences

- herdr-core ends children when the parent terminal's program ends, and that program is the shell, not Pi. The extension still stops its children when the parent session closes.
- A child outlives the parent only when its agent definition asks for it.
- The split placement depends on one app command that no check has run yet. A new tab in the parent's space is the fallback.
