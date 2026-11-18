// Benchmark load probe: records, per session, which tools are registered and the
// file each came from (Pi sourceInfo), plus the effective model and thinking level.
// A tool from the checkout proves that the extension loaded, not only that a
// path was named. It writes no environment, arguments or credentials.
import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

type Tool = { name: string; sourceInfo?: { path?: string } };
type Ctx = {
	sessionManager: { getSessionFile(): string | undefined };
	model?: { provider: string; id: string };
	thinkingLevel?: string;
};
type Api = {
	on(event: string, handler: (event: unknown, ctx: Ctx) => void): void;
	getAllTools(): Tool[];
};

// The session file may not exist yet at session_start; resolve its folder instead.
function real(path: string): string {
	try {
		return join(realpathSync(dirname(path)), basename(path));
	} catch {
		return path;
	}
}

export default function (pi: Api) {
	pi.on("session_start", (_event, ctx) => {
		const dir = process.env.PI_BENCH_PROBE_DIR;
		if (!dir) return;
		// Tools of extensions register during load; read them after this handler returns.
		setTimeout(() => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			const record = {
				sessionFile: sessionFile ? real(sessionFile) : null,
				agent: process.env.PI_SUBAGENT_AGENT || null,
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
				thinking: ctx.thinkingLevel ?? null,
				tools: pi.getAllTools().map((tool) => ({
					name: tool.name,
					path: real(tool.sourceInfo?.path ?? ""),
				})),
			};
			mkdirSync(dir, { recursive: true });
			const target = join(dir, `${process.pid}.json`);
			writeFileSync(`${target}.tmp`, JSON.stringify(record));
			renameSync(`${target}.tmp`, target);
		}, 0);
	});
}
