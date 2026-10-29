import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ComputerConfig } from "./computer/config.ts";
import { agentlintCheck } from "./discover.ts";
import { globalPath, globalPreferences, merge, readGlobal, withValidLimits, writeFileAtomicAsync, type Limits } from "./config.ts";
import type { ProfileFile } from "./self-compact/config.ts";

export type SetupStatus = "pending" | "running" | "done" | "declined";

export type Phase = "setup" | "plan" | "implement" | "diagnose" | "review" | "learn";

/** Bundled skills (vendor/skills) injected into each phase's prompt; the model never picks one. */
export const DEFAULT_SKILLS: Record<Phase, string[]> = {
  setup: ["grilling", "domain-modeling", "pstack-technical-writing", "writing-for-agents", "pstack-create-verification-skill"],
  plan: ["tdd", "contract-first"],
  // tdd and contract-first already reach the session with the plan block; only the implement-specific principles are added here.
  implement: ["principles-implement"],
  diagnose: ["diagnosing-bugs", "principles-diagnose"],
  review: ["code-review", "pstack-blast-radius", "principles-review"],
  learn: ["retro", "correct"],
};

/** Bundled skills offered per phase as a one-line index (name, description, path) instead of being injected; the agent reads one only if the task needs it. */
export const DEFAULT_ON_DEMAND: Record<Phase, string[]> = {
  setup: ["research"],
  plan: ["how", "architect", "codebase-design"],
  implement: ["handoff"],
  diagnose: ["why", "benchmark-checklist", "principle-explain-the-number"],
  review: ["benchmark-checklist", "principle-explain-the-number"],
  learn: ["pstack-maintain-verification-skill"],
};

/** Skills that are never in a default list: they only run when the user selects them explicitly (/skills). */
export const OPT_IN: string[] = ["interrogate", "reflect"];

export interface McpConfig {
  url: string;
}

export interface EnabledConnector {
  id: string;
  mcp?: McpConfig;
}

/** What the project file (`.pi/workflow.json`) says, with the user's global file (`<agent dir>/pi-improved.json`) under it for the preferences. */
export interface Manifest {
  version: 1;
  setup: SetupStatus;
  language?: string;
  startedAt?: string;
  completedAt?: string;
  verify: string[];
  /** agentlint command prefix when the project enforces agentlint rules, e.g. "pnpm agentlint". */
  agentlint?: string;
  /** The verify step setup itself added for agentlint. Opting out removes this step and nothing else. */
  agentlintStep?: string;
  connectors: EnabledConnector[];
  /** Working mode. `direct` (default when absent): the agent works from AGENTS.md and skills, /task is optional. `flow`: /task with its gates is the recommended route. */
  mode?: "direct" | "flow";
  /** Model per phase as "provider/model-id"; a missing phase keeps the session model. */
  models?: PhaseModels;
  /** Bundled skill names per phase; a missing phase uses DEFAULT_SKILLS. */
  skills?: Partial<Record<Phase, string[]>>;
  /** Bundled skill names per phase listed as an on-request index; a missing phase uses DEFAULT_ON_DEMAND. */
  skillsOnDemand?: Partial<Record<Phase, string[]>>;
  /** Whether /setup adds agentlint rules: `ask` (default) asks, `always` adds them without asking, `never` neither asks nor enforces them. */
  useAgentlint?: "ask" | "always" | "never";
  /** Bend laws: "ask" (default) lets /setup offer to record the domain's invariants as laws, "always" drafts them without asking first, "never" leaves Bend out of setup. A project that already has LAWS.bend is unaffected. */
  useBend?: "ask" | "always" | "never";
  /** Append the unslop skill and two working-style lines to the main session's system prompt (default true; false turns it off). */
  basePrompt?: boolean;
  /** Characters of failing-step output kept in a verify report (default 4000, minimum 200). Smaller is cheaper on every retry. */
  maxReport?: number;
  /** Context size in tokens at which a one-time notice suggests /compact or a new session (default 150000; 0 turns it off). */
  contextWarn?: number;
  /** Risk policy. The model review runs when the policy asks for it: `always`, or `minLevel` "low" (any risk) / "high" (high risk only, the default); "off" never reviews.
   *  `always` beats `never`. `plan` true adds the plan check for any plan, false turns it off (otherwise it runs only when risk asks for it).
   *  `maxLines`/`maxFiles` set where "low" starts, `highLines`/`highFiles` where "high" starts. */
  review?: { paths?: string[]; always?: boolean; never?: boolean; plan?: boolean; minLevel?: "off" | "low" | "high"; maxLines?: number; maxFiles?: number; highLines?: number; highFiles?: number };
  /** Numbers the workflow used to hardcode; see `Limits` in config.ts for the keys and DEFAULT_LIMITS for the defaults. Unchecked here: `resolveLimits` fills defaults and reports bad values. */
  limits?: { [K in keyof Limits]?: unknown } | undefined;
  /** What /computer saves: the browser and desktop the agent can drive. Meant for the global file. */
  computer?: ComputerConfig;
  /** `"tern"` opens subagent panes in Tern when pi runs in it (default: tmux only). */
  subagentPanes?: string;
  /** Self-compact thresholds per model, the shape of the old `self-compact.json`. */
  selfCompact?: ProfileFile;
}

