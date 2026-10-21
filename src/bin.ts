import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type Bin = "subagent" | "agentlint";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Bundled CLI from this package's node_modules, else the bare name for a PATH lookup. */
export function resolveBin(name: Bin): string {
  // pi-subagent's .ts CLI is copied out of node_modules by scripts/postinstall.mjs (node won't strip types there).
  const bundled = name === "subagent" ? path.join(root, ".bundled", "pi-subagent", "subagent.ts") : path.join(root, "node_modules", ".bin", name);
  return fs.existsSync(bundled) ? bundled : name;
}

export const hasBin = (name: Bin) => resolveBin(name) !== name;
