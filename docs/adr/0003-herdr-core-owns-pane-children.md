---
status: accepted
---

# herdr-core owns pane children on the Herdr app backend

The owner moves from the old herdr TUI to the Herdr app on herdr-core. Upstream PR #33 adds a Herdr app backend that asks the app to create each pane. Those terminals have no parent in herdr-core, so herdr-core cannot wait for them, cannot report their exit code, and does not tie their life to the parent.

We decided that the extension starts each pane child through herdr-core with the parent's terminal as its parent, and uses herdr-core's own exit signal. The app is asked only to give that terminal a pane. Detection, the placement planners, focus restore and the test fakes of PR #33 are reused.

Amended 2026-11-18 after the plan review: the terminal's own program is the existing child launcher, not Pi. herdr-core adds its daemon environment to any environment map that a start request carries, and a map cannot remove a name, so a name on deny-env that the daemon has would reach Pi. The launcher builds the child environment from the parent snapshot minus denied names, the child's own surface identity and the overrides, as it does on every other backend. The child takes its surface name from its own herdr-core terminal id.

## Considered options

- Take PR #33 as it is. Rejected: screen scraping for exit, no parent link, children always outlive the parent.
- Run headless children as hidden herdr-core terminals too. Deferred: a headless child's output is a pipe, and a herdr-core terminal is a PTY.
- Pi as the terminal's own program, with an environment map. Rejected after the review: deny-env would not hold on this backend.

## Consequences

- herdr-core ends children when the parent terminal's program ends, and that program is the shell, not Pi. The extension still stops its children when the parent session closes. When Pi dies without an orderly shutdown, its children keep running until the shell ends.
- A child outlives the parent only when its agent definition asks for it.
- The exit watch reads the terminal state once after it subscribes, because the first line of the event stream is a snapshot and a fast child can finish before the subscription.
- The split placement depends on one app command that no check has run yet. A new tab in the parent's space is the fallback. When neither is proved, pane children on this backend are reported as unavailable.