export interface PhaseModels {
  /** One-off project setup: worth a stronger model. */
  setup?: string;
  /** /task planning and implementation: the cheap everyday model. */
  implement?: string;
  /** Read-only diff review by a subagent before a task closes. */
  review?: string;
  /** Stronger model for a retry after verify keeps failing; falls back to `review`, then `setup`. */
  escalate?: string;
}

export const MANIFEST_PATH = ".pi/workflow.json";

const empty = (): Manifest => ({ version: 1, setup: "pending", verify: [], connectors: [] });

/** The project file alone, with the state defaults. This is what gets written back; preferences from the global file are not in it. */
export async function readProjectManifest(root: string): Promise<Manifest> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(root, MANIFEST_PATH), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the root must be an object");
    const m = { ...empty(), ...raw };
    if (!Array.isArray(m.verify)) m.verify = [];
    if (!Array.isArray(m.connectors)) m.connectors = [];
    return m;
  } catch (error: any) {
    if (error.code === "ENOENT") return empty();
    throw new Error(`${MANIFEST_PATH} is not valid JSON: ${error.message}`);
  }
}

/**
 * The manifest in force: the global file's preferences with the project file on top. State (setup, verify, connectors...) comes from the project only.
 * A global file that cannot be read counts as empty (callers must keep working; /doctor and the session start report it).
 * Invalid `limits` are dropped per file before merging, so a bad project value falls back to the global one. A `null` in the project file unsets a global value.
 */
export async function readManifest(root: string): Promise<Manifest> {
  const project = await readProjectManifest(root);
  let global: Record<string, any> = {};
  try {
    global = globalPreferences(readGlobal());
  } catch {}
  const manifest: Manifest = merge(withValidLimits(global), withValidLimits(project));
  // A setup from before the agentlint step was recorded may only run agentlint inside a script of the user's: add and record the
  // standard step once, as setup_finish does now, so agentlint findings keep their per-finding approval.
  if (manifest.setup === "done" && manifest.agentlint && manifest.useAgentlint !== "never" && !manifest.agentlintStep) {
    const step = agentlintCheck(manifest.agentlint);
    if (!manifest.verify.includes(step)) manifest.verify = [...manifest.verify, step];
    manifest.agentlintStep = step;
    await updateManifest(root, (m) => {
      if (!m.verify.includes(step)) m.verify = [...m.verify, step];
      m.agentlintStep = step;
    }).catch(() => {});
  }
  return manifest;
}

/** One map (models, skills, skillsOnDemand) of the global file alone; undefined when it has none or the file cannot be read. */
export function globalMap<K extends "models" | "skills" | "skillsOnDemand">(key: K): Manifest[K] {
  try {
    return readGlobal()[key];
  } catch {
    return undefined;
  }
}

/** Read-modify-write of the project file only (`change` gets its own content, never the global values); no locking: concurrent writers are last-writer-wins. */
export async function updateManifest(root: string, change: (m: Manifest) => void): Promise<Manifest> {
  const manifest = await readProjectManifest(root);
  change(manifest);
  await writeFileAtomicAsync(path.join(root, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * The map to store in the project file after an interactive edit of a merged map (models, skills): the project's own
 * entries with only the keys the user changed applied, so values that come from the global file are not copied into the repo.
 * A key the user unset while the global file (`inherited`) still has it is stored as `null`, which the merge reads as "unset".
 */
export function patchMap<T extends object>(own: T | undefined, before: T, after: T, inherited?: T): T | undefined {
  const out: Record<string, unknown> = { ...own };
  const was = before as Record<string, unknown>;
  const now = after as Record<string, unknown>;
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (JSON.stringify(was[key]) === JSON.stringify(now[key])) continue;
    if (now[key] !== undefined) out[key] = now[key];
    else if ((inherited as Record<string, unknown> | undefined)?.[key] !== undefined) out[key] = null;
    else delete out[key];
  }
  return Object.keys(out).length ? (out as T) : undefined;
}

/** Which of the two config files exist, for /doctor. */
export function configFiles(root: string, dir?: string) {
  const files = { global: globalPath(dir), project: path.join(root, MANIFEST_PATH) };
  return Object.fromEntries(Object.entries(files).map(([name, file]) => [name, { file, exists: existsSync(file) }])) as Record<"global" | "project", { file: string; exists: boolean }>;
}
