import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const agentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
export const bundledExtension = () => path.join(root, ".bundled", "pi-subagent", "index.ts");

/** pi-subagent installed the documented way (clone into extensions/) or as a pi package. */
export function hasGlobalSubagent(dir = agentDir()): boolean {
  if (fs.existsSync(path.join(dir, "extensions", "subagent", "index.ts"))) return true;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    return (settings.packages ?? []).some((p: string) => /pi-subagent/.test(p));
  } catch {
    return false;
  }
}

/**
 * Loads the bundled pi-subagent extension when no global one exists. The child side of the review
 * (marking the run started/finished) lives in that extension, so without it a spawned review never ends.
 */
export async function loadBundledSubagent(pi: ExtensionAPI, dir = agentDir()): Promise<"global" | "bundled" | "missing"> {
  if (hasGlobalSubagent(dir)) return "global";
  const file = bundledExtension();
  if (!fs.existsSync(file)) return "missing";
  const mod = await import(pathToFileURL(file).href);
  await (mod.default ?? mod)(pi);
  return "bundled";
}

/** Trusts `project` for pi sessions of this agent dir, so the review child does not stop at the trust dialog. */
export async function ensureTrusted(project: string, dir = agentDir()) {
  const file = path.join(dir, "trust.json");
  let trust: Record<string, boolean> = {};
  try {
    trust = JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch {}
  if (trust[project]) return false;
  trust[project] = true;
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(trust, null, 2) + "\n");
  return true;
}
