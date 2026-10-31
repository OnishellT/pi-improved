import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { agentDir } from "./subagent-ext.ts";

/** The user's one config file, `<agent dir>/pi-improved.json`: every option, for every project. A project's `.pi/workflow.json` wins over it. */
export const GLOBAL_FILE = "pi-improved.json";
export const globalPath = (dir = agentDir()) => path.join(dir, GLOBAL_FILE);

/** Preferences the global file may hold (the project file may hold the same ones). */
export const PREFERENCE_KEYS = ["mode", "models", "skills", "skillsOnDemand", "basePrompt", "useAgentlint", "useBend", "maxReport", "contextWarn", "review", "limits", "computer", "subagentPanes", "selfCompact", "understanding"];

export const isObject = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** `{}` when the file does not exist. Throws a readable error when it exists but is not a JSON object. */
export function readGlobal(dir = agentDir()): Record<string, any> {
  const file = globalPath(dir);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error: any) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: any) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
  if (!isObject(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed;
}

/** Why the global file cannot be read, or undefined when it can (or is missing). */
export function globalProblem(dir = agentDir()): string | undefined {
  try {
    readGlobal(dir);
  } catch (error: any) {
    return error.message;
  }
}

const tempName = (file: string) => `${file}.${process.pid}.${randomUUID()}.tmp`;

/** A config file may hold credentials (custom MCP servers): replacing it keeps its permissions, and a new one is private. */
const modeOf = (file: string) => {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return 0o600;
  }
};

/** Write through a temp file in the same directory and rename it over `file`, so a crash never leaves half a config. */
export function writeFileAtomic(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = tempName(file);
  try {
    fs.writeFileSync(temp, text, { mode: modeOf(file) });
    fs.chmodSync(temp, modeOf(file));
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** Same as `writeFileAtomic`, without blocking. */
export async function writeFileAtomicAsync(file: string, text: string) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = tempName(file);
  try {
    await fsp.writeFile(temp, text, { mode: modeOf(file) });
    await fsp.chmod(temp, modeOf(file));
    await fsp.rename(temp, file);
  } catch (error) {
    await fsp.rm(temp, { force: true });
    throw error;
  }
}

/** Whether a path exists (any kind of entry). A missing path or parent is false; any other error (permissions, a symlink loop) is thrown. */
export const exists = (file: string) =>
  fsp.access(file).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  });

/** Read-modify-write of the global file, keeping every key the change does not touch. */
export function updateGlobal(change: (config: Record<string, any>) => void, dir = agentDir()) {
  const config = readGlobal(dir);
  change(config);
  writeFileAtomic(globalPath(dir), `${JSON.stringify(config, null, 2)}\n`);
}

/** Plain objects merge key by key; arrays and scalars in `over` replace what `base` has. A `null` in `over` means "unset": the key is dropped, even when `base` has it. */
export function merge(base: unknown, over: unknown): any {
  if (!isObject(over)) return over;
  const out: Record<string, any> = isObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(over)) {
    if (key === "__proto__") continue;
    if (value === null) delete out[key];
    else out[key] = merge(isObject(base) && Object.hasOwn(base, key) ? base[key] : undefined, value);
  }
  return out;
}

/** The global file without state keys and unknown keys: what may sit under a project's own values. */
export const globalPreferences = (config: Record<string, any>) => Object.fromEntries(Object.entries(config).filter(([key]) => PREFERENCE_KEYS.includes(key)));

export interface Limits {
  /** Questions of the /setup interview. */
  interviewQuestions: number;
  /** agentlint rules offered at first, in /setup. */
  agentlintRules: number;
  /** Verify retries (and contract retries) before the agent asks whether to keep trying. */
  verifyRetries: number;
  /** Failed verifies before the stronger model takes over. */
  failuresBeforeEscalation: number;
  /** Paid plan checks per task; 0 turns them off. */
  planChecks: number;
  /** A retro every N finished tasks; 0 turns it off. */
  retroEvery: number;
  /** While implementing, run the first verify command after every N write/edit calls and append its tail to the tool result; 0 turns it off. */
  verifyEvery: number;
  /** Changed lines in one change (lockfiles, generated and vendored paths not counted) above which the diff is high risk, so the review checks that it has one purpose. */
  changeCap: number;
  /** Largest plan the "Plan recorded" notice calls small; above it, the size is listed as a risk reason. */
  fastPath: { files: number; interface: number; decisions: number };
}

export const DEFAULT_LIMITS: Limits = {
  interviewQuestions: 12,
  agentlintRules: 3,
  verifyRetries: 2,
  failuresBeforeEscalation: 2,
  planChecks: 1,
  retroEvery: 5,
  verifyEvery: 5,
  changeCap: 500,
  fastPath: { files: 8, interface: 6, decisions: 2 },
};

/** Smallest value that makes sense for each limit; every limit is a whole number. */
const MIN_LIMITS: Record<string, number> = { interviewQuestions: 1, agentlintRules: 1, verifyRetries: 0, failuresBeforeEscalation: 1, planChecks: 0, retroEvery: 0, verifyEvery: 0, changeCap: 1 };
const MIN_FAST_PATH = 0;

/** What is valid in one file's `limits`, and what is wrong with the rest. A bad value is left out, so a lower layer's value (or the default) applies. */
export function checkLimits(raw: unknown): { valid: { [K in keyof Limits]?: any }; problems: string[] } {
  const problems: string[] = [];
  const valid: Record<string, any> = {};
  const ok = (name: string, value: unknown, min: number) => {
    if (typeof value === "number" && Number.isInteger(value) && value >= min) return true;
    problems.push(`${name} must be a whole number >= ${min}, not ${JSON.stringify(value)}: ignored`);
    return false;
  };
  if (raw === undefined || raw === null) return { valid, problems };
  if (!isObject(raw)) return { valid, problems: [`limits must be an object, not ${JSON.stringify(raw)}: ignored`] };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "fastPath") {
      if (!isObject(value)) problems.push(`limits.fastPath must be an object, not ${JSON.stringify(value)}: ignored`);
      else {
        for (const [part, entry] of Object.entries(value)) {
          if (!Object.hasOwn(DEFAULT_LIMITS.fastPath, part)) problems.push(`limits.fastPath.${part} is not a known limit: ignored`);
          else if (ok(`limits.fastPath.${part}`, entry, MIN_FAST_PATH)) (valid.fastPath ??= {})[part] = entry;
        }
      }
    } else if (!Object.hasOwn(MIN_LIMITS, key)) problems.push(`limits.${key} is not a known limit: ignored`);
    else if (ok(`limits.${key}`, value, MIN_LIMITS[key])) valid[key] = value;
  }
  return { valid, problems };
}

/** The limits with defaults filled in, and what was wrong with the rest: a bad value falls back to its default. */
export function resolveLimits(raw: unknown): { limits: Limits; problems: string[] } {
  const { valid, problems } = checkLimits(raw);
  return { limits: { ...DEFAULT_LIMITS, ...valid, fastPath: { ...DEFAULT_LIMITS.fastPath, ...valid.fastPath } }, problems };
}

/** `config` with its `limits` cut down to the valid entries (a null `limits` stays: it means "unset"). */
export function withValidLimits<T extends Record<string, any>>(config: T): T {
  return Object.hasOwn(config, "limits") && config.limits !== null ? { ...config, limits: checkLimits(config.limits).valid } : config;
}

/** The limits in force for a manifest (anything with an optional `limits`). */
export const limitsOf = (manifest?: { limits?: unknown }): Limits => resolveLimits(manifest?.limits).limits;
