import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmuxBackend } from "../../src/mux/tmux.ts";
import { writeExecutable } from "../support/index.ts";
import { runMuxBackendContract } from "./backend-contract.ts";

// Stateful fake tmux: one file per pane in $FAKE_TMUX_STATE, named after the pane id without "%".
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
    : > "$S/pane-$n"
    printf '%%%s\\n' "$n"
    ;;
  send-keys)
    pane_file "$2"
    if [ "$3" = "-l" ]; then printf '%s' "$4" >> "$f"; else printf '\\n' >> "$f"; fi
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
});
