# pi-subagents

`pi-subagents` is a highly curated multi-agent framework for [Pi agent harness](https://github.com/earendil-works/pi).

It began as a fork of [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), then grew into a monumental refactor: named agents, interactive panes, background workers, async parallelism, blocking agents, child-to-parent communication, forked context, a beautiful TUI widget, and much more!

Use it when one agent should hand work to another agent instead of trying to do everything in one transcript. Interactive children open in the Herdr app (herdr-core), Rex, Herdr, cmux, tmux, zellij, or WezTerm; background children run headlessly.

https://github.com/user-attachments/assets/e0b97493-6c9b-4710-ba26-a6c08230ba28

## Acknowledgements

Special thanks to [@FasalZein](https://github.com/FasalZein) and [@isthatyousaf](https://github.com/isthatyousaf) — for their contributions, ideas, and for providing access to frontier models like GPT and Claude, which made it possible to experiment and build this extension. Good guys, I owe them a lot!

## 🌐 **Join the Community**

> [!NOTE]
> **Building with AI doesn’t have to be a solo grind.**  
> Join our Discord community to meet other people exploring the latest models, tools, workflows, and ideas: **https://discord.gg/whhrDtCrSS**
>
> We talk about what’s new, what’s useful, and what’s actually worth paying attention to in AI.  
> *And if you want more than conversation,* members also get access to **heavily discounted AI products and services** — including deals on tools like **ChatGPT Plus** and more for just a few dollars.

## Install

pi-subagents requires Pi 1.5.2 or later.

```bash
pi install git:github.com/edxeth/pi-subagents
```

## The model

A subagent is a named agent file plus a launch policy.

The agent file says who the child is and how it should run. The parent still owns the decision to launch it. The child owns the task it receives.

Two axes matter:

- `interactive` or `background`: where the child runs
- async or sync: whether the parent waits

`interactive` means foreground. Pi opens a visible surface through the Herdr app, Rex, Herdr, cmux, tmux, zellij, or WezTerm. Normal launches use a backend-specific surface, such as a tab, window, split, or stacked pane.

`background` means headless. Pi starts a `pi -p` child process without opening a pane.

Async means the parent gets a launch reply with run ids, and each result comes back later. Sync means the parent waits for the results before it continues. [Launching and waiting](#launching-and-waiting) describes both.

### Interactive mux backends

Interactive children open in your current terminal backend. `pi-subagents` supports seven backends:

| `PI_SUBAGENT_MUX` | Backend | Detected when |
| --- | --- | --- |
| `herdr-core` | The Herdr app, through herdr-core | Pi runs in a herdr-core terminal (`HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET` are set), the `hc` command is on `PATH`, and the Herdr app answers |
| `rex` | Rex | `REX_SESSION` and `REX_BLOCK` are set and the `rex` command is found on `PATH` or in `REX_BIN_DIR` |
| `herdr` | The Herdr TUI | `HERDR_PANE_ID` is set |
| `cmux` | cmux | Pi runs in a cmux surface |
| `tmux` | tmux | Pi runs in a tmux pane |
| `zellij` | zellij | Pi runs in a zellij pane |
| `wezterm` | WezTerm | Pi runs in a WezTerm pane |

Start `pi` inside the backend you want to use. Leave `PI_SUBAGENT_MUX` unset to let Pi detect it: Pi tries the backends in the order of the table. Set `PI_SUBAGENT_MUX` to one value of the first column to force that backend, also when the markers of several backends are present.

The backend command must exist, and Pi must be able to see the current pane or session context. If no supported backend is active, or the parent has no UI, a new `subagent` launch of an interactive agent runs headless as a background child, with no pane. A resume of an interactive session fails with a setup hint instead, and so does `set_tab_title`. In Rex, `set_tab_title` also reports that the multiplexer is not available: Rex has no tab or workspace title that it can set.

Normal launches use a backend-specific surface:

- The Herdr app opens a child as a split beside the parent pane. The split moves the app's focus, so Pi focuses the parent pane, splits it, and puts the saved focus back; the parent pane can show focus for under a second. When the split fails, the child gets a tab in the parent's space. Pi starts the child launcher as the program of the new terminal, with no shell and no startup delay.
- Rex opens each child in a new window (the app's tab) of the parent's Rex session by default. With `PI_SUBAGENT_REX_PLACEMENT=split`, it opens a child as a split to the right of the parent block, at most 2 per window, and then in a new window of the same session. Pi never moves the focus. See [Rex placement](#rex-placement). Pi reads the Rex API revision from `rex whoami` and accepts revision 16; another revision makes the backend unavailable with a hint. Remote Rex servers and minimized layers are not supported.
- The Herdr TUI keeps children beside the parent while the tab has room, then uses dedicated tabs for overflow. Every Herdr child pane is labeled with its session title, such as `[reviewer] Auth implementation review`. See [Herdr placement](#herdr-placement).
- Other backends may use windows, splits, or stacked panes.

In the Herdr app and in Rex, the parent publishes a status record with the count of its outstanding children, and clears it at zero. A child counts from its launch until its result is delivered, or until a stop or a session close releases it. Old Herdr keeps its pane metadata count, where a delivered result counts until the parent has read it and settled idle.

### Removed: orchestrator mode and ambient awareness

The parent no longer gets the hidden roster message that older versions called ambient awareness. The [agent index](#agent-index) replaces it: one system-prompt section with one line per agent, and the `subagent_agents` tool for the rest.

Earlier versions had an orchestrator mode for the parent session. It removed every parent tool except `subagent`, `subagent_resume`, `subagent_kill`, and `set_tab_title`, and it replaced Pi's system prompt with a delegation-only prompt.

This version removes that mode with its `/subagents` tab, its saved default for new conversations, and the `PI_ORCHESTRATOR_MODE` variable. The parent keeps all of its tools and Pi's own system prompt. Pi ignores `PI_ORCHESTRATOR_MODE` and the orchestrator entries that older conversations saved, so you can delete the variable from your shell configuration.

A conversation that used orchestrator mode keeps its restricted tool set after the upgrade, also after `/reload`, because Pi restores the tools that the conversation saved. pi-subagents does not change that tool set for you. To get the tools back, do one of these:

- Start a new conversation with `/new` or a plain `pi`.
- Continue the old conversation and add the tools again, for example `pi --continue --tools +read,+bash,+edit,+write`.

Children are not affected. With `PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN=1`, a successful async launch still does not end the parent turn.

## Agent definitions

Agents live here:

- `.pi/agents/` in the project
- `~/.pi/agent/agents/` globally, or `$PI_CODING_AGENT_DIR/agents/` when that env var is set

Project agents override global agents with the same name.

A minimal agent:

```md
---
name: scout
description: Inspect the codebase and report the relevant files.
mode: background
auto-exit: true
tools: read,grep,find,ls
---

You are a codebase scout. Find the relevant files, read enough to be useful, and return a concise map of what matters.
```

The `description` matters. The parent routes on its first 100 characters in the [agent index](#agent-index).

For a fuller example of the intended style, see the [scout agent gist by edxeth](https://gist.github.com/edxeth/11b6a6cdf7c6068771a5e3f96ab5e34b). It shows the shape this package works best with: a sharp role, an explicit contract, and little room for interpretation.

### Frontmatter reference

| Field | Default | What it controls |
| --- | --- | --- |
| `name` | filename | Stable agent name used by `agent: "..."` |
| `description` | unset | One-line routing hint for the agent index |
| `enabled` | `true` | Set `false` to hide and block the agent. `Space` on the `/subagents` Agents tab flips this value in the agent file |
| `model` | Pi default | Child default model, including optional thinking suffix. When unset, the child inherits the parent's model. |
| `thinking` | model default | Child thinking level. When unset, the child inherits the parent's thinking level. |
| `allow-model-override` | `true` | Whether the parent Pi session may launch or resume this agent with a different model or thinking level. Leave it alone if you want to choose models per task from the parent chat. Set `false` when this agent should always use the model written in its file. |
| `allowed-models` | unset | Extra exact model refs the parent may choose when `allow-model-override` is enabled. The agent `model` is implicitly allowed and does not need to be repeated. `provider/model` allows any thinking level for that model; `provider/model:thinking` allows only that thinking level. |
| `cwd` | parent cwd | Working directory for the child |
| `extensions` | `all` | Which extension code loads in the child: `all`, `none`, or a comma-separated allowlist |
| `tools` | `all` | Child tool availability: `all`, `none`, or a comma-separated allowlist of Pi tool names. Lists may include built-in, extension/custom, and protocol tools. `none` disables built-in tools while preserving extension/custom tools unless denied. |
| `deny-tools` | unset | Final comma-separated tool names to remove from the child after built-in tools, extensions, and protocol tools are selected |
| `skills` | `all` | Child skill availability: `all`, `none`, or a comma-separated allowlist resolved by skill name. Entries may carry a visibility annotation: `name=auto` advertises the skill in the child's system prompt even when its frontmatter disables model invocation; `name=manual` hides it from that child only. |
| `inject-skills` | unset | Comma-separated skills to load into the child prompt before the task |
| `no-context-files` | `false` | Skip project context-file discovery in the child, including `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md`. Pi loads these files independently of project approval. |
| `inherit-append-system` | `false` | Let Pi load the child's applicable global or trusted-project `APPEND_SYSTEM.md` file |
| `no-session` | `false` | Use an ephemeral child session file and delete it after completion. When the parent watches the run to its end, the report is kept in the result files. The run cannot be resumed |
| `trust-project` | `false` | Whether interactive child launches pass Pi's `--approve` flag and trust project-local files/settings. Background children always generate `--no-approve` for safety; use `flags` only as an explicit advanced override. |
| `auto-exit` | `false` | Close the child after a normal completion. Background launches always use `true`; `false` is ignored there. |
| `pinned` | `false` | `true` lists the agent first in the agent index. The index is a system-prompt section of at most 1,600 characters with one line per launchable agent; agents that do not fit are counted, and `subagent_agents` finds them. |
| `system-prompt` | task body | `append` adds the agent body to the child's own Pi system prompt (Pi's default unless the child has an applicable `SYSTEM.md`); `replace` replaces that base prompt with the agent body. The parent agent's system prompt is never inherited. |
| `session-mode` | `lineage-only` | `standalone`, `lineage-only`, or `fork` |
| `flags` | unset | Extra CLI flags passed to the child pi process (e.g. `--verbose` or `--some-custom-flag`). Appended after all generated args — last-wins semantics against conflicting generated args, including `--approve` / `--no-approve`. Use only as an advanced escape hatch for extension-registered flags or pi built-in flags not covered by other frontmatter fields. |
| `env` | unset | Line-based `KEY=VALUE` pairs passed as environment variables to the child process. Use YAML block syntax for values with commas or `=`. `PI_CODING_AGENT_DIR` is special: when set here, it is resolved before launch and becomes the child's Pi config/session root. `~/` is expanded. Internal PI vars such as PI\_SUBAGENT\_\* still take precedence if names conflict. |
| `deny-env` | unset | Comma- or newline-separated environment variable names that the child does not inherit from the parent. `*` is a wildcard. Names that match nothing are ignored. Values set with `env` are never filtered. |
| `task-expansion` | unset | Set `shell` when the task may include shell placeholders that Pi resolves before launch. Pi runs each placeholder from the child's target `cwd`, gives it 30 seconds, replaces it with captured output, and gives that prepared task to the child. The command receives `PI_WORKSPACE`; long output is cut with `[output truncated]`. Leave unset unless you trust the task text to execute shell commands. |
| `context-warn-threshold` | `off` | Send the sub-agent a wrap-up warning when its context window reaches this percentage (`1%`–`99%`). Two more warnings follow at each `context-warn-step` above it. Example: `80%` warns at 80%, 85%, and 90%. |
| `context-warn-step` | `5%` | The percentage gap between each warning (minimum `1%`). A warning above 99% moves down to 99% so it still arrives before compaction. Decimals round down. |
| `report-context-usage` | `true` | Add the child's final context use to the result that the parent receives. |
| `timeout` | unset | Whole seconds for the whole run. Pi stops the child at this limit. Omit for no limit. |
| `idle-timeout` | unset | Whole seconds without output from the child. Pi stops the child at this limit. Omit for no limit. |
| `llm-as-a-verifier` | `false` | `true` turns every launch into a best-of-N run: several attempts in isolated git worktrees, an LLM verifier picks the best one, the parent gets one result. See [LLM-as-a-verifier](#llm-as-a-verifier). |
| `llm-as-a-verifier-candidates` | `3` | Number of attempts per launch. Integer `>= 2`; the upper bound is the spawn-width ceiling (16). |
| `llm-as-a-verifier-model` | none — **required** | The verifier model: `provider/model[:thinking]` (example: `deepseek/deepseek-v4-flash:high`) or a profile name (example: `fast` loads `.pi/agents/verifiers/fast.md`). The backend must return API logprobs. |
| `llm-as-a-verifier-criteria` | `generic` | What the verifier judges by: a built-in name (`generic`, `code-change`, `research`), your own criteria file by name (`fix-focus` loads `.pi/agents/criteria/fix-focus.md`), or a path. |
| `timeout-warn-threshold` | `false` | Reserve the remainder of the first threatened limit for reporting. At this percentage (`1%`–`99%`), the parent interrupts the active child and restarts the same session in report-only mode. `true` means `80%`. Decimals round down. Any other value turns the policy off. |
| `on-timeout` | `report` | What the parent can do after a limit stops the child. `report` keeps `subagent_resume` available, and the new run gets the same limits. `block-resume` refuses the resume. Any other value fails to load. |
| `spawning` | `false` | Let this child launch subagents of its own. `true` lets it launch any agent. A comma-separated list of agent names (for example `spawning: researcher, reviewer`) lets it launch only those agents. |
| `spawn-depth` | `1` | How many levels of subagents may run below this child. Each subagent it launches gets one less. A subagent left with `0` has no launching tools, so the chain stops. Omit to use the default. |
| `spawn-width` | omitted | The most subagents this child may run at the same time. Must be a positive whole number. Omit for no limit (a hard ceiling of 16 always applies). |
| `visible-to` | `all` | Who may launch this agent: `all` (anyone), `root` (only the top-level session), or a comma-separated list of agent names. |
| `async` | `true` | `false` makes the launch sync |
| `mode` | `interactive` | `interactive` pane or `background` process |
| `parent-close-policy` | `terminate` | What happens to the child when the parent session exits: `terminate` (kill) or `continue` (leave running). A `continue` child that ends after its parent exits gets no result record. With `no-session: true` it also keeps no session file and no exit record |

Use YAML block syntax for more than one env var:

```yaml
env: |
  PI_CODING_AGENT_DIR=~/.pi-scout/agent
  PI_SAFETYNET_DEFAULT_MODE=explore
  SOME_VALUE=value,with,commas
```

Pi splits `env` by line. It does not split values by comma. When you set `PI_CODING_AGENT_DIR`, the child uses that directory for its Pi config and sessions. For per-agent Herdr, Rex or Zellij placement, set `PI_SUBAGENT_HERDR_PLACEMENT`, `PI_SUBAGENT_REX_PLACEMENT` or `PI_SUBAGENT_ZELLIJ_PLACEMENT` here. The parent reads placement before the child pane exists. See [Herdr placement](#herdr-placement), [Rex placement](#rex-placement) and [Zellij placement](#zellij-placement).

Children inherit every environment variable from the parent Pi process, in every launch mode. This includes API keys and tokens that you exported before you started Pi. `deny-env` in an agent file removes names from this inheritance. You can also set `PI_SUBAGENT_ENV_DENY` in the parent environment. Both lists apply.

A resume applies the `deny-env` that the session saved before its first launch, in every session mode. A session that saved none, for example a `standalone` session from an older version, takes the current `deny-env` of the agent that `subagent_resume` names. Without an agent name, or when the agent has no definition, the resume stops with an error.

A pane child also gets the identity variables of its own pane, which replace the parent's. In the Herdr app, Rex and the Herdr TUI, the child gets only these names from its surface, and no parent value of these names:

| Backend | Required names | Names copied when present |
| --- | --- | --- |
| Herdr app (`herdr-core`) | `HC_TERMINAL_ID`, `HC_TERMINAL_SOCKET`, `HC_SCOPE` | none |
| Rex | `REX_SESSION`, `REX_BLOCK` | none |
| Herdr TUI | `HERDR_ENV`, `HERDR_PANE_ID` | `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH`, `HERDR_CONFIG_PATH` |

When the surface does not set a required name, or `env` names one, the launch stops with an error before Pi starts. Other names in `env` still reach the child, denied names included. On every backend, the child also takes `TERM` and `COLORTERM` from its surface, also when `deny-env` names them. On these three backends, any other name that only the multiplexer server has never reaches the child. In the Herdr app and in Rex, the child launcher builds the environment from a launch capsule, because the parent's environment does not reach the new terminal.

Known limit: in tmux, cmux, WezTerm and Zellij the child gets every pane variable that starts with `TMUX`, `CMUX`, `WEZTERM`, `ZELLIJ` or `HERDR`, and `TERM` and `COLORTERM`. `deny-env` does not remove such a name when only the pane or the multiplexer server has it.

`trust-project` controls Pi's project-local trust boundary for resources such as settings, extensions, skills, prompts, themes, `SYSTEM.md`, and `APPEND_SYSTEM.md`. The default `false` passes `--no-approve`, even when the parent project was previously approved. Project context files are separate: Pi still loads applicable `AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md` files unless `no-context-files: true` passes `--no-context-files`. Background children always generate `--no-approve`; `flags` is the explicit advanced escape hatch if you need to override that safety default.

`task-expansion: shell` prepares task context before launch for small models that should not have to plan tool calls. It is opt-in because the parent task text becomes shell input and runs in the parent Pi process before the child starts. Commands execute in source order from the child's effective `cwd`; each placeholder gets 30 seconds before Pi inserts a timeout diagnostic. Use `$PI_WORKSPACE` or `${PI_WORKSPACE}` inside the shell command to read the workspace path from the environment. Use explicit shell placeholders:

````md
Summarize the files changed.

Inline status: !`git status --short`

Changed files:
```!
git diff --name-only
```

Follow these conventions:
!`cat daily-git-brief.md`
````

Pi expands those placeholders into command output before writing the child task artifact. Ordinary Markdown code fences are treated as literal examples, so inline placeholders inside language-tagged code fences such as `sh` or `text` do not execute. Plain standalone lines like `!git status` are not expanded; use inline ``!`git status` `` or a fenced shell command block. Because project-local agent files can opt into this behavior, only use `task-expansion: shell` in agents whose launch tasks you trust to become shell input.

`context-warn-threshold` turns on context warnings for a child agent. The child process checks how full its context window is after each completed model turn, once the full tool-result batch is visible, and again when the agent finishes. If the total crosses a threshold, the child sends itself a warning for the next model turn.

Warnings are advisory: the model needs another successful turn to act on one. A single unbounded tool batch can jump from below the first threshold directly into Pi's native compaction or context-overflow recovery before the child can wrap up. Keep tool output bounded; the warning policy does not replace output truncation or Pi's compaction safeguards.

Each warning shows the token count and the percentage, for example `160K/200K tokens (80.0%)`. The three warnings get more urgent, so the child stops new work and returns its best result before the context compacts.

Both fields take whole percentages. Decimal values round down. Omit the field, or set `context-warn-threshold: off`, to turn the warnings off.

```yaml
---
name: researcher
context-warn-threshold: 80%
---
```

With the default `5%` step, `80%` warns at 80%, 85%, and 90%. Set `context-warn-step: 10%` to space them at 80%, 90%, and 99%. (The third lands at 100%, so it moves down to 99% to arrive before compaction.) If usage crosses two or more thresholds in one turn, Pi sends only the most urgent one. The child holds each warning only while its usage stays at or above that percentage. A reload at the same usage does not repeat a warning, but a drop below the threshold — after compaction, for example — releases it, so a child that keeps working is never left without warnings.

A child that wraps up on the **last** warning did what it was told, so the parent must not read the short result as a premature exit. Pi marks that case in the footer of the result it sends to the parent:

```text
not resumable: stopped early by its context-warning policy and its context window is spent; launch a fresh sub-agent for unfinished work
```

Only the last warning counts. A child that sees an earlier warning and then finishes its work normally is reported as an ordinary completion, and stays resumable. A child that fails with a provider error is reported as a failure, never as an instructed wrap-up.

A child that fails after the last warning is a failure, not a wrap-up, so the parent keeps the cheap retry. Its result says the context window is spent and that a fresh sub-agent is usually better, and `subagent_resume` still works on it. Only a warning-driven wrap-up is blocked.

Warnings only ever come in three stages, and the last stage is the one that says to stop. A setting that cannot reach three stages, such as `context-warn-threshold: 99%`, still warns the child but never blocks it, because the child was never told to stop.

`report-context-usage: false` hides the token counts but still reports the early stop, because a parent that does not know the reason resumes a child that cannot work.

`subagent_resume` also refuses such a session, because resuming it gives the child no room to work. You can still resume it yourself from the `/subagents` overlay.

### Stop a runaway child with time limits

Every child runs with no time limit. `timeout` and `idle-timeout` are two separate limits. You can set one, both, or neither.

```yaml
---
name: scout
timeout: 900
idle-timeout: 180
timeout-warn-threshold: 80%
---
```

`timeout` is a clock on the whole run. It starts when the child process or pane launch begins. Inherited fork history consumes zero seconds of this clock. Use it for a child that can work forever without finishing.

`idle-timeout` measures time without output. Use it for a child that stops working and never reports, for example one that waits inside a tool that never returns.

Only the child's own work counts as output. Its messages and completed tool results count. A message that Pi writes into the child's session does not count. Time inside one long tool call counts as silence, because the call has not produced a result.

That last rule is the purpose of the field. A child stuck inside a tool call is what `idle-timeout` catches. But a slow build looks the same to Pi. Set `idle-timeout` higher than the slowest tool call the child makes.

The idle clock starts at launch, not at the child's first word. A child that hangs before it says anything must also be caught. Set the value high enough for the process start and the first model reply. A few tens of seconds is the smallest useful value.

Both fields take whole seconds. If the value is not a positive whole number, the agent file fails to load. A typo must not become "no limit", because that is the problem the field prevents.

Both limits work for a background child and for a child in a pane. For a background child, Pi sends `SIGTERM` to the process group. Five seconds later Pi sends `SIGKILL`, but only while the process group is still alive. For a child in a pane, Pi closes the pane, because there is no separate process to signal. If the close fails, Pi tries again. If every try fails, the result says so.

When both limits are set, neither resets the other. The first hard limit reached stops the child. If `timeout-warn-threshold` is enabled, the first soft threshold reached starts one wrap-up phase; the other soft threshold no longer starts a second one.

#### Reserve time for a final report

`timeout-warn-threshold` is off until you set it. It is an enforced soft deadline, not a queued advisory steer.

The child receives its clock contract before its first model call. It includes the launch timestamp and says explicitly that inherited or forked conversation consumed zero seconds. The child must use the supplied timestamps instead of estimating elapsed work from transcript length.

At the threshold, the parent acts from its own process:

1. For a background child, it terminates the child process group.
2. For an interactive child, it closes the child pane.
3. It reopens the same session with forced auto-exit and a report-only prompt.
4. The child extension blocks every new tool call in that continuation.
5. The original hard deadline stays fixed. Restart time comes out of the reserved remainder.

This is why a long-running tool or custom TUI cannot suppress the wrap-up. Pi normally delivers a steer only after active tool calls finish, and synchronous child code can block the child's event loop. The parent does not wait for either path.

The wrap-up child reads a standalone message shaped like this:

```text
This clock belongs to the current logical sub-agent run. A process restart for
wrap-up does not reset it. Conversation inherited or forked when the original
child was spawned consumed zero seconds of it. The elapsed and remaining values
below are authoritative; do not infer time from the transcript.

Time limit: you have been running for 720s, and your limit is 900s for this
whole run. About 180s remain. At the limit the system stops you, and work you
did not report is lost. Stop taking on new work. Report your result now, even
if it is incomplete.

The parent runtime interrupted your previous active operation at the warning
threshold so the remaining time is reserved for this report. Do not retry the
interrupted tool, call any tool, or begin new work. Summarize
only the committed work visible in this session and report what remains
unfinished.
```

For `idle-timeout`, the hard deadline that triggered the wrap-up is pinned. Output from the report-only continuation does not buy a fresh full idle interval.

`no-session: true` remains ephemeral. The child always writes its private temporary session file, so the wrap-up restart reads the interrupted transcript from it. The parent deletes the file after the final result and does not expose a resumable session.

If the wrap-up completes, the parent receives a result such as:

```text
auth-scout · scout · done · 12m3s · untyped · ended by time limit
Mapped the auth flow. The session layer still needs verification.
report: ~/.pi/history/app/artifacts/<session>/results/<run>/report-1.md
run: <run>
wrap-up: 900s for the whole run: the parent interrupted the run before its limit and kept the rest for this report; expect a short or partial report and check what remains
```

A wrap-up that ends on its own shows the outcome of its report, as in v2.9.2: `done` after a clean exit, `failed` after a nonzero exit, a child error or an empty terminal stop. The result is untyped, because the report-only run gets no completion call; a completion call or `caller_ping` from before the restart does not decide it. In every one of these ends the header says `ended by time limit`, the footer names the limit, and the record keeps `wrapUp: true` in its `timeLimit`. A wrap-up that the hard deadline kills is `timed_out`. Its session stays resumable unless another policy blocks it.

The trade-off is deliberate: a legitimate slow tool is cancelled at the threshold. If losing that tool run is worse than losing the final report, leave `timeout-warn-threshold` off and use only the hard limits.

#### What the parent receives

A stopped child cannot report its own result, so the parent reports it:

```text
auth-scout · scout · timed out · 15m0s · untyped
Mapped the auth flow. The session layer is untouched.
report: ~/.pi/history/app/artifacts/<session>/results/<run>/report-1.md
run: <run>
time limit: 900s for the whole run: a resume gets the same limit and can stop at the same point; finish the work yourself or start a new sub-agent with a smaller task
```

The summary is the start of the partial work. To continue, pass the run id to `subagent_resume`, which applies the same limit again. A plain `pi --session` run has no limit.

#### Resume after a stop

A resume is allowed by default. A time limit means that the child ran out of clock. It does not mean that the session is broken.

A resumed run gets the same limits as the first run. A child that loops stops again at the same point instead of running forever. This is why a resume is safe to allow.

Use the `subagent_resume` tool to continue the work. A plain `pi --session` run is not a tracked child, so that run has no limit.

Set `on-timeout: block-resume` when a second partial run is not safe. An example is an agent that writes to something outside the repository. Then `subagent_resume` refuses the session, and the result footer says that the run cannot be resumed. You can still resume the session yourself from the `/subagents` overlay; that override applies only to that one resume.

The block-resume verdict stays until the resumed run ends. The published outcome of that run decides, not its exit status: a done, partial or blocked result removes the verdict, and a new timeout replaces it. A cancelled resumed run leaves the verdict in force, so a non-idempotent agent stays blocked. A resume that fails before the child starts, a failed run, and a parent that exits during the run also leave the verdict in force, so a later `subagent_resume` is still refused.

`parent-close-policy: continue` remains intentionally detached. If the parent exits, it no longer owns either timeout clock, so strict enforcement is no longer guaranteed for that surviving child.


### Report final context use to the parent

`report-context-usage` controls one line in the child result. The default value is `true`.

With the default value, the parent receives a result such as this:

```text
auth-scout · scout · done · 3.0s · untyped
Reviewed the authentication flow and found the files that require changes.
report: ~/.pi/history/app/artifacts/<session>/results/<run>/report-1.md
run: <run>
context: 145000/200000 tokens
```

The last line shows the context use when the child finished. The parent can use this number before it resumes the child.

Set the field to `false` to remove the last line:

```yaml
---
name: scout
report-context-usage: false
---
```

The parent then receives this result:

```text
auth-scout · scout · done · 3.0s · untyped
Reviewed the authentication flow and found the files that require changes.
report: ~/.pi/history/app/artifacts/<session>/results/<run>/report-1.md
run: <run>
```

This field changes only the text that the parent receives. The TUI still shows the context use to the user.

Named-agent frontmatter wins over duplicate launch-time fields such as `tools`, `cwd`, and `mode`. `model` and `thinking` are different: while you are in a parent Pi session, you can ask Pi to run a subagent with a specific model or thinking level for that one launch or resume. That works by default. If an agent file sets `allow-model-override: false`, Pi ignores those per-launch model choices and uses the model from the agent file, or the inherited Pi model if the file does not name one. Use that opt-out for agents whose quality, cost, or safety depends on a specific model.

Use `allowed-models` when an agent should have a small exact model menu:

```yaml
---
name: reviewer
model: zai/glm-5.1:high
allow-model-override: true
allowed-models: openai/gpt-5.5:low, nahcrof/glm-5.1:off, anthropic/claude-opus-4-8
---
```

`model` is the default and is always allowed. `allowed-models` lists the other models Pi may use for this agent, so you do not need to repeat `model`. The `:thinking` suffix is optional: `provider/model:low` allows only that thinking level, while `provider/model` allows the model with whatever thinking level Pi resolves. If `allow-model-override: false`, Pi ignores launch-time and resume-time model choices as usual. A launch without a model in the call runs on the default and grants it as v2.9.2 does: a bare `model` that several providers carry takes the parent's provider, so the default is accepted even when `allowed-models` names only other models.

## LLM-as-a-verifier

This implements the [LLM-as-a-Verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier) technique ([paper](https://arxiv.org/abs/2607.05391), [Python library](https://pypi.org/project/llm-verifier/)): the agent runs several attempts at the task in parallel, and a second LLM picks the best one.

```yaml
---
description: Best-of-N implementation worker
model: zai/glm-5-turbo:high
llm-as-a-verifier: true
llm-as-a-verifier-candidates: 3
llm-as-a-verifier-model: deepseek/deepseek-v4-flash
llm-as-a-verifier-criteria: code-change
---
```

### What happens on a launch

1. Pi checks that the source tree is a clean Git repository. Then each attempt gets its own [git worktree](https://git-scm.com/docs/git-worktree). A worktree is a private copy of the repo. It separates the file changes of each attempt. It is not a sandbox: paths outside the repo, the network, and shared services stay shared. All attempts get the same task.
2. When the attempts finish, the verifier LLM reads what each attempt did. It scores the attempts against the criteria file. At least two attempts must give different results. If all attempts give the same result, or the verifier cannot tell them apart, the run fails. Nothing is applied to your tree.
3. You get one result: the report of the winning attempt, plus a short footer. If the winner changed code, the change is staged in your working tree. It is not committed. Inspect it with `git diff --staged`. If your tree changed during the run, nothing is applied, and the winner stays on a Git branch. The report file names the branch; the footer names it too unless a launch warning takes its room.

A run continues if you close or reload the parent session: a detached supervisor owns it end-to-end. The report is delivered only to the session that launched the run, or an ancestor of it — whichever starts next — and waits on disk until then. To stop a run early, kill the child with `subagent_kill` from the launching session; other sessions are refused unless you confirm the cancel yourself in the `/subagents` overlay.

The verifier makes many small API calls: a 3-attempt run with the `code-change` criteria makes about 72 calls. Budget accordingly.

### The verifier model

You must set `llm-as-a-verifier-model`. If you do not, the launch fails and the agent asks you what to use. The agent does not pick a model for you and does not edit your files.

You write one of two forms:

- **`llm-as-a-verifier-model: provider/model`** — pick the model directly. Example: `deepseek/deepseek-v4-flash`. Add `:high` for more reasoning, `:low` for less: `deepseek/deepseek-v4-flash:high`.
- **`llm-as-a-verifier-model: name`** — pick a profile file. Example: `fast` loads `.pi/agents/verifiers/fast.md` from your project, or the same file under your global Pi directory. A profile holds the same things you would write in the field, plus an env block for a server you run yourself (vLLM, llama.cpp):

```yaml
# .pi/agents/verifiers/lab.md
---
model: qwen3-32b
env: |
  OPENAI_BASE_URL=http://10.0.0.5:8000/v1
  OPENAI_API_KEY=whatever-the-lab-uses
---
```

Where the URL and key come from, in order:

1. The env block of the profile, if you used one.
2. The provider entry in your Pi config: `models.json`, then `models-store.json` (what Pi's `/login` wrote).
3. Your exported `DEEPSEEK_API_KEY` or `VERTEX_API_KEY` alone. The library then calls the official DeepSeek or Google Vertex endpoint.
4. Your exported `OPENAI_BASE_URL` (and `OPENAI_API_KEY` if the server needs one). This serves providers that Pi does not know, such as your own vLLM or llama.cpp server for example.

One rule holds everywhere: a provider named in the field always uses its own URL. A stray `OPENAI_BASE_URL` in your shell never redirects a deepseek or gemini choice. If nothing names a working URL, the launch fails with an error that says what to set.

#### Which backends work

The library speaks one format: the OpenAI Chat Completions API with `logprobs` (the [OpenAI `logprobs` field](https://platform.openai.com/docs/api-reference/chat/object)). The verifier reads these numbers to score attempts.

- Works: OpenAI, DeepSeek, Google Vertex (Gemini), and any self-hosted OpenAI-compatible server (vLLM, SGLang, llama.cpp).
- Does not work: Anthropic and other non-OpenAI formats (no library client), and most proxies and aggregators (they strip the logprobs field).

Before anything is paid for, Pi sends one small request to the backend you chose. If the backend does not return usable logprobs, the launch stops there. That one request is the only cost of a wrong pick.

### Criteria

`llm-as-a-verifier-criteria` sets what the verifier judges by. Three built-in templates ship with the extension: `generic` (the default), `code-change`, and `research`.

- **Your own file** — a bare name loads `.pi/agents/criteria/<name>.md` from your project, or the same file under your global Pi directory. A project file with a built-in name replaces that built-in.
- **Path** — a value with a `/` in it is a path, relative to the launch directory.

## Agent index

At the start of each prompt, Pi writes one named system-prompt section, `index`, into the parent prompt. Pi stores the section with the session, patches it only when it changes, and keeps it through compaction, resume, and reload. The section has at most 1,600 characters: three fixed lines, then one line per agent that the session may launch.

```text
Helpers: launch with subagent (a children list). A result arrives as a message; subagent_wait joins now or looks up a run id. A helper sees only its task text unless marked [fork].
Do tiny work yourself. Use each named helper once, no substitutes. Do not redo delegated work. Ask when ownership is unclear.
More tools: subagent_wait, subagent_resume, subagent_kill, subagent_agents (search, full detail).
- reviewer: Review a diff for bugs and missing tests. [pane] [manual]
- scout: Inspect the codebase and report the relevant files.
```

Each agent line holds the name and the first 100 characters of the `description`. Agents with `pinned: true` come first, by name, and then the other agents, by name. When the next line does not fit in 1,600 characters, the last line counts the rest: `+<n> more: subagent_agents with a query`. A session whose launches always wait, such as a `pi -p` parent, gets the fixed line `Launches wait.` too. The second line holds the v2.9.2 routing rules in short form. The index names only the tools that Pi lets the session call (an excluded, inactive or hidden tool is left out; a deferred one counts). Without `subagent_wait` the first line drops its clause. Without `subagent_agents` the agents that get no line, including agents without a description, are named on a last line, `More agents: a, b, c.`; agent lines give way to it until every name fits, and names that still do not fit are counted (`+<n> not shown`). When another extension replaces the whole system prompt, before or after this one, the index goes into each request as a leading message instead; the replaced prompt and the session file stay unchanged. In a child, a whole prompt composed earlier gets the section appended, as before.

A flag shows only where an agent differs from the common case:

- `[pane]`: the child opens in a pane. A prompt start does not probe for a multiplexer: the flags follow the detection of the latest launch. Before the first launch, a UI session shows the flags with the line `[pane] and [manual] need a multiplexer; without one a helper runs headless and closes itself.`
- `[fork]`: the child sees the parent transcript (`session-mode: fork`). Without the flag, the child sees only its task.
- `[manual]`: the agent has `auto-exit` off, so the pane stays open until a person closes it. The child has no `subagent_done` and cannot close the pane itself (see [`subagent_done`](#subagent_done)).
- `[waits]`: the launch call waits for the result (`async: false`).

An agent without a `description` is not in the index, and it stays launchable. A child with `spawning` gets the section filtered to the agents it may launch. A child that may launch nothing gets no section and no launch tools.

### Find the management tools

`subagent` is declared in every session that may launch. When codemode or tool search is active at the first prompt, Pi registers `subagent_wait`, `subagent_resume`, `subagent_kill`, and `subagent_agents` as deferred: they are not in the active tool list until tool search loads them, and a codemode script calls them as `tools.subagent_wait` and so on. Without codemode and tool search, Pi declares them directly. `subagent_wait` and `subagent_agents` refuse a call when the session may not launch. `subagent_resume` and `subagent_kill` do not: a session that may not launch can still resume and stop children, and only their own `deny-tools` entry removes them.

### Look up an agent with `subagent_agents`

`subagent_agents` covers only the agents that the caller may launch. It takes one of two parameters:

| Parameter | Reply |
| --- | --- |
| `name` | The full definition of that agent: description, default model ref, accepted model refs grouped by provider, kind of child, session mode, limits, and what it may launch |
| `query` | The best matches for the words, one line each. `limit` sets the number of matches: 1 to 50, default 5 |
| neither | The count of agents and one line on how to search |

A call with both `name` and `query` is refused. A malformed agent file is named here with its parse error.

### One malformed agent file

Pi skips a malformed agent file and loads the other agents. A launch of that agent is refused with its parse error. A malformed project file whose name matches a valid global agent is refused the same way, and the global agent does not run in its place. The person sees one notice per session that names the file. When a valid definition of the same name shadows a malformed file, the notice lists that file apart and does not call the agent refused: the valid definition takes its place, under its own launch rules.

## Launching and waiting

### Launch children

`subagent` takes one child as top-level fields, or several in `children`: a list of up to the spawn width of children, each with the same fields. An empty `children` list starts the child of the top-level fields, as in v2.9.2. When a model sends `children` as a JSON string, the launch parses it. No other argument string is parsed: a JSON string in a launch field or in the `ids` of `subagent_wait` stays a string. The fields are:

| Field | Required | Meaning |
| --- | --- | --- |
| `agent` | yes | Name of the agent definition |
| `name` | yes | Lower-kebab handle: 2 to 4 words joined by hyphens, at most 32 characters, such as `auth-scout`; one word, such as `build`, is refused |
| `title` | yes | Sentence-case title of 3 to 8 words, such as `Auth implementation map` |
| `task` | yes | The work for this child |
| `model` | no | A model for this launch. See [Model names](#model-names) |
| `thinking` | no | A thinking level for this launch, such as `high` |

The launch reply has one line per child, then one line that says how the results return, then warnings:

```text
- auth-scout (agent scout): run <run>, model <provider/model>, headless
Each report arrives later, and this turn may stop after this call so the reports can arrive; do not poll, redo the delegated work or claim its results.
```

A launch waits for its results, and the reply holds them, when the agent has `async: false`, when the parent has no durable turn, or when the call shares a tool batch with a sync launch (see [Mixed sync and async batches](#mixed-sync-and-async-batches)). A direct launch next to a call of another tool, such as `read`, also waits, unless `PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN=1`. Inside codemode, a launch returns at once unless it waits by these rules.

`Esc` during a launch or `subagent_resume` that waits stops the child it waits for, as in v2.9.2. A launch of an agent with `async: false` and a launch that waits because the parent has no durable turn ignore `Esc` and keep waiting. `subagent_wait` keeps its own `Esc`, which stops only the wait.

An unknown agent name is refused as in v2.9.2, with the requested name and the search locations and no other agent name: `Error: agent "<name>" was not found in .pi/agents/ or <agent dir>/agents.` When a later child of a batch fails to launch, the reply is an error that names the failed child and lists the children that started, by run id. Wait for them with `subagent_wait` or stop them with `subagent_kill`.

### Model names

Without `model`, the child runs on the default model of its agent. With `model`, exact model ids resolve as in v2.9.2:

- An exact `provider/model` ref names that model. A literal id with a colon, such as `provider/name:free`, stays whole.
- A model id without a provider that one provider carries resolves to that provider. When several providers carry it, the parent's provider wins on launch and the previous run's provider on resume; otherwise the call is refused as ambiguous.
- The level is the `:level` suffix of `model`, else `thinking`, else the agent's `thinking` (on resume: the previous run's level), else the parent's level. `allowed-models` checks that level and never picks one.
- Only when no exact id matches does `model` count as a fragment. Pi then searches the accepted models of the agent (its `model` and its `allowed-models`), or Pi's model list when the agent has no `allowed-models`. `provider/fragment` matches when exactly one model of that provider contains the fragment. A fragment without a provider that matches under several providers takes the provider of the agent's default model, and is refused when that provider is not among the matches.

A refusal while matching a fragment names at most 8 matching candidates, grouped by provider, and points to `subagent_agents` with the agent name. A model that `allowed-models` refuses after it resolved, at its level, gets the v2.9.2 refusal that lists the allowed models. An agent with `allow-model-override: false` ignores `model` and says so in the launch reply. `subagent_resume` applies the same rules to its `model`. The launch reply names the model ref that runs. Resume and timeout wrap-up pass Pi the same model the run passed, even when the record names the registry ref of a bare default.

### Launch admission

Only the spawn width limits launches. It counts the runs that run at the same time, not the runs that a session started before. A launch that the spawn width refuses starts nothing and returns an error result. In a codemode script, the refusal rejects the `tools.subagent` call.

### The result of a run

Every run that ends while its parent process watches it ends in one result record. The parent gets a short rendering of it. The full report stays in a file and never enters the parent by itself. When the report file cannot be written, the rendering says `report not saved` and stays capped like every other copy. The session keeps the full report in memory: `subagent_wait` with the run id of an already delivered run (a lookup) returns the rendering followed by the line `Full report (not saved to a file):` and the full report. Only that lookup is longer than 1,900 characters; deliveries, waits and the recent list stay capped. The full report is gone when the session closes or the process exits.

The record holds the run id, name, agent, title, model ref, outcome, `endedBy`, `typed`, summary, report file, session file, artifacts, data, data error, end time, elapsed time, exit facts, time-limit facts, context usage, and whether the run can be resumed, with the reason when it cannot. The outcome is `done`, `partial`, `blocked`, `failed`, `timed_out`, or `cancelled`. A run that a person or the parent stopped ends as `cancelled`. `endedBy` says who ended the run: `child` (its completion call, `caller_ping`, its own exit, or a crash), `operator` (a person closed the pane, also after a takeover, or stopped the run from the `/subagents` overlay), `parent` (`subagent_kill` or another stop of the parent), or `time_limit` (a hard kill or a report-only wrap-up). The header of the rendering names the ender only when it is not `child`, for example `· ended by operator`. A run is typed only when the child made a valid completion call: a `caller_ping`, or a typed `subagent_done` in a session from before auto-exit children lost that tool (see [`subagent_done`](#subagent_done)). An untyped summary is the start of the report, cut at a line end. A typed run's artifacts are the paths the child listed in its call. An untyped run's artifacts are the paths of the child's successful `write` and `edit` calls of this run, direct or from a script, as absolute paths against the child's working directory, without duplicates, in the order of the first write.

The rendering has a header line, the summary, and a footer:

```text
auth-scout · scout · done · 3.0s · untyped
Reviewed the authentication flow and found the files that require changes.
report: ~/.pi/history/app/artifacts/<session>/results/<run>/report-1.md
run: <run>
```

The summary has at most 1,500 characters. The header and the footer together have at most 400 characters, and the whole text has at most 1,900 (a lookup of an unsaved report adds that report, see above). Only a report path that does not fit in the 400 characters makes the frame longer, and then Pi cuts the summary further. The footer names the report file by its shortest path that Pi's `read` tool resolves. It never holds the session path or a resume command line.

Each run has its own folder: `results/<run id>/` under the artifact folder of the parent session, `~/.pi/history/<project>/artifacts/<session id>/` (`PI_ARTIFACT_PROJECT_ROOT` changes `~/.pi/history`). The folder holds `record.json` and the report files. Pi never deletes it.

Results exist only for runs that end while their parent process watches them. A `parent-close-policy: continue` child that ends after its parent process exited gets no result record. Its session file and exit record stay for a resume by hand, unless the child has `no-session: true`: then Pi deletes both when the child exits, and nothing is left to resume.

Verified fan-out is the one exception to the watched-only rule: its supervisor delivers to the launching session or an ancestor that starts next. A verified winner is stored under `vf-runs/<run id>/` in the project artifact folder, not in the session's `results/` folder. `subagent_wait` with `recent` does not list it, and after a restart a lookup by its run id can answer `No result record`. In a codemode script, an ended verified child can carry `record: null`. Keep the report path from the result of a verified run. When the results folder cannot be written, the result text says `report not saved: <error>`, the session keeps the record in memory until it closes, and the person sees a notice.

### Delivery: at least once

When a watched run ends, Pi writes its result files and then hands the result over: to every `subagent_wait` that waits for that run, or else as a `subagent_result` message. A message leaves at the next turn boundary, or at once when the parent is idle, and starts a turn. All results queued at one boundary leave as one message. A result never waits for you to type, with two exceptions. If you press `Esc` while the turn settles, the results of that aborted turn enter the next request when you type. If you press `Esc` during a `subagent_wait` or a launch that waits, the results that the wait already held leave as one message that starts no turn. Runs that end later still start turns.

Pi hands each result over once by itself and does not check whether the model read it. A copy can come from a lookup, from an interrupted wait that gives its results back as a message, or from a verified winner that Pi adopts again because no receipt confirmed the first delivery. Every copy has the same size limit. One result can therefore reach the parent twice, for example in a wait reply and in a message after an interrupted wait. A closed or replaced session gets no more deliveries; its results stay in their files for a lookup after a resume.

### Wait, look up, and list runs with `subagent_wait`

| Parameter | Default | Meaning |
| --- | --- | --- |
| `ids` | every run of this session that is running or queued | Run ids or names to wait for |
| `mode` | `all` | `all` returns when every run ended; `any` returns when one ended |
| `timeout` | none | Time limit in seconds. Pending runs then report by message |
| `recent` | `false` | `true` returns at once one line per ended run of this session: the last 20, newest first. `ids`, `mode`, and `timeout` are ignored |

The wait returns when the mode is met or the time limit passes, and at once when there is nothing to wait for. The reply has the rendered results, the pending run ids, and the run ids it did not find. Two waits on one run both get its result. `Esc` stops the wait; its runs keep running and report by message.

A wait on a run whose result was already delivered is a lookup: it returns the same rendering at once from `record.json`. A lookup changes no state. The recent list holds the run id, name, outcome, and end time of each run, never full results; find an older run by its run id. A run id that is neither running nor recorded gets the answer `No result record for "<id>".`, with the session file from the launch metadata when this process knows it.

#### Mixed sync and async batches

When one tool-call batch contains at least one sync/blocking subagent, the whole batch becomes a barrier. Pi still launches every child with its own frontmatter, so an `async: true` child keeps async launch metadata for resume, but the parent waits until every child in that batch completes and receives all results as tool results.

```
subagent(sync), subagent(async), subagent(async) → all launch
→ parent waits until all three finish
→ returns all three completed results
```

Pure async batches stay detached: the parent receives the launch reply, and each result arrives later as a message or in a `subagent_wait` reply.

After a pure async launch, the parent should get out of the way unless it has separate work. If the parent keeps solving the delegated task, you paid for two agents to race each other.

By default, a successful async launch ends the parent turn after the current tool batch. The children keep running. Their results come back later.

A parent without a durable turn cannot receive a later message, so it waits for every launch instead: `pi -p`, `--mode json`, `--mode rpc`, and any session without a UI. Every `mode: background` child is a `pi -p` process, so a background child that has `spawning` always receives its children's reports as tool results and the turn continues. The stop above applies only to parents that can receive the later report. A `subagent_resume` from such a parent waits the same way. In an interactive parent started with a prompt, such as `pi "task"`, the launches of that first prompt wait too.

```bash
PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN=1 pi
```

That only removes the runtime stop. The parent still owns only work it did not delegate.

## Workflow scripts

A workflow script is one `codemode` call that launches a batch, waits for it, and returns a short digest. Only the digest reaches the parent model, so the reports of many children cost the parent a few hundred tokens instead of their full text. The extension ships no workflow runner and no agent definitions: copy the recipes below and change the inputs.

To give a parent codemode, start Pi with the built-in codemode extension:

```bash
pi -e builtin:codemode --tools +codemode
```

In a script, `tools.subagent` and `tools.subagent_wait` resolve to objects, not text. `tools.subagent` gives `{ status: "launched" | "launch_failed", children, failed? }`. Each child has a `runId` and a `state` of `started` or `ended`. An `ended` child also has its result `record`. `tools.subagent_wait` gives `{ status, results, pending, missing }`. Each entry of `results` has the run's `runId`, its launch `name`, its rendered `text` and its `record`; with `ids`, the entries come in the order of those ids, and without `ids` the running runs come in launch order, then the ended runs not yet delivered. Join them to the launch children by `runId`. Each `missing` entry has the requested `runId` and an `error`. A launch that the spawn width refuses starts nothing and returns an error result, so the call rejects and the script fails. A launch error before the first child starts, such as an unknown agent, rejects the call, and the script fails with nothing started.

### Recipe: run a batch in one script

The script launches the batch, prints the run ids, and waits with a time limit. For each run it checks three fields of the record:

- `outcome`: `done`, `partial`, `blocked`, `failed`, `timed_out`, or `cancelled`.
- `typed`: `false` when the run ended without a valid completion call. A valid call is `caller_ping`, or in an older session a `subagent_done` with an `outcome` and a `summary`. An untyped result has no data, and its report is the last text of the child, which can be empty. Its `artifacts` list the files the child wrote with `write` and `edit` in this run. A `caller_ping` result is typed and `blocked`. The record's `endedBy` tells a person's close (`operator`) from the child's own end (`child`).
- `dataError`: only in records of older sessions, whose child's `data` did not match the `schema` of its launch. The record then has no data.

The script returns about 1,500 tokens or less: one entry per run with the run id, the outcome, a cut summary, the report file path, and the data or the reason for no data. A data value longer than 300 characters is left out whole, and the entry names the `subagent_wait` call that returns it. The script measures the digest. If the digest is too long, it leaves out summaries and data, and then everything except the run id, the outcome, and the check. A `note` field then says so. On the time limit the script returns the pending run ids and says that their work must not be redone.

Both recipes launch an agent named `worker`. A new installation has no such agent. Write a `worker` agent, or put the name of one of your agents in `BATCH` and in the `spawning` list of the coordinator.

<!-- recipe: workflow-script -->
```js
// @options: {"timeout_ms": 1800000, "max_output_tokens": 2000}
// Inputs. Write fixed values here: a rerun repeats only what the script does not read from the clock or Math.random().
const BATCH = [
	{ agent: "worker", name: "auth-audit", title: "Audit the auth module", task: "Audit src/auth. Write your report to a file." },
	{ agent: "worker", name: "billing-audit", title: "Audit the billing module", task: "Audit src/billing. Write your report to a file." },
	{ agent: "worker", name: "search-audit", title: "Audit the search module", task: "Audit src/search. Write your report to a file." },
];
const WAIT_SECONDS = 1500;
// The digest stays near 1,500 tokens (6,000 characters). Codemode cuts output above max_output_tokens (8,000 characters).
const DIGEST_CHARS = 6000;
const SUMMARY_CHARS = 200;
// A longer data value is left out whole, never cut: the entry names the lookup that returns it.
const DATA_CHARS = 300;

const launch = await tools.subagent({ children: BATCH });
// The first output: if the script fails later, its partial output still names every run.
text(`Run ids: ${launch.children.map((child) => child.runId).join(", ")}`);

const lookUp = (id) => `subagent_wait({ ids: ["${id}"] })`;

function entry(id, record, fallback) {
	if (!record) return { id, outcome: "unknown", check: `no result record: ${fallback.slice(0, SUMMARY_CHARS)}` };
	const run = {
		id,
		name: record.name,
		outcome: record.outcome,
		summary: record.summary.length > SUMMARY_CHARS ? `${record.summary.slice(0, SUMMARY_CHARS)} [cut]` : record.summary,
		report: record.report.saved ? record.report.path : `not saved: ${record.report.error}`,
	};
	// An untyped done run is an ordinary success; a data error exists only in records of older sessions.
	if (record.dataError) run.check = `data error: ${record.dataError.slice(0, SUMMARY_CHARS)}`;
	else if (record.data !== undefined) {
		const size = JSON.stringify(record.data).length;
		if (size <= DATA_CHARS) run.data = record.data;
		else run.dataOmitted = `${size} characters; read it with ${lookUp(id)}`;
	}
	return run;
}

const runs = launch.children.filter((child) => child.state === "ended").map((child) => entry(child.runId, child.record, ""));
const started = launch.children.filter((child) => child.state === "started").map((child) => child.runId);
let pending = [];
let missing = [];
if (started.length > 0) {
	const wait = await tools.subagent_wait({ ids: started, timeout: WAIT_SECONDS });
	runs.push(...wait.results.map((result) => entry(result.runId, result.record, result.text)));
	pending = wait.pending;
	missing = wait.missing.map((item) => ({ id: item.runId, error: item.error.slice(0, SUMMARY_CHARS) }));
}

const digest = {
	ok: launch.status === "launched" && pending.length === 0 && missing.length === 0 && runs.every((run) => run.outcome === "done" && !run.check),
};
if (launch.status === "launch_failed")
	digest.launchFailed = {
		...launch.failed,
		error: launch.failed.error.slice(0, SUMMARY_CHARS),
		note: "The children before it started and keep running. Launch only this child and the ones after it.",
	};
if (pending.length > 0)
	digest.pending = { ids: pending, note: "These runs still work and report by message. Do not redo their work. Wait for them with subagent_wait({ ids })." };
if (missing.length > 0) digest.missing = missing;

// Measure the digest. If it is too long, leave out summaries and data, then everything but id, outcome and check.
const shorter = [
	(run) => run,
	({ summary, data, dataOmitted, ...run }) => run,
	({ id, outcome, check }) => (check ? { id, outcome, check: check.slice(0, 60) } : { id, outcome }),
];
for (const [level, shape] of shorter.entries()) {
	const serialized = JSON.stringify({
		...digest,
		runs: runs.map(shape),
		...(level > 0 ? { note: "Left out to fit the digest: read a whole result with subagent_wait({ ids: [id] })." } : {}),
	});
	if (serialized.length <= DIGEST_CHARS) return serialized;
}
return JSON.stringify({ ok: digest.ok, pending, runIds: runs.map((run) => run.id), note: "Too many runs for a digest: read each result with subagent_wait({ ids: [id] })." });
```

### Recover after a failed script

A failed script keeps its partial output, and the children that it launched keep running. Tool calls are real: a rerun of the script launches the whole batch again. Recover with this script instead. It launches nothing.

1. Copy the run ids from the `Run ids:` line of the partial output into `RUN_IDS`. If the output has no run ids, leave the list empty.
2. Run the script. With run ids, it returns each ended run and waits for the runs that still work. Without run ids, it waits for every run of this session that is still running or queued, and then lists the last 20 ended runs of this session, newest first. Read an older run by its run id with `subagent_wait({ ids: [id] })`.
3. Launch a child of the batch again only when you know it never started: its launch was refused, or the `launchFailed` entry of the failed script names it or a later child. A missing entry in the result does not prove that a child never started: the recent list holds only the last 20 ended runs, and a verified run is never in it. Otherwise look for its `record.json` under `results/` in the session's artifact folder, or stop and decide.

<!-- recipe: recover -->
```js
// @options: {"timeout_ms": 900000, "max_output_tokens": 2000}
// The run ids from the "Run ids:" line of the failed script. Leave the list empty if the output is lost.
const RUN_IDS = [];
const WAIT_SECONDS = 600;
const brief = (result) => ({
	id: result.runId,
	name: result.name,
	outcome: result.record?.outcome ?? "unknown",
	report: result.record?.report.saved ? result.record.report.path : undefined,
});
if (RUN_IDS.length > 0) {
	const wait = await tools.subagent_wait({ ids: RUN_IDS, timeout: WAIT_SECONDS });
	return { runs: wait.results.map(brief), pending: wait.pending, missing: wait.missing };
}
const running = await tools.subagent_wait({ timeout: WAIT_SECONDS });
const recent = await tools.subagent_wait({ recent: true });
return { runs: running.results.map(brief), pending: running.pending, recent: recent.recent };
```

A result can arrive twice: once in a wait reply and once by message, for example after an interrupted wait. A second delivery with the same run id is a copy, also when its text differs: an adopted verified winner can lack the launch warnings and the verifier detail of the first rendering. Only a verified retry delivers a different result under the same run id: a newer generation replaces the earlier one, and its report file path differs.

### Limits of a waiting script

- At most two codemode workers are alive in one Pi process by default, across all its sessions. `PI_CODEMODE_MAX_WORKERS` changes the limit. A waiting script holds one worker for the whole wait.
- A third script waits for a free worker in arrival order. If no worker is free within 60 seconds, the script fails without running: `No codemode worker became free within 60 seconds.` A script whose `timeout_ms` is 60,000 or less fails at its deadline instead: `Script timed out: Execution timed out after <timeout_ms> ms while waiting for a free codemode worker`.
- A cancelled worker keeps its slot until the worker exits.
- A waiting script must not depend on another script. Two scripts that wait for each other hold both workers.
- A script cannot be resumed from the middle. After a failure, recover as described above.
- A steer is not an interrupt. A message that you type while a script waits stays in the queue until the script ends. To stop the script, press `Esc`. `Esc` stops the script and its `subagent_wait`, not the children. The children keep running and report by message.
- Time and random values come from outside the script if a rerun should repeat them. Write them into the inputs.
- Each child runs in its own Pi process, so the scripts of a child do not take the workers of the parent.

### Recipe: a coordinator child

A child with `spawning` can coordinate a batch for the parent. The parent then launches one child and gets one result. Save this file as `.pi/agents/batch-coordinator.md`:

<!-- recipe: coordinator-child -->
```md
---
name: batch-coordinator
description: Run a batch of worker children, check each result, and return one digest.
mode: background
extensions: none
spawning: worker
spawn-width: 4
timeout: 3600
---

You coordinate one batch. You do not do the work of the batch yourself.

1. Launch every child that the task names in one subagent call. Give each child a name, a title, and a task.
2. Read the result of each child: outcome, summary, and report path.
3. End with one final message. Start it with one line per child: its name, outcome, and report path. Then give the digest in the shape that the task asks for.

Do not launch a child again after it fails. Name the failure in your final message.
```

A background child is a `pi -p` process, so its `subagent` call waits for every child and returns their reports in the tool result. `spawning: worker` lets the coordinator launch only the `worker` agent. `extensions: none` loads no other extension into the coordinator. Because the agent has `spawning`, Pi still loads pi-subagents into it, and the coordinator gets the `subagent` tool. That also holds when the parent loaded pi-subagents with `-e` instead of as an installed package. With `extensions: all`, the coordinator gets the `subagent` tool only from an installed pi-subagents package. With the default `spawn-depth: 1`, the workers cannot launch children. `spawn-width` limits how many children run at the same time, up to the hard ceiling of 16.

The parent launches the coordinator with the workflow script above. Put one entry in `BATCH`:

```js
const BATCH = [
	{
		agent: "batch-coordinator",
		name: "audit-coordinator",
		title: "Coordinate the module audits",
		task: "Launch three worker children to audit src/auth, src/billing, and src/search. Return the digest as { modules: [{ name, outcome, report }] }.",
	},
];
```

## Session modes

A child session has two questions:

- should Pi attach it to the parent session tree?
- should the child model see the parent transcript?

`lineage-only` attaches the child to the tree and starts the model clean. This is the default. You keep lineage, resume paths, and artifact attribution without copying the whole parent chat.

`standalone` starts clean and skips the parent link. Use it for unrelated work.

`fork` attaches the child to the tree and copies parent context. Use it when the child needs decisions, files, or prior results already in the parent transcript.

The `[fork]` flag of the agent index describes model memory. They do not describe where Pi stores the child in the session tree. A `lineage-only` child is still a child of the parent session even though its model starts clean.

For nested launches, `parent` means the session that spawned the child:

```text
top-level session
└── child session
    └── grandchild session
```

### Forked sessions

A fork copies the entire parent session into a new child run. The child inherits all user messages, assistant responses, tool calls, and tool results from the parent transcript.

When the parent model has a larger context window than the child model, the inherited history may exceed what the child can fit. Pi handles this automatically — the child's native compaction trims inherited messages at LLM call time using the child model's actual context window and tokenizer. No manual budget configuration is needed.

A fork also gets a handoff marker. Pi appends a short system-prompt note, then writes a hidden custom message with a `<subagent-boundary>` tag at the end of the copied transcript. The tag says: the old messages are background, and the next user message is the child task.

That marker prevents a common failure. A child can read the parent's old role, old tools, or old task and start acting like the parent. The marker tells it where the fork begins.

The marker also steers the model. If you want a raw fork with no marker and no boundary instruction, set:

```bash
PI_SUBAGENT_DISABLE_CHILD_CONTEXT_BOUNDARY=1
```

### `no-session: true`

`no-session: true` gives the child a private temporary session file instead of Pi's in-memory mode, under both `parent-close-policy` values. The watching parent reads the report from that file, publishes the result, then deletes the file. An orderly detach (the parent session closes while a `continue` child still runs) deletes the file too, and that child gets no result. A parent crash can leave the file. The result record says the run cannot be resumed.

For `fork`, Pi seeds that temporary file with the parent session content. For `lineage-only`, Pi also gives the child inherited context because there is no persistent child file where it can store lineage metadata.

Use `no-session: true` for disposable children. Do not use it when you need resume, `caller_ping`, or durable child history.


## Child lifecycle

A child can finish in three ways.

### `auto-exit`

Use `auto-exit: true` for autonomous agents. The child exits after a normal assistant completion.

Once the operator interrupts (Escape) or sends input to the child, auto-exit is permanently disabled for that session — the child warns the operator and stays open. Run `/auto-exit` inside the child to re-arm it: the next normal assistant completion closes the child again. Background children never receive operator input and are unaffected.

### `subagent_done`

`subagent_done` closes a headless child that runs without auto-exit. Ordinary background launches and headless resumes force auto-exit, also when the agent says `auto-exit: false`, so those children do not have it. It has no parameters. The last assistant message before the call is the result, so the child writes its final report first and then makes the call. The result is untyped.

An auto-exit child, in a pane or headless, has no `subagent_done`: it exits after its answer and any pending work, and its result is untyped and built from its last message. A pane child with `auto-exit` off never has it, also after a resume: only a person closes its pane, and its result is untyped. Its brief tells it to stay in the pane and not to exit. An agent that lists `subagent_done` in `deny-tools` never has it.

The report comes from this run only, by the v2.9.2 rules: the last assistant text; when the last assistant turn called a tool and had no text, the result of that trailing tool (never `subagent_done` or `caller_ping`); when the session has neither, a headless child's stdout after a clean exit, else the last assistant text before the call, else a failed child's stderr in a runtime summary. A zero-argument `subagent_done` does not hide the output before it. A final assistant turn with a terminal stop reason and no text (for example `length`) fails the run with that reason, also after exit code 0. It is never fork history or the text of an earlier run. Sessions from before this change can hold a typed `subagent_done` call with `outcome`, `summary`, `artifacts` and `data`; the parent still reads them and renders those results typed.

### `caller_ping`

Use `caller_ping` when the child needs the parent. The child sends a message up, exits, and leaves a session file that the parent can resume. Only background children and auto-exit pane children get the tool; a pane child with `auto-exit` off does not. After a person takes over an auto-exit pane, `caller_ping` records the question in the session, but the pane stays open and the parent gets nothing until the person closes the pane. The result is typed with outcome `blocked`. The full message is the report, and only the summary is cut to 1,500 characters. A ping that comes after the child already recorded its end fails and does not change the result.

## Resuming child sessions

`subagent_resume` starts an existing child session again. Name it by the run id of an earlier result (`runId`) or by its session file (`sessionFile`). You can pass a follow-up task. A run whose result record names a fact that no later run changes, such as a run without a session, is refused with the reason from that record. A time-limit or context-pressure reason in an older record does not decide alone: the resume checks the session's current state. After a later resume of that session ends with a published done, partial or blocked result, the old run id resumes the session. `subagent_kill` stops a running child by its run id or its name.

Only one resume of a session runs at a time in one Pi process: a second resume of the same session is refused, also when both start together. Two Pi processes that resume one session at the same moment are not covered.

Resume tries to preserve the original launch shape: mode, model, prompt style, cwd, tools, extensions, and lifecycle settings. A resumed child should continue as the same child, even if the agent file changed after the first launch.

One exception: attempt sessions of an `llm-as-a-verifier` launch are never resumable — their worktree copy is removed after the winner is picked. `subagent_resume` refuses with a dedicated error; launch the agent again instead.

## Child output

The child's output is its result: the summary of its completion call, or the start of its last text, plus the report file. See [The result of a run](#the-result-of-a-run).

For large output, let the child use Pi's `write` tool and name the path in `artifacts` or in its summary.

## Child tools and extensions

`extensions`, `tools`, and `deny-tools` shape the Pi capabilities available to the child model. They are not a sandbox for untrusted code. Loaded extensions still execute with the child process permissions, and freeform `flags` can override generated CLI arguments. Use OS or container isolation for hard security boundaries.

Children load all extensions by default. Omit `extensions` or set `extensions: all` for the default Pi extension set.

Set `extensions: none` to launch with no normal extensions. `pi-subagents` still injects its mandatory internal helper so child lifecycle and result delivery continue to work.

Set a comma-separated allowlist when you want a smaller child environment.

```md
---
name: reviewer
extensions: .pi/extensions/safe-tools.ts, npm:@foo/bar
---
```

When `extensions` is `none` or an allowlist, Pi launches the child with `--no-extensions`, injects the subagent protocol helper, then loads only the allowlisted extensions.

For an unversioned `npm:` source that is already configured and installed in the child's effective Pi settings, pi-subagents reuses Pi's managed package directory instead of creating a second temporary CLI installation. Exactly matching configured Git sources are reused too, including the same explicit ref when one is present. Resolution uses Pi's settings and package APIs, so it respects the child's Pi config root and configured `npmCommand` such as Bun. Unconfigured, filtered, explicitly versioned, and tagged npm sources retain Pi's normal temporary `-e` behavior, and Git sources that do not exactly match the configured source do the same. Project-installed packages are reused only when the child's final approval flags trust the project.

pi-subagents passes the allowlist to Pi as configured, on each launch and each resume, as v2.9.2 does. It does not drop a local path that does not exist or an `npm:` or `git:` package that is not installed; Pi gets each entry, and an uninstalled package goes through Pi's temporary `-e` installation. A resume passes its saved list as saved; it does not switch to the agent file's current list. A spawning child gets the pi-subagents extension added after its list unless the list already loads this package: the exact `npm:pi-subagents` name, this package's own entry, or a package directory whose manifest is named `pi-subagents`. A lookalike such as `npm:pi-subagents-extra`, or another file inside a `pi-subagents` checkout, does not count. An empty list (`extensions: none`) still starts the child with only the mandatory helper, plus the pi-subagents extension when the child may spawn.

Local paths stay paths. Package and remote sources keep their normal prefixes when managed reuse does not apply:

```md
---
name: reviewer
extensions: ./extensions/local.ts, npm:@foo/bar, git:github.com/user/repo
---
```

### Child skills

`skills` controls which skills the child Pi process can use.

```md
---
name: reviewer
skills: all
---
```

`skills: all` is the default. Pi keeps its normal skill discovery: project skills, global skills, settings, packages, and extension-provided skills.

```md
---
name: reviewer
skills: none
---
```

`skills: none` launches the child with `--no-skills`. The child has no discovered skills, and `inject-skills` is not allowed.

```md
---
name: reviewer
skills: pua,torpathy
---
```

A comma-separated list is an allowlist. `pi-subagents` resolves each name through Pi's resource loader, then launches the child with `--no-skills --skill <resolved-path> ...`. Only those named skills are available.

Entries in the list may carry a visibility annotation:

```md
---
name: worker
skills: context7=auto, torpathy=manual, tdd
---
```

- `=auto` advertises the skill in this child's `<available_skills>` prompt block even when its SKILL.md sets `disable-model-invocation: true`. The skill stays hidden everywhere else.
- `=manual` hides the skill from this child's prompt only, but it can still be invoked manually. It stays advertised in the main session and in other agents.
- Plain names keep Pi's own visibility. `all` and `none` cannot carry annotations.

The precedence is: agent annotation > global manual list (as materialized into skill frontmatter) > upstream frontmatter. Bad values (`=banana`) and conflicting annotations for one skill fail at launch with a clear error.

Visibility is applied at turn time: the runtime corrects the child's loaded skill list in place and swaps the rendered `<available_skills>` section. Extensions that rebuild a skills section from the structured skill list (tool adapters that replace Pi's native tools, for example) inherit the correction too. No SKILL.md file is ever written or modified. Annotations require the allowlist form; an agent with `skills: all` has nowhere to put one.

`skills` resolves names from the same places Pi sees skills, including:

- `.pi/skills/`
- `.agents/skills/`
- global skill directories
- settings and package resources
- skills bundled by extension packages listed in `extensions`

Package skill example:

```json
{
  "name": "my-pi-package",
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  }
}
```

An agent can allowlist a skill from that package by loading the package and naming the skill:

```md
---
name: reviewer
extensions: ./path/to/my-pi-package
skills: packaged-reviewer
---
```

`inject-skills` controls which available skills start inside the child task context.

```md
---
name: reviewer
skills: pua,torpathy
inject-skills: torpathy
---
```

`inject-skills` reads the selected `SKILL.md` files, strips frontmatter, and prepends `<skill>` blocks to the child task artifact. Multiple injected skills appear in order before the task. The child gets one startup task, so it cannot answer between injected skills and the task.

Injected skills must be available under `skills`. These fail before launch:

```md
skills: none
inject-skills: pua
```

```md
skills: pua
inject-skills: torpathy
```

By default, injected skills use Pi's native skill shape:

```xml
<skill name="pua">
References are relative to /path/to/pua.

...skill body...
</skill>
```

If [`pi-better-skills`](https://github.com/edxeth/pi-better-skills) is loaded for the child, injected skills use its path-context shape:

```xml
<skill name="pua">
<skill_context>
  <skill_dir>/path/to/pua</skill_dir>
  <workspace_dir>/path/to/workspace</workspace_dir>

  <path_policy>
    Relative file references in this SKILL.md normally resolve from skill_dir when they exist there.
    Plain workspace commands like git status and bun test usually run in the workspace unless instructed otherwise.
    Use $PI_SKILL_DIR/path for explicit bundled skill files.
    Use $PI_WORKSPACE/path for explicit workspace/project files.
  </path_policy>
</skill_context>

...skill body...
</skill>
```

Load `pi-better-skills` like any other child extension:

```md
---
name: researcher
extensions: git:github.com/edxeth/pi-better-skills
skills: deep-research
inject-skills: deep-research
---
```

The `tools` field narrows the child to a Pi tool allowlist. Use built-in names such as `read` and `bash`, extension/custom names such as `mcp`, and protocol names such as `caller_ping` when they should be part of the final allowlist. Pi-subagents keeps required child protocol tools available in narrowed allowlists. The optional `set_tab_title` protocol tool is added only when `PI_SUBAGENT_ENABLE_SET_TAB_TITLE=1`. When `tools` is omitted or set to `all`, Pi keeps its default active tool set. When `tools` is `none`, Pi disables built-in tools while preserving extension/custom tools unless you deny them.

Pi silently ignores `--tools` names that are not registered by a built-in or a loaded extension. That means a typo (for example `tools: read,edti`) leaves the child silently without `edit`. pi-subagents surfaces a non-blocking warning in the subagent result when a name is within one edit of a built-in (`edti`→`edit`, `raed`→`read`); the launch still proceeds, because a near-miss name can be a legitimate custom tool (for example `hash` is one edit from `bash`). pi-subagents cannot validate arbitrary extension/custom tool names before the child loads its extensions, so ensure every custom/extension name in `tools:` is registered by an extension listed in `extensions:`.

> **Pi-core skill advertisement needs `read` or `bash`.** Since Pi 0.85.0, pi core renders the `<available_skills>` block in the child's system prompt when the active tool set includes `read` or `bash` (older pi required `read`). It prefers `read`; with only `bash`, the block's instruction line reads "Use bash to load a skill's file..." instead of naming `read`. If you narrow `tools:` to swap Pi's native file tools for an extension's replacements and drop both, a child relying on Pi's own block loses every allowlisted (non-injected) skill from its prompt even though the files exist on disk. Keep the built-in `read` (or `bash`) in `tools:` for such a child. Visibility annotations (`=auto`/`=manual`) work in every case — the runtime corrects the structured skill list, swaps the rendered block with the child's own file-read tool wording, and extensions that render their own skills section from it inherit the correction. `inject-skills` is unaffected — injected skills are pasted into the task text directly.

`deny-tools` is a final named tool denylist. It can remove built-in Pi tools, extension/custom tools, or pi-subagents protocol tools after they have otherwise been selected.

```md
---
name: reviewer
tools: read,grep,mcp
extensions: npm:pi-mcp-adapter
deny-tools: bash,edit,write,ask_user
---
```

By default a child cannot launch subagents: `spawning` is `false`, which removes its `subagent`, `subagent_resume`, and `subagent_kill` tools. Set `spawning` only on agents that coordinate others. The four fields above define what such a child may do; this section adds the rules the table cannot show.

`tools:` narrows the child's work tools; it does not revoke a spawn grant. When `spawning` is enabled, `subagent`, `subagent_resume`, and `subagent_kill` stay available alongside a narrowed `tools:` list, exactly like `caller_ping` and `subagent_done`. Use `deny-tools` (or leave `spawning` off) to take them away.

`spawn-depth` is what stops two agents that launch each other from looping forever: the allowance drops by one at each level and never rises. `spawn-depth` and `spawn-width` bound a single burst of launches; they do not cap total token use over a long conversation. These fields are guardrails, not a security sandbox — a child that has `bash` or arbitrary extensions can still run `pi` itself.

Two environment variables set global ceilings when you start Pi: `PI_SUBAGENT_SPAWN_DEPTH` and `PI_SUBAGENT_SPAWN_WIDTH`. An agent file can tighten these for its own subtree but never raise them.

A child's launch allowances are saved in its launch metadata and narrowed again on resume — resuming never restores a larger allowance, and the first metadata entry is authoritative, so a child cannot grant itself more by writing to its own session file.
## Parent shutdown policy

Set `parent-close-policy` in the agent frontmatter:

```yaml
---
name: scout
parent-close-policy: continue
---
```

| Value | Effect |
| --- | --- |
| `terminate` | Stop the child when the parent session exits |
| `continue` | Leave the child running and stop delivering its result to the closed parent |

The default is `terminate`.

In a terminal of the Herdr app (herdr-core), Pi stops a `terminate` child when its session closes in order. If Pi dies abruptly, its children keep running until the program of the parent terminal ends.

## UI

The parent session gets a live widget above the editor. It shows running children, elapsed time, activity, and context usage.

Every `subagent` call requires both a strict `name` and a short `title`.

- `name` is the machine handle used in launch/result text and kill/wait targeting. Use lower-kebab `<scope>-<role>`, 2-4 words, max 32 characters: `auth-scout`, `diff-reviewer`, `session-tester`.
- `title` is the human label shown in the widget/session UI. Use sentence-case prose, 3-8 words: `Auth implementation map`, `Local diff bug review`.

Child sessions can also get session titles like:

```text
[scout] Auth flow reconnaissance
```

Disable child session titles with `PI_SUBAGENT_DISABLE_SESSION_TITLES=1`.

The Completed tab of the `/subagents` overlay shows one row per child session: the newest run of that session, so a resumed session shows only its last run. A run without a session file gets its own row. Published result records come first. Results that Pi holds in memory or in older session messages fill in the sessions that have no record.

## Launching children through a wrapper

By default, the extension launches children with the same Pi entrypoint it can infer from the parent. If your real Pi command goes through a wrapper, set it:

```bash
PI_SUBAGENT_PI_COMMAND="my-wrapper pi" my-wrapper pi
```

The wrapper applies to new children and resumed children. Quoted paths work:

```bash
PI_SUBAGENT_PI_COMMAND="'/path with spaces/my-wrapper' pi" pi
```

## Environment variables

User-facing knobs:

| Variable | Use |
| --- | --- |
| `PI_SUBAGENT_PI_COMMAND` | Launch children through a wrapper command |
| `PI_SUBAGENT_MUX` | Force `herdr-core`, `rex`, `herdr`, `cmux`, `tmux`, `zellij`, or `wezterm` |
| `PI_CODING_AGENT_DIR` | Use a different Pi agent config root |
| `PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN` | Set `1` to let the parent keep running after async launches |
| `PI_SUBAGENT_DISABLE_CHILD_CONTEXT_BOUNDARY` | Set `1` for raw forks with no boundary marker |
| `PI_SUBAGENT_DISABLE_SESSION_TITLES` | Disable automatic child session names |
| `PI_ARTIFACT_PROJECT_ROOT` | Override internal artifact storage root |
| `PI_SUBAGENT_SHELL_READY_DELAY_MS` | Change the fixed pane startup delay before Pi sends the child command (default: 500ms) |
| `PI_SUBAGENT_ENABLE_SET_TAB_TITLE` | Register the optional `set_tab_title` tool |
| `PI_SUBAGENT_RENAME_TMUX_WINDOW` | Let `set_tab_title` rename the tmux window |
| `PI_SUBAGENT_RENAME_TMUX_SESSION` | Let `set_tab_title` rename the tmux session |
| `PI_SUBAGENT_HERDR_PLACEMENT` | Herdr policy: `auto`, `right-stack`, `down-stack`, `right`, `down`, or `tab` |
| `PI_SUBAGENT_HERDR_MIN_COLUMNS` | Minimum columns preserved by Herdr `auto` placement (default: `50`) |
| `PI_SUBAGENT_HERDR_MIN_ROWS` | Minimum rows preserved by Herdr `auto` placement (default: `12`) |
| `PI_SUBAGENT_REX_PLACEMENT` | Rex policy: `window` (default, a new window per child) or `split` |
| `PI_SUBAGENT_ZELLIJ_PLACEMENT` | Zellij policy: `auto`, `right-stack`, `down-stack`, `floating`, or `tab-stack` |
| `PI_SUBAGENT_ZELLIJ_MIN_COLUMNS` | Minimum usable columns for each side of a Zellij split (default: `50`) |
| `PI_SUBAGENT_ZELLIJ_MIN_ROWS` | Minimum usable rows for each side of a Zellij split (default: `10`) |
| `PI_SUBAGENT_LLM_VERIFIER_CANDIDATES` | Default candidate count for `llm-as-a-verifier` agents that do not set `llm-as-a-verifier-candidates` |

Runtime internals you may see while debugging:

- `PI_DENY_TOOLS`
- `PI_SUBAGENT_EXTENSIONS`
- `PI_SUBAGENT_NAME`
- `PI_SUBAGENT_AGENT`
- `PI_SUBAGENT_PARENT_SESSION`
- `PI_SUBAGENT_SESSION`
- `PI_SUBAGENT_SURFACE`
- `PI_SUBAGENT_AUTO_EXIT`
- `PI_SUBAGENT_SKILL_VISIBILITY` (serialized `name=auto|manual` annotations for the child prompt rewrite)
- `PI_SUBAGENT_LLM_VERIFIER_VENV` (llm-as-a-verifier: pre-provisioned `llm-verifier` venv root)
- `PI_SUBAGENT_SUPERVISOR_RUNTIME` (llm-as-a-verifier: command that runs the detached supervisor `.ts` entry)

Live test knobs:

- `PI_SUBAGENT_ALLOW_LIVE_WINDOWS`
- `PI_SUBAGENT_LIVE_MODEL`
- `PI_SUBAGENT_KEEP_E2E_TMP`
- `PI_SUBAGENT_LIVE_LOCK_PATH`
- `PI_SUBAGENT_ALLOW_VERIFIED_E2E` (llm-as-a-verifier live e2e; also needs `DEEPSEEK_API_KEY`)
- `PI_SUBAGENT_PROVIDER_RECOVERY_DELAYS_MS` — override the provider-error recovery backoff windows (comma-separated ms, e.g. `10000,11000,12000`) so a live Pi process can exercise the wait → nudge → kill path without waiting the full 30/60/90s. Values below 10000ms are clamped so recovery does not race Pi's own default auto-retry backoff. Defaults to the production `30000,60000,90000`.

## Herdr placement

This section is about the Herdr TUI (`herdr`). The Herdr app (`herdr-core`) always opens a child as a split beside the parent and falls back to a tab; see [Interactive mux backends](#interactive-mux-backends).

Herdr uses `auto` placement by default. The first child shares the parent tab when both panes remain usable. Later children split the largest pane owned by that parent. Herdr chooses right or down from the pane geometry and opens a dedicated child tab when no safe split remains.

Set `PI_SUBAGENT_HERDR_PLACEMENT` to change the policy:

- `auto`: balance owned panes while preserving the configured minimum size, then use dedicated tabs for overflow.
- `right-stack`: open the first child to the right and split later siblings downward.
- `down-stack`: open the first child below and split later siblings to the right.
- `right` or `down`: split the parent in that direction for every launch. These explicit policies can create small panes.
- `tab`: always open a dedicated child tab.

`auto` preserves at least `PI_SUBAGENT_HERDR_MIN_COLUMNS` columns and `PI_SUBAGENT_HERDR_MIN_ROWS` rows in both halves of a proposed split. The defaults are `50` columns and `12` rows. The check happens before Herdr creates the pane, so a small window goes straight to a tab instead of producing an unreadable terminal.

Every pane-backed Herdr child receives its session title as the pane label. When a child uses the optional `set_tab_title` tool, Herdr updates that child pane without renaming the shared parent tab or workspace. Dedicated overflow tabs keep the original child session title.

Placement ownership stays inside the parent Pi process. Separate Pi parents cannot overwrite each other's placement state, even when they share one Herdr socket. A failed split or pane rename must leave at most one child surface before tab fallback begins.

The parent environment sets the default for all interactive subagents. An agent can override the placement policy for its own launches through the existing [`env`](#agent-definitions) frontmatter:

```yaml
env: PI_SUBAGENT_HERDR_PLACEMENT=tab
```

The parent reads this value before it creates the child surface. The agent value overrides the parent default. `PI_SUBAGENT_HERDR_MIN_COLUMNS` and `PI_SUBAGENT_HERDR_MIN_ROWS` remain parent-wide settings. On resume, a persisted per-agent `env` value wins; without one, the current parent default wins, then the originally persisted policy is the fallback.

## Rex placement

Set `PI_SUBAGENT_REX_PLACEMENT` to choose where a Rex child opens:

- `window` (default): each child opens in its own new window (the app's tab) of the parent's Rex session.
- `split`: a child opens as a split to the right of the parent block, at most 2 per window; later children open in a new window.

Every create uses `--focus=false`. An unknown value stops the launch with an error before Rex creates anything. An agent can set the variable for its own launches through [`env`](#agent-definitions) frontmatter, for example `env: PI_SUBAGENT_REX_PLACEMENT=split`. On resume, the precedence is the Herdr one: a persisted per-agent `env` value, then the current parent default, then the persisted policy.

## Zellij placement

Zellij groups children by their immediate parent session. The first child splits that parent; later siblings stack on the same pane. Set `PI_SUBAGENT_ZELLIJ_PLACEMENT`:

- `auto` (default): split the parent pane when there is room, otherwise open a dedicated tab. Later siblings stack on the first pane owned by that parent.
- `right-stack`: first child goes right, siblings stack there.
- `down-stack`: first child goes below, siblings stack there.
- `floating`: each child opens as a pinned floating pane.
- `tab-stack`: first child opens a dedicated tab, siblings stack in that tab.

`right-stack`, `down-stack`, and `auto` fall back to a dedicated tab when a split would fall below `PI_SUBAGENT_ZELLIJ_MIN_COLUMNS` or `PI_SUBAGENT_ZELLIJ_MIN_ROWS`.

The parent environment sets the default for all interactive subagents. An agent can override it for its own launches through the existing [`env`](#agent-definitions) frontmatter:

```yaml
env: PI_SUBAGENT_ZELLIJ_PLACEMENT=down-stack
```

This is a parent-read exception to the usual child-environment contract because placement must be resolved before the child pane exists. The agent value overrides the parent default. Placement groups are scoped by immediate parent and resolved policy, so agents with different policies do not overwrite each other's stack anchors. On resume, a persisted per-agent `env` value still wins; without one, the current parent default wins, then the originally persisted policy is the fallback.

Zellij 0.44.x needs a short focus transaction for directional and stacked placement, and stacked insertion changes client focus. Those policies require exactly one attached Zellij client. With more clients, use `floating` or detach the extras.

## Testing

Unit tests:

```bash
bunx tsc --noEmit
npm test
```

Herdr-focused fake tests:

```bash
node --test test/mux/herdr.test.ts
node --test test/mux/herdr-placement.test.ts
node --test test/launch/herdr-interactive-launch.test.ts
```

The mux tests cover Herdr detection, adapter errors, geometry-aware placement, small-window tab fallback, owned-pane isolation, pane titles, explicit policies, split limitations, I/O, and cleanup. The launch test covers Herdr parity for cwd, env, flags, trust-project approval, session settings, model and thinking resolution, tool narrowing, skills, lifecycle policy, and explicit `PI_SUBAGENT_MUX=herdr` selection.

Live tests:

```bash
PI_SUBAGENT_ALLOW_VERIFIED_E2E=1 DEEPSEEK_API_KEY=... npm run test:e2e-live-verified-fanout
PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1 npm run test:e2e-live-blocking
PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1 npm run test:e2e-live-mix-blocking
npm run test:e2e-live-deny-tools
npm run test:e2e-live-tools
npm run test:e2e-live-extensions
npm run test:e2e-live-stop-after-turn
```

The live window tests require an explicit opt-in because they open real terminal windows.

Herdr live smoke tests are guarded and bounded:

```bash
npm run test:live-herdr-mux
npm run test:live-herdr-pi
npm run test:live-herdr-timeout-wrap-up
```

Without opt-in variables, each Herdr smoke prints a `SKIP` line and exits before creating Herdr surfaces. Use the skip output as guard evidence only. It is not a real live smoke run.

Run the real Herdr mux smoke only when you are ready to create temporary Herdr surfaces:

```bash
PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1 npm run test:live-herdr-mux
```

Run the real Pi Herdr smoke with both live opt-ins and a model. This script starts an interactive parent Pi session inside a Herdr-managed pane. It does not use `pi -p` as proof of interactive child behavior.

```bash
PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1 \
PI_SUBAGENT_LIVE_MODEL=provider/model[:thinking] \
npm run test:live-herdr-pi
```

Run the enforced timeout wrap-up smoke with the same opt-ins. It blocks an interactive child inside a synchronous custom tool, verifies that Herdr closes that pane at the threshold, observes a replacement report-only pane on the same session, and requires the replacement to finish before the original hard deadline.

```bash
PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1 \
PI_SUBAGENT_LIVE_MODEL=provider/model[:thinking] \
npm run test:live-herdr-timeout-wrap-up
```

All Herdr smoke scripts check the `herdr` command, server running status, and protocol compatibility before mutating panes. They label created tabs and panes with a unique marker, then close marked surfaces during cleanup.

Herdr validation record for this release:

- `node --test test/mux/herdr.test.ts` passes the fake Herdr mux contract suite.
- `node --test test/launch/herdr-interactive-launch.test.ts` passes the fake Herdr launch parity suite.
- `bunx tsc --noEmit` passes type checking.
- `npm test` runs the registered Herdr mux and launch suites through the repository test entrypoint.
- `npm run test:live-herdr-mux` and `npm run test:live-herdr-pi` pass their skip guards when `PI_SUBAGENT_ALLOW_LIVE_WINDOWS` and `PI_SUBAGENT_LIVE_MODEL` are unset. A real live run requires the opt-in variables above.

## Credits

- upstream foundation: [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)
- this fork: [edxeth/pi-subagents](https://github.com/edxeth/pi-subagents)

## License

MIT
