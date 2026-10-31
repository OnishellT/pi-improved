import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The agent dir as pi and the bundled pi-subagent read it: PI_CODING_AGENT_DIR with `~` and a file:// URL expanded, or ~/.pi/agent. */
export function agentDir(): string {
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (!dir) return path.join(os.homedir(), ".pi", "agent");
  if (dir === "~") return os.homedir();
  if (dir.startsWith("~/")) return path.join(os.homedir(), dir.slice(2));
  if (dir.startsWith("file://")) return fileURLToPath(dir);
  return dir;
}
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
  await (mod.default ?? mod)(subagentHost(pi));
  return "bundled";
}

/** pi-subagent's own `/subagent`, which subagent-view.ts falls back to outside Tern. */
export let bundledCommand: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void } | undefined;

/** The API the bundled pi-subagent gets: its `/subagent` is kept aside and its widget dropped, for subagent-view.ts. */
export function subagentHost(pi: ExtensionAPI): ExtensionAPI {
  const noWidget = (ctx: any) => ctx && new Proxy(ctx, { get: (c, key) => (key === "ui" ? new Proxy(c.ui, { get: (ui, k) => (k === "setWidget" ? () => {} : Reflect.get(ui, k)) }) : Reflect.get(c, key)) });
  return new Proxy(pi, {
    get: (target, key) => {
      if (key === "registerCommand") return (name: string, options: any) => (name === "subagent" ? void (bundledCommand = options) : target.registerCommand(name, options));
      if (key === "on") return (event: any, handler: any) => target.on(event, (e: any, ctx: any) => handler(e, noWidget(ctx)));
      return Reflect.get(target, key);
    },
  });
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
