// Benchmark load probe: records which extension files this Pi process was told to
// load, so a sample can prove the checkout that the parent and each child ran.
// It writes only extension paths, never the environment or other arguments.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default function (pi: { on(event: string, handler: () => void): void }) {
	pi.on("session_start", () => {
		const dir = process.env.PI_BENCH_PROBE_DIR;
		if (!dir) return;
		const extensions: string[] = [];
		const argv = process.argv;
		for (let i = 0; i < argv.length - 1; i++) {
			if (argv[i] !== "-e" && argv[i] !== "--extension") continue;
			try {
				extensions.push(realpathSync(argv[i + 1]));
			} catch {
				extensions.push(argv[i + 1]);
			}
		}
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${process.pid}.json`),
			JSON.stringify({
				pid: process.pid,
				agent: process.env.PI_SUBAGENT_AGENT || null,
				extensions,
			}),
		);
	});
}
