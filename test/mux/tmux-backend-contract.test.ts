import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmuxBackend } from "../../src/mux/tmux.ts";
import { writeExecutable } from "../support/index.ts";
import { runMuxBackendContract } from "./backend-contract.ts";

// Stateful fake tmux. Per pane in $FAKE_TMUX_STATE (pane id without "%"):
// pane-N holds the screen, pending-N the typed text that is not submitted yet,
// submitted-N one line per submitted command (Enter or C-m moves pending-N there).
// Pane %0 exists as the parent pane, so a send to the wrong pane succeeds and the check must catch it.
// It answers only the subcommands and argument positions that src/mux/tmux.ts sends.
// display-message fails for geometry formats, so createSurface takes the new-window path.
const FAKE_TMUX = `#!/bin/sh
S="$FAKE_TMUX_STATE"
pane_file() {
  f="$S/pane-\${1#%}"
  [ -f "$f" ] || { echo "can't find pane: $1" >&2; exit 1; }
}
cmd="$1"
shift
case "$cmd" in
  new-window|split-window)
    n=$(cat "$S/next" 2>/dev/null || echo 1)
    echo $((n + 1)) > "$S/next"
    : > "$S/pane-$n"; : > "$S/pending-$n"; : > "$S/submitted-$n"
    printf '%%%s\\n' "$n"
    ;;
  send-keys)
    pane_file "$2"
    p="$S/pending-\${2#%}"
    if [ "$3" = "-l" ]; then
      printf '%s' "$4" >> "$f"; printf '%s' "$4" >> "$p"
    elif [ "$3" = "Enter" ] || [ "$3" = "C-m" ]; then
      printf '\\n' >> "$f"; { cat "$p"; printf '\\n'; } >> "$S/submitted-\${2#%}"; : > "$p"
    else
      echo "fake tmux: unsupported key $3" >&2; exit 2
    fi
    ;;
  capture-pane)
    pane_file "$3"
    tail -n "\${5#-}" "$f"
    ;;
  kill-pane)
    pane_file "$2"
    rm -f "$f"
    ;;
  display-message)
    case "$4" in
      '#{window_id}') echo '@1' ;;
      '#{session_id}') echo '$1' ;;
      *) exit 1 ;;
    esac
    ;;
  rename-window|rename-session)
    printf '%s\\n' "$3" >> "$S/titles"
    ;;
  *)
    echo "fake tmux: unsupported $cmd" >&2
    exit 2
    ;;
esac
`;

runMuxBackendContract({
	adapter: tmuxBackend,
	installFake(binDir, stateDir) {
		writeExecutable(binDir, "tmux", FAKE_TMUX);
		for (const file of ["pane-0", "pending-0", "submitted-0"]) writeFileSync(join(stateDir, file), "");
		return {
			FAKE_TMUX_STATE: stateDir,
			TMUX: "fake-tmux-socket",
			TMUX_PANE: "%0",
			PI_SUBAGENT_RENAME_TMUX_WINDOW: "1",
			PI_SUBAGENT_RENAME_TMUX_SESSION: "1",
		};
	},
	runtimeEnvKeys: ["TMUX"],
	recordedTitles(stateDir) {
		const file = join(stateDir, "titles");
		return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
	},
	submittedCommands(stateDir, surface) {
		const file = join(stateDir, `submitted-${surface.replace(/^%/, "")}`);
		if (!existsSync(file)) return [];
		const text = readFileSync(file, "utf8");
		return text === "" ? [] : text.replace(/\n$/, "").split("\n");
	},
});
