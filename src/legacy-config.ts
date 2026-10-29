import * as fs from "node:fs";
import * as path from "node:path";
import { globalPath, isObject, readGlobal, updateGlobal, writeFileAtomic } from "./config.ts";
import { MANIFEST_PATH } from "./manifest.ts";
import { agentDir } from "./subagent-ext.ts";

// Settings used to live in several files. Each one is copied once into the file that holds it now, and never read again.

/** The JSON object in `file`, or undefined when it is missing, unreadable or not an object. */
function readObject(file: string): Record<string, any> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** `cleanup` says how to get rid of the old copy: while it exists, removing the key from the new file would bring the old value back. */
const moved = (old: string, key: string, target: string, cleanup = `Delete ${old} now`) =>
  `Moved ${key} from ${old} into ${target}. ${old} is no longer read and was left as it was. ${cleanup}: while it is there, removing ${key} from ${target} copies the old value back.`;

/** Global legacy: `computer.json`, `self-compact.json` and `subagentPanes` in pi's `settings.json`, into the global file. Returns one notice per move. */
export function migrateGlobal(dir = agentDir()): string[] {
  let config: Record<string, any>;
  try {
    config = readGlobal(dir);
  } catch {
    return []; // an unreadable global file is for /doctor to report; nothing gets written over it
  }
  const settings = readObject(path.join(dir, "settings.json"))?.subagentPanes;
  const found: [string, string, unknown][] = [
    ["computer.json", "computer", readObject(path.join(dir, "computer.json"))],
    ["self-compact.json", "selfCompact", readObject(path.join(dir, "self-compact.json"))],
    ["settings.json", "subagentPanes", typeof settings === "string" ? settings : undefined],
  ];
  const todo = found.filter(([, key, value]) => value !== undefined && !Object.hasOwn(config, key));
  if (!todo.length) return [];
  try {
    updateGlobal((c) => todo.forEach(([, key, value]) => void (c[key] = value)), dir);
  } catch {
    return []; // read-only agent dir: the old files keep being found, and the move is tried again next time
  }
  return todo.map(([old, key]) => moved(old, key, globalPath(dir), old === "settings.json" ? "Remove subagentPanes from settings.json now" : undefined));
}

/** Project legacy: `.pi/self-compact.json` into that project's `.pi/workflow.json`. Writes only the moved key, never the setup defaults. */
export function migrateProject(root: string): string[] {
  const old = path.join(root, ".pi", "self-compact.json");
  const value = readObject(old);
  if (!value) return [];
  const file = path.join(root, MANIFEST_PATH);
  let own: Record<string, any> = {};
  try {
    own = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error: any) {
    if (error.code !== "ENOENT") return []; // an invalid workflow.json is reported elsewhere; it is not overwritten
  }
  if (!isObject(own) || Object.hasOwn(own, "selfCompact")) return [];
  try {
    writeFileAtomic(file, `${JSON.stringify({ ...own, selfCompact: value }, null, 2)}\n`);
  } catch {
    return [];
  }
  return [moved(".pi/self-compact.json", "selfCompact", MANIFEST_PATH)];
}

/** Both migrations; `root` left out migrates only the global files. Safe to call from every extension at startup: once a key is in place it moves nothing and says nothing. */
export const migrateLegacy = (root?: string, dir = agentDir()): string[] => [...migrateGlobal(dir), ...(root ? migrateProject(root) : [])];
