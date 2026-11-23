# AGENTS.md

Read `README.md` first: it documents the model, frontmatter, placement policies, and env vars.

## Package facts

- `bun.lock` is the only tracked lockfile; `package-lock.json` is gitignored.
- Do not use `git stash` in a linked worktree: the stash list is shared with the main checkout, so a pop can apply another session's entry.
- A new linked worktree can start without `node_modules`; `bunx tsc --noEmit` then fails with TS2688 and tests with `ERR_MODULE_NOT_FOUND`. Run `bun install --frozen-lockfile` there first.
- The owner's Pi loads the main checkout of this repo as its pi-subagents package (switch of 2026-11-19; undo: `~/.pi/artifacts/pi-subagents/switch/fork-switch.sh restore`). A merge into `feat/context-rework` changes what every new Pi session on this Mac loads.
- When editing README.md: `test/tools/workflow-recipe.test.ts` parses it (the only suite that does), so run that test.
- `.gitignore` ignores `docs/`, but `docs/specs/context-rework.md` is tracked: commit it by path; `git add -A` with `docs` aborts.
- When working under `scripts/orchestration-benchmark/`: the baseline commit cf6dbf4 has no copy of it; `--keep-sessions` keeps sessions and run folders but no load-probe files; the launcher refuses an OAuth login that expires within 30 minutes, and one `pi -p` request with that provider refreshes it.
- When a test spawns `node --test`, pass it a clean `env`: an inherited test-runner context can make the child exit 0 on failing tests (see `visibleTestPasses` in `scripts/orchestration-benchmark/scenarios/review-fix/oracle.mjs`).

## Project structure contract

Organize by ownership. Do not recreate a catch-all `src/subagents/` or generic `test/parts/` directory.

- `src/subagents.ts` is extension wiring only: event hooks, tool registration, and thin glue.
- `src/agents/` owns agent definitions, catalog messaging, and titles; `src/launch/` child launch preparation and policy; `src/runtime/` running state, wait/join, shutdown, watchers, result routing, and widgets; `src/session/` JSONL session helpers and fork-session logic; `src/tools/` Pi tool/command implementations and tool policy.
- `src/mux/` owns multiplexer internals; `src/mux.ts` is the public barrel.
- `src/artifact-storage.ts` owns artifact storage roots/paths. `src/launch/prompt-artifacts.ts` owns writing launch prompt/task artifact files. Do not blur these names.
- `src/types.ts` is shared runtime type surface only; do not turn it into a junk drawer.
- Tests live in `test/` (not `tests/`) and mirror source ownership. Each domain suite must be imported by `test/test.ts`, or `npm test` will not run it.
- `test/support/` is split by ownership; do not recreate a fat `test/support.ts`.
- A test that drives real tmux sets `PI_SUBAGENT_MUX=tmux`: backend detection prefers herdr and cmux, so inside herdr an unpinned test drives herdr.
- `test/support/env.ts` restores PATH and the mux variables after each test: set fake-mux variables in `beforeEach`, not `before`.
- Pi spreads the UI context into a new object: a test UI `Proxy` must hold each method the extension calls (such as `notify`) as an own key.
- Temp-path assertions compare `realpathSync` paths: on macOS `tmpdir()` is `/var/...` while git and `pwd` report `/private/var/...`.
- When a test records provider requests: assert on `message.content` only. Pi's faux provider receives tool-result `details`; real providers do not.
- Do not use `// @ts-nocheck`. If a test probes a dynamic result shape, use a local cast at that assertion.
- A fixture cast `as RunningSubagent` or `as any` hides a type-shape change from `bunx tsc --noEmit`: after changing a shared type, run every suite that builds it, not only the typecheck.

## Naming and size rules

