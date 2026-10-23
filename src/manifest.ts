import * as fs from "node:fs/promises";
import * as path from "node:path";

export type SetupStatus = "pending" | "running" | "done" | "declined";

export type Phase = "setup" | "plan" | "implement" | "diagnose" | "review" | "learn";

/** Bundled skills (vendor/skills) injected into each phase's prompt; the model never picks one. */
export const DEFAULT_SKILLS: Record<Phase, string[]> = {
  setup: ["grilling", "domain-modeling", "pstack-technical-writing", "pstack-create-verification-skill"],
  plan: ["tdd"],
  implement: ["tdd"],
  diagnose: ["diagnosing-bugs"],
  review: ["pstack-blast-radius"],
  learn: ["retro", "pstack-maintain-verification-skill"],
};

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
  /** Model per phase as "provider/model-id"; a missing phase keeps the session model. */
  models?: PhaseModels;
  /** Bundled skill names per phase; a missing phase uses DEFAULT_SKILLS. */
  skills?: Partial<Record<Phase, string[]>>;
  /** When the strong-model diff review runs. Default: only if the diff looks risky (size, dependencies, migrations, sensitive paths, new decisions).
   *  `plan` (default true): one short strong-model check of the plan's interface before the user approves it. */
  review?: { paths?: string[]; always?: boolean; never?: boolean; plan?: boolean };
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
    return { ...empty(), ...raw };
  } catch (error: any) {
    if (error.code === "ENOENT") return empty();
    throw new Error(`${MANIFEST_PATH} is not valid JSON: ${error.message}`);
  }
}

export async function updateManifest(root: string, change: (m: Manifest) => void): Promise<Manifest> {
  const manifest = await readManifest(root);
  change(manifest);
  const file = path.join(root, MANIFEST_PATH);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
