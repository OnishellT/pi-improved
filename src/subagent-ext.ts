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
    // A package is a source string or an object with a `source`.
    return (settings.packages ?? []).some((p: unknown) => /pi-subagent/.test(typeof p === "string" ? p : String((p as any)?.source ?? "")));
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
  } catch (error: any) {
    // Only a missing file means "nobody trusted yet"; an unreadable or corrupt one is left alone so no entry is lost.
    if (error?.code !== "ENOENT") return false;
  }
  if (!trust || typeof trust !== "object" || trust[project]) return false;
  trust[project] = true;
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(trust, null, 2) + "\n");
  await fs.promises.rename(tmp, file);
  return true;
}
