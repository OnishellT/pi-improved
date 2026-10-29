import * as path from "node:path";
import { exists } from "./config.ts";

/** Bend is optional: outside /setup, nothing here runs and no prompt mentions it unless the project has a LAWS.bend. */
const LAWS = /(^|\/)LAWS\.bend$/;

/** The human's spec of a Bend project. Editing an existing one changes what "correct" means, so the user must see it. */
export const isLaws = (file: string) => LAWS.test(file);

export interface BendProject {
  /** Repo-relative path of LAWS.bend. */
  laws: string;
  /** Repo-relative path of the PROOF.bend next to it, once it exists. */
  proof?: string;
  /** `bend` is on the PATH of the login shell verify runs in (set by discover). */
  installed?: boolean;
}


/** LAWS.bend at the root (one per project); undefined for every project that does not use Bend. */
export async function findBend(root: string): Promise<BendProject | undefined> {
  if (!(await exists(path.join(root, "LAWS.bend")))) return undefined;
  const proof = (await exists(path.join(root, "PROOF.bend"))) ? "PROOF.bend" : undefined;
  return { laws: "LAWS.bend", proof };
}

/** Verify step: every law has a proof that checks (exit 1 when one fails). Telemetry off: it is a daily version ping. */
export const bendCheck = (proof: string) => `BEND_NO_TELEMETRY=1 bend --check-only '${proof.replace(/'/g, "'\\''")}'`;

export const BEND_INSTALL = "`curl -fsSL https://bend-lang.com/install.sh | sh` (installs to ~/.bend, no sudo; then put ~/.bend/bin on PATH)";

/** The implement rule a project with laws gets, whatever implement skills it picked. */
export const LAWS_RULE = "Critical logic is verified against the laws in LAWS.bend when the project has them; never edit LAWS.bend without the user's approval.";