- Name files after the behavior or domain they own, not their history. Bad shapes: `shared.ts`, `helpers2.ts`, `parts/`, `new-runtime.ts`, `part-*`, `chunk-*`, and generic `shared/`, `utils/`, `helpers/` or `common/` directories without several clear consumers.
- Barrels are allowed only as public/domain entrypoints. Do not hide unused re-export files behind them.
- `node scripts/check-file-sizes.mjs` enforces `src/**` <= 600 LOC and `test/**` <= 1000 LOC. When a source file nears its limit, split by ownership before adding logic. Keep test files cohesive (target ~600 LOC); do not split them into artificial buckets.

## Validation gates

- Ordinary code changes: `bunx tsc --noEmit` and `npm test` (`bun test` also works).
- Structure/cleanup changes, also: `bunx @biomejs/biome check .`, `bunx knip`, and before handoff `node scripts/check-file-sizes.mjs`.
- `bunx biome` resolves an unrelated npm package named `biome` and exits 0 without checking anything; always use the scoped `@biomejs/biome`. The repo has no `biome.json`, so default Biome reformats untouched lines; check touched files with `bunx @biomejs/biome check --line-width 120 --indent-style tab <files>`.
- Affected tests: leave `test/test.ts` out of an `rg -l` importer list; it imports every suite, so it runs the full suite. `test/support/index.ts` re-exports `test/support/project.ts`, which imports `src/subagents.ts`, so an importer list of `src/subagents.ts` is nearly the full suite. Add the shared helpers that assert the text you change, such as `test/mux/pane-result-check.ts` (every backend's result check).

## Live behavior validation

Unit tests use fake mux backends. For changes to subagent runtime behavior, also run live repros; do not rely on fakes alone for detached/background launches, blocking/wait/join/detach, prompt/runtime coordination, frontmatter or env-var runtime branches, session/steer/resume, and mux/pane lifecycle.

- Model refs are per-user. For any live Pi run, ask the user which model to use (`PI_SUBAGENT_LIVE_MODEL=provider/model[:thinking]` for the Herdr smokes). Never hardcode provider/model refs in this file, tests, or scripts.
- Test with at least two models from different families the user has available, at `thinking high` for orchestration changes.
- To compare checkouts (upstream cf6dbf4, an older commit), start the parent with `pi --no-extensions -e <checkout>/src/index.ts`; otherwise it loads the installed package. Add `-e builtin:codemode --tools +codemode` when the parent must use codemode; `--no-extensions` also drops it.
- This repo commits no smoke agents (`.pi/` is gitignored). Per repro, create a temporary agent file under `.pi/agents/` or under a temp root pointed at by `PI_CODING_AGENT_DIR`. Give it `extensions: <worktree>/src/index.ts`; without it the child also loads the installed pi-subagents package.
- A live repro in tmux: `tmux new-session` on a running server does not pass the caller's environment (pass `-e NAME=value`), and a server started under `env -i` lacks `/opt/homebrew/bin` on the pane PATH, so Pi runs pane children headless.
- Start a live-repro parent or tmux server under `env -i` with PATH, HOME and SHELL: one started from a pi-subagents child shell inherits `PI_SUBAGENT_*` and `PI_DENY_TOOLS` and has no `subagent` tool.
- The settle fold (`src/runtime/context-fold.ts`) stubs launch briefs and result messages, not tool results: a `pi -p` parent's waited results stay whole, so check stubs with an interactive parent.
- Prefer `pi -p` for deterministic repros. For async-parent lifecycle/sidebar repros, use interactive TUI Pi and submit the prompt **after startup**: print/RPC/JSON and CLI startup prompts force synchronous child launches and mask the yielded interval.
- Use a temporary `--session-dir`; inspect parent and child session JSONL when behavior is subtle. For env-var or frontmatter branches, test both enabled and disabled states.
- Classify each parent/child outcome: `duplicate` (parent and child did the same work), `auxiliary` (child work did not advance the parent's goal), `clean_yield` (child did the delegated work and the parent surfaced it).
- Cleanup: delete the temporary agent files (or set `enabled: false`) and temp session dirs, and clear test-only environment variables.
