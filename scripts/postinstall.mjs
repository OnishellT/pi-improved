// Node refuses to run TypeScript from inside node_modules, and pi-subagent's CLI is a .ts file.
// Copy it next to our sources so the bundled CLI works after `npm install`.
import { chmodSync, cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "@earendil-works", "pi-subagent");
const to = join(root, ".bundled", "pi-subagent");
if (existsSync(from)) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  chmodSync(join(to, "subagent.ts"), 0o755);
}
