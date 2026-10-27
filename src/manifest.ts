import * as fs from "node:fs/promises";
import * as path from "node:path";

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
  learn: ["retro", "correct", "pstack-maintain-verification-skill"],
};

/** Bundled skills offered per phase as a one-line index (name, description, path) instead of being injected; the agent reads one only if the task needs it. */
export const DEFAULT_ON_DEMAND: Record<Phase, string[]> = {
  setup: ["research"],
  plan: ["how", "architect", "codebase-design"],
  implement: ["handoff"],
  diagnose: ["why"],
  review: [],
  learn: [],
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

/** Project state committed to the repo at `.pi/workflow.json`. */
export interface Manifest {
  version: 1;
  setup: SetupStatus;
  language?: string;
  startedAt?: string;
  completedAt?: string;
  verify: string[];
  /** agentlint command prefix when the project enforces agentlint rules, e.g. "pnpm agentlint". */
  agentlint?: string;
  connectors: EnabledConnector[];
  /** Working mode. `direct` (default when absent): the agent works from AGENTS.md and skills, /task is optional. `flow`: /task with its gates is the recommended route. */
  mode?: "direct" | "flow";
  /** Model per phase as "provider/model-id"; a missing phase keeps the session model. */
  models?: PhaseModels;
  /** Bundled skill names per phase; a missing phase uses DEFAULT_SKILLS. */
  skills?: Partial<Record<Phase, string[]>>;
  /** Bundled skill names per phase listed as an on-request index; a missing phase uses DEFAULT_ON_DEMAND. */
  skillsOnDemand?: Partial<Record<Phase, string[]>>;
  /** Append the unslop skill and two working-style lines to the main session's system prompt (default true; false turns it off). */
  basePrompt?: boolean;
  /** Characters of failing-step output kept in a verify report (default 4000, minimum 200). Smaller is cheaper on every retry. */
  maxReport?: number;
  /** Context size in tokens at which a one-time notice suggests /compact or a new session (default 150000; 0 turns it off). */
  contextWarn?: number;
  /** Risk policy. The model review runs only when asked: `always`, or `minLevel` "low" (any risk) / "high" (high risk only); default "off".
   *  `always` beats `never`. `plan` true adds the plan check for any plan, false turns it off (otherwise it runs only when risk asks for it).
   *  `maxLines`/`maxFiles` set where "low" starts, `highLines`/`highFiles` where "high" starts. */
  review?: { paths?: string[]; always?: boolean; never?: boolean; plan?: boolean; minLevel?: "off" | "low" | "high"; maxLines?: number; maxFiles?: number; highLines?: number; highFiles?: number };
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

export async function readManifest(root: string): Promise<Manifest> {
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

/** Read-modify-write with no locking: concurrent writers are last-writer-wins. */
export async function updateManifest(root: string, change: (m: Manifest) => void): Promise<Manifest> {
  const manifest = await readManifest(root);
  change(manifest);
  const file = path.join(root, MANIFEST_PATH);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
