// Node refuses to run TypeScript from inside node_modules, and pi-subagent's CLI is a .ts file.
// Copy it next to our sources so the bundled CLI works after `npm install`. Never fails the install.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { patchSharedSource } from "./patch-subagent.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "@earendil-works", "pi-subagent");
const to = join(root, ".bundled", "pi-subagent");
const tmp = `${to}.tmp`;
if (existsSync(join(from, "subagent.ts"))) {
  try {
    rmSync(tmp, { recursive: true, force: true });
    cpSync(from, tmp, { recursive: true });
    chmodSync(join(tmp, "subagent.ts"), 0o755);
    const shared = join(tmp, "shared.ts");
    const patched = patchSharedSource(readFileSync(shared, "utf8"));
    if (patched === undefined) console.warn("pi-improved: pi-subagent's launch line changed upstream; children will not inherit PI_CODING_AGENT_DIR");
    else writeFileSync(shared, patched);
    rmSync(to, { recursive: true, force: true });
    renameSync(tmp, to);
    // `subagent` for the model's bash: the subagent skill runs `subagent spawn`, and pi-improved puts this folder on PATH.
    const bin = join(root, ".bundled", "bin");
    rmSync(bin, { recursive: true, force: true });
    mkdirSync(bin);
    symlinkSync(join("..", "pi-subagent", "subagent.ts"), join(bin, "subagent"));
  } catch (err) {
    console.warn(`pi-improved: could not bundle pi-subagent (${err instanceof Error ? err.message : err})`);
  }
}
