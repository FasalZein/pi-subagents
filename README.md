# pi-subagents

`pi-subagents` is a highly curated multi-agent framework for [Pi agent harness](https://github.com/earendil-works/pi).

It began as a fork of [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), then grew into a monumental refactor: named agents, interactive panes, background workers, async parallelism, blocking agents, child-to-parent communication, forked context, a beautiful TUI widget, and much more!

Use it when one agent should hand work to another agent instead of trying to do everything in one transcript. Interactive children open in Herdr, cmux, tmux, zellij, or WezTerm; background children run headlessly.

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

```bash
pi install git:github.com/edxeth/pi-subagents
```

## The model

A subagent is a named agent file plus a launch policy.

The agent file says who the child is and how it should run. The parent still owns the decision to launch it. The child owns the task it receives.

Two axes matter:

- `interactive` or `background`: where the child runs
- async or sync: whether the parent waits

`interactive` means foreground. Pi opens a visible surface through Herdr, cmux, tmux, zellij, or WezTerm. Normal launches use a backend-specific surface, such as a tab, window, split, or stacked pane.

`background` means headless. Pi starts a `pi -p` child process without opening a pane.

Async means the parent gets a “started” result and the child answer comes back later. Sync means the parent waits for the child answer before it continues.

### Interactive mux backends

Interactive children open in your current terminal backend. `pi-subagents` supports Herdr, cmux, tmux, zellij, and WezTerm.

Start `pi` inside the backend you want to use. Leave `PI_SUBAGENT_MUX` unset to let Pi detect it, or set it to `herdr`, `cmux`, `tmux`, `zellij`, or `wezterm` to force one.

The backend command must exist, and Pi must be able to see the current pane or session context. If no supported backend is active, interactive launches fail with a setup hint.

Normal launches use a backend-specific surface. Herdr keeps children beside the parent while the tab has room, then uses dedicated tabs for overflow. Every Herdr child pane is labeled with its session title, such as `[reviewer] Auth implementation review`. Other backends may use windows, splits, or stacked panes.

### Orchestrator mode is removed

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

The `description` matters. Pi uses it for ambient awareness, explained next.

For a fuller example of the intended style, see the [scout agent gist by edxeth](https://gist.github.com/edxeth/11b6a6cdf7c6068771a5e3f96ab5e34b). It shows the shape this package works best with: a sharp role, an explicit contract, and little room for interpretation.

### Frontmatter reference

| Field | Default | What it controls |
| --- | --- | --- |
| `name` | filename | Stable agent name used by `agent: "..."` |
| `description` | unset | One-line routing hint for ambient awareness |
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
| `no-session` | `false` | Use an ephemeral child session file and delete it after completion |
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
| `parent-close-policy` | `terminate` | What happens to the child when the parent session exits: `terminate` (kill) or `continue` (leave running) |

Use YAML block syntax for more than one env var:

```yaml
env: |
  PI_CODING_AGENT_DIR=~/.pi-scout/agent
  PI_SAFETYNET_DEFAULT_MODE=explore
  SOME_VALUE=value,with,commas
```

Pi splits `env` by line. It does not split values by comma. When you set `PI_CODING_AGENT_DIR`, the child uses that directory for its Pi config and sessions. For per-agent Herdr or Zellij placement, set `PI_SUBAGENT_HERDR_PLACEMENT` or `PI_SUBAGENT_ZELLIJ_PLACEMENT` here. The parent reads placement before the child pane exists. See [Herdr placement](#herdr-placement) and [Zellij placement](#zellij-placement).

Children inherit every environment variable from the parent Pi process, in every launch mode. This includes API keys and tokens that you exported before you started Pi. `deny-env` in an agent file removes names from this inheritance. You can also set `PI_SUBAGENT_ENV_DENY` in the parent environment. Both lists apply.

A resume applies the `deny-env` that the session saved before its first launch, in every session mode. A session that saved none, for example a `standalone` session from an older version, takes the current `deny-env` of the agent that `subagent_resume` names. Without an agent name, or when the agent has no definition, the resume stops with an error.

A pane child also gets the identity variables of its own pane, which replace the parent's. In Herdr, the child gets only `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH` and `HERDR_CONFIG_PATH` from the pane, and no parent value of these names. When the pane does not set `HERDR_ENV` or `HERDR_PANE_ID`, or `env` names one of them, the launch stops with an error before Pi starts. Other names in `env` still reach the child, denied names included.

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

A child that wraps up on the **last** warning did what it was told, so the parent must not read the short result as a premature exit. Pi marks that case in the result it sends to the parent:

```text
Sub-agent context: 182K/200K tokens (91%) used at finish. It stopped early as
instructed by its context-warning policy: check what is unfinished and launch a
fresh sub-agent for it if needed. A short or partial report here is expected and
not a failure. Do not resume this session; resuming re-does already-summarized
work and wastes a turn.
```

Only the last warning counts. A child that sees an earlier warning and then finishes its work normally is reported as an ordinary completion, and stays resumable. A child that fails with a provider error is reported as a failure, never as an instructed wrap-up.

A child that fails after the last warning is a failure, not a wrap-up, so the parent keeps the cheap retry. Its result says the context window is spent and that a fresh sub-agent is usually better, and `subagent_resume` still works on it. Only a warning-driven wrap-up is blocked.

Warnings only ever come in three stages, and the last stage is the one that says to stop. A setting that cannot reach three stages, such as `context-warn-threshold: 99%`, still warns the child but never blocks it, because the child was never told to stop.

Warned results also omit the `Resume: pi --session …` line, so the parent is not handed a command that would bypass the block below. The session path is still shown.

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
Sub-agent "scout" completed its time-limit wrap-up (12m 3s). The parent
interrupted its active operation at 80% of its whole-run limit so the remaining
time was reserved for this report. A short or partial report is expected; check
what remains unfinished.

Mapped the auth flow. The session layer still needs verification.
```

The wrap-up is a normal completion, not a hard timeout. Its session stays resumable unless another policy blocks it.

The trade-off is deliberate: a legitimate slow tool is cancelled at the threshold. If losing that tool run is worse than losing the final report, leave `timeout-warn-threshold` off and use only the hard limits.

#### What the parent receives

A stopped child cannot report its own result, so the parent reports it:

```text
Sub-agent "scout" ran out of time, so the system stopped it after 15m. Its
agent file sets a limit of 15m for the whole run.

Partial work from before it stopped. It is incomplete, so check it before you
trust it:

Mapped the auth flow. The session layer is untouched.

A sub-agent that used its whole limit once usually does it again. A resume gets
the same limit, so it can stop at the same point. It is usually better to
finish the work yourself, or to start a new sub-agent with a smaller task.

Session: /path/to/child.jsonl
To continue this work, use the subagent_resume tool. It applies the same limit
again. Do not open this file with a plain pi --session command, because that
run has no limit.
```

#### Resume after a stop

A resume is allowed by default. A time limit means that the child ran out of clock. It does not mean that the session is broken.

A resumed run gets the same limits as the first run. A child that loops stops again at the same point instead of running forever. This is why a resume is safe to allow.

Use the `subagent_resume` tool to continue the work. A plain `pi --session` run is not a tracked child, so that run has no limit.

Set `on-timeout: block-resume` when a second partial run is not safe. An example is an agent that writes to something outside the repository. Then `subagent_resume` refuses the session, and the result hides the session line from the model. You can still resume the session yourself from the `/subagents` overlay; that override applies only to that one resume.

The block-resume verdict stays until the resumed run ends. The published outcome of that run decides, not its exit status: a done, partial or blocked result removes the verdict, and a new timeout replaces it. A cancelled resumed run leaves the verdict in force, so a non-idempotent agent stays blocked. A resume that fails before the child starts, a failed run, and a parent that exits during the run also leave the verdict in force, so a later `subagent_resume` is still refused.

`parent-close-policy: continue` remains intentionally detached. If the parent exits, it no longer owns either timeout clock, so strict enforcement is no longer guaranteed for that surviving child.


### Report final context use to the parent

`report-context-usage` controls one line in the child result. The default value is `true`.

With the default value, the parent receives a result such as this:

```text
Sub-agent "scout" completed (3s).

Reviewed the authentication flow and found the files that require changes.

Session: /path/to/child.jsonl
Resume: pi --session /path/to/child.jsonl

Sub-agent context: 145K/200K tokens (72%) used at finish.
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
Sub-agent "scout" completed (3s).

Reviewed the authentication flow and found the files that require changes.

Session: /path/to/child.jsonl
Resume: pi --session /path/to/child.jsonl
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

`model` is the default and is always allowed. `allowed-models` lists the other models Pi may use for this agent, so you do not need to repeat `model`. The `:thinking` suffix is optional: `provider/model:low` allows only that thinking level, while `provider/model` allows the model with whatever thinking level Pi resolves. If `allow-model-override: false`, Pi ignores launch-time and resume-time model choices as usual.

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
3. You get one result: the report of the winning attempt, plus a short footer. If the winner changed code, the change is staged in your working tree. It is not committed. Inspect it with `git diff --staged`. If your tree changed during the run, nothing is applied, and the winner stays on a Git branch that the footer names.

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

## Ambient awareness

Ambient awareness is the quiet note Pi gives the parent model about available agents.

Pi stores that note as a hidden custom message. The user does not see it as chat. The LLM sees it as context before it decides whether to call `subagent`.

The note contains agents with `description` fields and labels each one by what the child would see:

- `isolated context` means the child starts clean. The parent must write a self-contained task.
- `forked context` means the child sees the parent transcript. The parent can rely on context already in the chat.

Pi sends ambient awareness once when a top-level session first needs it, then sends a fresh copy after reload if the agent list changed.

Normal child sessions do not receive ambient awareness, even with `spawning: true`. They sit under a parent that made the first routing decision. A `standalone` child can receive its own ambient awareness because Pi treats it as a root session.

Agents without descriptions remain launchable, but they do not appear in ambient awareness.

## Launching and waiting

Async launch:

1. parent calls `subagent`
2. child starts
3. parent receives a “started” result
4. child result comes back later by steer

Sync launch:

1. the agent has `async: false` in frontmatter
2. parent waits
3. tool result contains the child result

#### Mixed sync and async batches

When one tool-call batch contains at least one sync/blocking subagent, the whole batch becomes a barrier. Pi still launches every child with its own frontmatter, so an `async: true` child keeps async launch metadata for resume, but the parent waits until every child in that batch completes and receives all results as tool results.

```
subagent(sync), subagent(async), subagent(async) → all launch
→ parent waits until all three finish
→ returns all three completed results
```

Pure async batches stay detached: the parent receives started results and child results arrive later by steer.

After a pure async launch, the parent should get out of the way unless it has separate work. If the parent keeps solving the delegated task, you paid for two agents to race each other.

By default, a successful async launch ends the parent turn after the current tool batch. The children keep running. Their results come back later.

A parent without a durable turn cannot receive a later steer, so it waits for every launch instead: `pi -p`, `--mode json`, `--mode rpc`, and any session without a UI. Every `mode: background` child is a `pi -p` process, so a background child that has `spawning` always receives its children's reports as tool results and the turn continues. The stop above applies only to parents that can receive the later report. A `subagent_resume` from such a parent waits the same way.

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

In a script, `tools.subagent` and `tools.subagent_wait` resolve to objects, not text. `tools.subagent` gives `{ status: "launched" | "launch_failed", children, failed? }`. Each child has a `runId` and a `state` of `started` or `ended`. An `ended` child also has its result `record`. `tools.subagent_wait` gives `{ status, results, pending, missing }`, and each entry of `results` has the run's `record`. A launch that the spawn width or the launch cap refuses gives the refusal text as a string and starts nothing.

### Recipe: run a batch in one script

The script launches the batch, prints the run ids, and waits with a time limit. For each run it checks three fields of the record:

- `outcome`: `done`, `partial`, `blocked`, `failed`, `timed_out`, or `cancelled`.
- `typed`: `false` when the child ended without `subagent_done`. The result then has no data, and the report is the child's last text.
- `dataError`: set when the child's `data` did not match the `schema` of its launch. The record then has no data.

The script returns about 1,500 tokens or less: one entry per run with the run id, the outcome, a cut summary, the report file path, and the data or the reason for no data. On the time limit it returns the pending run ids and says that their work must not be redone.

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
// Keeps the digest near 1,500 tokens for any batch size.
const FIELD_CHARS = Math.min(300, Math.floor(2000 / BATCH.length));

const launch = await tools.subagent({ children: BATCH });
if (typeof launch === "string") return `Launch refused, nothing started: ${launch}`;
// The first output: if the script fails later, its partial output still names every run.
text(`Run ids: ${launch.children.map((child) => child.runId).join(", ")}`);

function digest(id, record, fallback) {
	if (!record) return { id, outcome: "unknown", summary: fallback.slice(0, FIELD_CHARS) };
	const entry = {
		id,
		name: record.name,
		outcome: record.outcome,
		summary: record.summary.slice(0, FIELD_CHARS),
		report: record.report.saved ? record.report.path : `not saved: ${record.report.error}`,
	};
	if (!record.typed) entry.check = "untyped: the child ended without subagent_done; read its report";
	else if (record.dataError) entry.check = `data error: ${record.dataError.slice(0, FIELD_CHARS)}`;
	else if (record.data !== undefined) entry.data = JSON.stringify(record.data).slice(0, FIELD_CHARS);
	return entry;
}

const runs = launch.children.filter((child) => child.state === "ended").map((child) => digest(child.runId, child.record, ""));
const started = launch.children.filter((child) => child.state === "started").map((child) => child.runId);
let pending = [];
let missing = [];
if (started.length > 0) {
	const wait = await tools.subagent_wait({ ids: started, timeout: WAIT_SECONDS });
	runs.push(...wait.results.map((result) => digest(result.id, result.record, result.text)));
	pending = wait.pending;
	missing = wait.missing;
}

const result = {
	ok: launch.status === "launched" && pending.length === 0 && missing.length === 0 && runs.every((run) => run.outcome === "done" && !run.check),
	runs,
};
if (launch.status === "launch_failed")
	result.launchFailed = { ...launch.failed, note: "The children before it started and keep running. Launch only this child and the ones after it." };
if (pending.length > 0)
	result.pending = { ids: pending, note: "These runs still work and report by message. Do not redo their work. Wait for them with subagent_wait({ ids })." };
if (missing.length > 0) result.missing = missing;
return result;
```

To type the data of a child, add a `schema` (JSON Schema) to its entry in `BATCH`. When the data of a child does not match, its record has a `dataError` instead of data.

### Recover after a failed script

A failed script keeps its partial output, and the children that it launched keep running. Tool calls are real: a rerun of the script launches the whole batch again. Recover with `subagent_wait` instead:

1. Read the run ids from the `Run ids:` line of the partial output.
2. Call `subagent_wait({ ids })` with those ids. A run that ended returns its result from the result records of the session. The call waits for a run that still works.
3. If the output has no run ids, call `subagent_wait({ recent: true })`. It lists the last 20 ended runs of this session, newest first, with run id, name, and outcome. Look up an older run by its run id.
4. To wait for every run that is still running or queued, call `subagent_wait({})`.
5. Launch only the children that have no run id.

A result can arrive twice: once in a wait reply and once by message, for example after an interrupted wait. Treat a second copy with the same run id as the same result.

### Limits of a waiting script

- At most two codemode workers are alive in one Pi process by default, across all its sessions. `PI_CODEMODE_MAX_WORKERS` changes the limit. A waiting script holds one worker for the whole wait.
- A third script waits for a free worker in arrival order. If no worker is free within 60 seconds, or before its own shorter `timeout_ms`, the script fails without running: `No codemode worker became free within 60 seconds.`
- A cancelled worker keeps its slot until the worker exits.
- A waiting script must not depend on another script. Two scripts that wait for each other hold both workers.
- A script cannot be resumed from the middle. After a failure, recover as described above.
- A steer is not an interrupt. A message that you type while a script waits stays in the queue until the script ends. To stop the script, press `Esc`. `Esc` stops only the script and its wait. The children keep running and report by message.
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
spawning: worker
spawn-width: 4
timeout: 3600
---

You coordinate one batch. You do not do the work of the batch yourself.

1. Launch every child that the task names in one subagent call. Give each child a name, a title, and a task.
2. Read the result of each child: outcome, summary, report path, and data.
3. Call subagent_done once. Set outcome to done only when every child is done. Put one line per child in the summary: its name, outcome, and report path. Put the digest in data, in the shape that the task asks for.

Do not launch a child again after it fails. Name the failure in your summary.
```

A background child is a `pi -p` process, so its `subagent` call waits for every child and returns their reports in the tool result. `spawning: worker` lets the coordinator launch only the `worker` agent. With the default `spawn-depth: 1`, the workers cannot launch children. `spawn-width` limits how many children run at the same time, up to the hard ceiling of 16.

The parent launches the coordinator with the workflow script above. Put one entry in `BATCH`, and add a `schema` for the digest:

```js
const BATCH = [
	{
		agent: "batch-coordinator",
		name: "audit-coordinator",
		title: "Coordinate the module audits",
		task: "Launch three worker children to audit src/auth, src/billing, and src/search. Return data as { modules: [{ name, outcome, report }] }.",
		schema: {
			type: "object",
			required: ["modules"],
			properties: { modules: { type: "array", items: { type: "object", required: ["name", "outcome", "report"] } } },
		},
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

The `isolated context` and `forked context` labels from ambient awareness describe model memory. They do not describe where Pi stores the child in the session tree. A `lineage-only` child is still a child of the parent session even though its model starts clean.

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

Manual-lifecycle children get a `subagent_done` tool. The child writes its final assistant message, calls `subagent_done`, and Pi returns that final message to the parent.

Every child that can end by itself has `subagent_done` unless its agent lists `subagent_done` in `deny-tools`. If you want an interactive child that only the operator can close, add `subagent_done` to `deny-tools`.

An auto-exit child that is about to exit without calling `subagent_done` or `caller_ping` gets one nudge per run (launch or resume) to make the call. If it still makes no call, it exits and the parent builds an untyped result; the report keeps the text the child wrote before the nudge. After a person takes over the pane, the report is the last text instead. A child in time-limit wrap-up, or one with `subagent_done` denied, gets no nudge.

### `caller_ping`

Use `caller_ping` when the child needs the parent. The child sends a message up, exits, and leaves a session file that the parent can resume.

## Resuming child sessions

`subagent_resume` starts an existing child session again. Name it by the run id of an earlier result (`runId`) or by its session file (`sessionFile`). You can pass a follow-up task. A run whose result record says it is not resumable, such as a run without a session, is refused with the reason from that record. `subagent_kill` stops a running child by its run id or its name.

Only one resume of a session runs at a time in one Pi process: a second resume of the same session is refused, also when both start together. Two Pi processes that resume one session at the same moment are not covered.

Resume tries to preserve the original launch shape: mode, model, prompt style, cwd, tools, extensions, and lifecycle settings. A resumed child should continue as the same child, even if the agent file changed after the first launch.

One exception: attempt sessions of an `llm-as-a-verifier` launch are never resumable — their worktree copy is removed after the winner is picked. `subagent_resume` refuses with a dedicated error; launch the agent again instead.

## Child output

The child's final assistant message is its output.

For large output, let the child use Pi's `write` tool and mention the path in its final message.

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

For an unversioned `npm:` source that is already configured and installed in the child's effective Pi settings, pi-subagents reuses Pi's managed package directory instead of creating a second temporary CLI installation. Exactly matching configured Git sources are reused too, including the same explicit ref when one is present. Resolution uses Pi's settings and package APIs, so it respects the child's Pi config root and configured `npmCommand` such as Bun. Unconfigured, filtered, explicitly versioned, and tagged npm sources retain Pi's normal temporary `-e` behavior, and Git sources that do not exactly match the configured source do the same, but only while Pi has the package installed in user or project scope; otherwise pi-subagents drops the entry (next paragraph). Project-installed packages are reused only when the child's final approval flags trust the project.

Before each launch and each resume, pi-subagents drops every allowlist entry that does not resolve, and the child starts with the rest. An entry does not resolve when it is a local path that does not exist, or an `npm:` or `git:` package that Pi has not installed in user or project scope. This check runs no command: it looks for npm packages only in Pi's managed npm directories (`<agent dir>/npm` and `<project>/.pi/npm`), so a configured `npmCommand` never runs, and a package installed only by Pi's legacy global npm route counts as not installed. The launch or resume reply names each dropped entry once, outside the result text: `dropped missing extension: <entry>`. A resume keeps its saved list without the dropped entries; it does not switch to the agent file's current list. This changes v2.9.2: an uninstalled npm or git entry no longer reaches Pi as a temporary `-e` package, so pi-subagents drops it and names it. A package that exists only as a temporary `-e` checkout counts as not installed. The `pi-subagents` entry is never dropped: the exact `npm:pi-subagents` name, this package's own entry, or a package directory whose manifest is named `pi-subagents`. A lookalike such as `npm:pi-subagents-extra`, or another file inside a `pi-subagents` checkout, is checked like any other entry. An empty list (`extensions: none`) still starts the child with only the mandatory helper.

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
| `PI_SUBAGENT_MUX` | Force `herdr`, `cmux`, `tmux`, `zellij`, or `wezterm` |
| `PI_SUBAGENT_LAUNCH_CAP` | Change the number of runs a parent may start between two session starts (default: 64). Each child counts once, a verified fan-out counts each candidate, a resume counts, a time-limit wrap-up does not. A reload keeps the count; a new, resumed or forked session starts at 0 |
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
