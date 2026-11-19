// Load one extension entry through Pi's own extension loader (discoverAndLoadExtensions), with the
// module aliases Pi applies to installed extensions. Exit 0 when it loads with no error, 1 otherwise.
// Usage: node scripts/pi-extension-load.mjs <entry> <cwd>
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const [entry, cwd] = process.argv.slice(2);
if (!entry || !cwd) {
	console.error("usage: pi-extension-load.mjs <entry> <cwd>");
	process.exit(2);
}
const result = await discoverAndLoadExtensions([entry], cwd, `${cwd}/agent`);
console.log(`extensions loaded: ${result.extensions.length}`);
for (const e of result.errors) console.log(`load error: ${String(e.error).split("\n")[0]}`);
// The extension can leave timers or watchers open; the verdict is complete here.
process.exit(result.errors.length === 0 && result.extensions.length > 0 ? 0 : 1);
