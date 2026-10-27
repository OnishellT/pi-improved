// Node refuses to run TypeScript from inside node_modules, and pi-subagent's CLI is a .ts file.
// Copy it next to our sources so the bundled CLI works after `npm install`. Never fails the install.
import { chmodSync, cpSync, existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "@earendil-works", "pi-subagent");
const to = join(root, ".bundled", "pi-subagent");
const tmp = `${to}.tmp`;
if (existsSync(join(from, "subagent.ts"))) {
  try {
    rmSync(tmp, { recursive: true, force: true });
    cpSync(from, tmp, { recursive: true });
    chmodSync(join(tmp, "subagent.ts"), 0o755);
    rmSync(to, { recursive: true, force: true });
    renameSync(tmp, to);
  } catch (err) {
    console.warn(`pi-improved: could not bundle pi-subagent (${err instanceof Error ? err.message : err})`);
  }
}
