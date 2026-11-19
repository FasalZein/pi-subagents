// Managed-install load check: npm pack this package, install the tarball into a temp folder with the npm
// flags of Pi's managed installs (pi-coding-agent dist/core/package-manager.js getNpmInstallArgs), then load
// the installed src/index.ts through Pi's own extension loader (scripts/pi-extension-load.mjs).
// The install resolves the regular dependencies through npm, so it needs the npm cache or the registry;
// that is why it stays out of npm test. Run: node --test scripts/managed-install-load.test.mjs
// Usage: node scripts/managed-install-load.mjs [package dir]   (default: this repository)
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PI_NPM_INSTALL_FLAGS = ["--legacy-peer-deps", "--no-audit", "--no-fund"];
const STEP_TIMEOUT_MS = 180_000;

function run(command, args, options) {
	const result = spawnSync(command, args, { encoding: "utf8", timeout: STEP_TIMEOUT_MS, ...options });
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

export function managedInstallLoad(packageDir = REPO) {
	const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-managed-install-")));
	try {
		const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? tmp };
		const pack = run("npm", ["pack", "--silent", "--pack-destination", tmp], { cwd: packageDir, env });
		if (pack.status !== 0) return { step: "pack", ...pack };
		const tarball = join(tmp, pack.output.trim().split("\n").at(-1));
		const root = join(tmp, "root");
		mkdirSync(root);
		writeFileSync(join(root, "package.json"), '{"name":"pi-extensions","private":true}\n');
		const install = run("npm", ["install", tarball, "--prefix", root, ...PI_NPM_INSTALL_FLAGS], { cwd: root, env });
		if (install.status !== 0) return { step: "install", ...install };
		const entry = join(root, "node_modules/pi-subagents/src/index.ts");
		const home = join(tmp, "home");
		mkdirSync(home);
		// The loader runs from this repository, so Pi's loader and aliases come from its dev install.
		const load = run(process.execPath, ["scripts/pi-extension-load.mjs", entry, home], {
			cwd: REPO,
			env: { PATH: env.PATH, HOME: home },
		});
		return { step: "load", ...load, output: load.output.replaceAll(tmp, "<tmp>") };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const result = managedInstallLoad(process.argv[2] ?? REPO);
	console.log(`step: ${result.step}, status: ${result.status}\n${result.output}`);
	process.exit(result.step === "load" && result.status === 0 ? 0 : 1);
}
