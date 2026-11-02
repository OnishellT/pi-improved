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

/** A free name for the retired copy: `<file>.migrated`, else `<file>.migrated.2`, ... so an earlier backup is never overwritten. */
function freeName(file: string): string {
  for (let n = 1; ; n++) {
    const name = `${file}.migrated${n > 1 ? `.${n}` : ""}`;
    if (!fs.existsSync(name)) return name;
  }
}

/** Renames `file` to a free `<file>.migrated` name, so it is never found again and nothing is lost. Returns that name's suffix, or undefined when it cannot (a read-only dir): the next start tries again. */
function retire(file: string): string | undefined {
  try {
    const name = freeName(file);
    fs.renameSync(file, name);
    return name.slice(file.length);
  } catch {
    return undefined;
  }
}

const moved = (old: string, target: string, suffix: string) => `Moved ${old} into ${target} (old file renamed to ${old}${suffix}).`;
/** An old file left by an earlier migration: while it is there, removing the key from the new file would copy the old value back. */
const retired = (old: string, key: string, target: string, suffix: string) => `${old} is no longer read (${target} has ${key}): renamed it to ${old}${suffix}.`;

/** Global legacy: `computer.json`, `self-compact.json` and `subagentPanes` in pi's `settings.json`, into the global file. Returns one notice per file. */
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
  const present = found.filter(([, , value]) => value !== undefined);
  const todo = present.filter(([, key]) => !Object.hasOwn(config, key));
  const target = globalPath(dir);
  if (todo.length) {
    try {
      updateGlobal((c) => todo.forEach(([, key, value]) => void (c[key] = value)), dir);
    } catch {
      return []; // read-only agent dir: the old files keep being found, and the move is tried again next time
    }
  }
  return present.flatMap(([old, key]) => {
    const copied = todo.some(([o]) => o === old);
    // pi's own settings.json is not ours to rename: only the key in it is stale.
    if (old === "settings.json") return copied ? [`Moved subagentPanes from settings.json into ${target}. Remove it from settings.json: it is no longer read.`] : [];
    const suffix = retire(path.join(dir, old));
    if (!suffix) return [copied ? `Moved ${old} into ${target}. Delete ${old}: it is no longer read.` : `${old} is no longer read (${target} has ${key}). Delete it.`];
    return [copied ? moved(old, target, suffix) : retired(old, key, target, suffix)];
  });
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
  if (!isObject(own)) return [];
  if (Object.hasOwn(own, "selfCompact")) {
    const suffix = retire(old);
    return [suffix ? retired(".pi/self-compact.json", "selfCompact", MANIFEST_PATH, suffix) : `.pi/self-compact.json is no longer read (${MANIFEST_PATH} has selfCompact). Delete it.`];
  }
  try {
    writeFileAtomic(file, `${JSON.stringify({ ...own, selfCompact: value }, null, 2)}\n`);
  } catch {
    return [];
  }
  const suffix = retire(old);
  return [suffix ? moved(".pi/self-compact.json", MANIFEST_PATH, suffix) : `Moved .pi/self-compact.json into ${MANIFEST_PATH}. Delete .pi/self-compact.json: it is no longer read.`];
}

/** Both migrations; `root` left out migrates only the global files. Safe to call from every extension at startup: once a key is in place it moves nothing and says nothing. */
export const migrateLegacy = (root?: string, dir = agentDir()): string[] => [...migrateGlobal(dir), ...(root ? migrateProject(root) : [])];
