import * as fs from "node:fs/promises";
import * as path from "node:path";
import { limitsOf } from "./config.ts";
import { diffBase, git, untrackedFiles, type Exec } from "./git.ts";
import type { Manifest } from "./manifest.ts";
import { inFiles, type Task } from "./task-state.ts";
import { isManifest, isMigration } from "./triggers.ts";

// Defaults of the size thresholds; `review.maxLines/maxFiles/highLines/highFiles` override them.
const MAX_LINES = 200;
const MAX_FILES = 6;
const HIGH_LINES = 600;
const HIGH_FILES = 15;
const DEPENDENCIES = /(^|\/)(pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|package-lock\.json|Gemfile(\.lock)?)$/;
// Path patterns only, no language parsing: a test directory, or test/spec as a separated word in the file name (`a.test.ts`, `a_test.go`, `test_a.py`, `tests.rs`) or a CamelCase suffix (`ATest.java`).
const TEST_DIR = /(^|\/)(tests?|__tests__|spec|e2e|__mocks__)\//i;
const TEST_WORD = /(^|[._-])(tests?|spec)([._-]|$)/i;
const TEST_CAMEL = /[a-z0-9](Tests?|Spec)(\.|$)|^(Tests?|Spec)[A-Z]/;
const SENSITIVE = /(^|\/)(auth\w*|payments?|billing|security|crypto\w*|migrations?|infra(structure)?)\//i;

export const isTestFile = (file: string) => {
  const name = file.slice(file.lastIndexOf("/") + 1);
  return TEST_DIR.test(file) || TEST_WORD.test(name) || TEST_CAMEL.test(name);
};

export type RiskLevel = "none" | "low" | "high";
type ReviewPolicy = NonNullable<Manifest["review"]>;

const globRegex = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/|\*\*/g, (m) => (m.endsWith("/") ? "\u0000" : "\u0001")).replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?").replace(/\u0001/g, ".*")}$`);

/** Why a plan is not small enough to skip approval; empty = fast path. A small plan (up to `limits.fastPath` files, interface entries and decisions) with no risk trigger skips the human approval dialog. Cheap: counts and regexes on the planned paths. */
export function planRiskReasons(plan: { files: string[]; interface: unknown[]; decisions: unknown[] }, manifest: Manifest): string[] {
  const reasons: string[] = [];
  const small = limitsOf(manifest).fastPath;
  if (manifest.review?.always) reasons.push("review.always");
  if (plan.files.length > small.files) reasons.push(`${plan.files.length} files`);
  if (plan.interface.length > small.interface) reasons.push(`${plan.interface.length} interface entries`);
  if (plan.decisions.length > small.decisions) reasons.push(`${plan.decisions.length} decisions`);
  reasons.push(...highRiskReasons(plan.files, manifest.review));
  return reasons;
}

const threshold = (value: number | undefined, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback);

/** Reasons that make `files` high risk whatever their size: dependencies, migrations, `review.paths`, sensitive zones. */
export function highRiskReasons(files: string[], rule: ReviewPolicy | undefined): string[] {
  const reasons: string[] = [];
  const pick = (test: (f: string) => boolean) => files.filter(test).slice(0, 3).join(", ");
  const deps = pick((f) => isManifest(f) || DEPENDENCIES.test(f));
  if (deps) reasons.push(`dependencies (${deps})`);
  const migrations = pick(isMigration);
  if (migrations) reasons.push(`migration (${migrations})`);
  const globs = (rule?.paths ?? []).map(globRegex);
  const matched = pick((f) => globs.some((g) => g.test(f)));
  if (matched) reasons.push(`review.paths (${matched})`);
  const sensitive = pick((f) => SENSITIVE.test(f));
  if (sensitive) reasons.push(`sensitive zone (${sensitive})`);
  return reasons;
}

export interface RiskAssessment {
  /** Whether a model review is requested: the policy applied to the level. */
  review: boolean;
  level: RiskLevel;
  reasons: string[];
}

/**
 * How risky the diff since the task's base commit is. The level is computed from the diff (`review.always`/`review.never` short-circuit it); a model review is only requested when
 * the manifest opts in: `review.always`, or `review.minLevel` "low" (above none) or "high". Default "off".
 * Cheap: git and regexes, no LLM. Doubt goes up a level, never down.
 */
export async function assessRisk(exec: Exec, root: string, task: Task | undefined, manifest: Manifest): Promise<RiskAssessment> {
  const rule = manifest.review;
  // `always` wins over `never`.
  if (rule?.always) return { review: true, level: "high", reasons: ["review.always"] };
  if (rule?.never) return { review: false, level: "none", reasons: ["review.never"] };

  const lines = new Map<string, number>();
  const removed = new Map<string, number>();
  // `-z` keeps odd names intact; `--no-renames` lists a rename as delete + add, so a moved lockfile or migration still shows.
  const numstat = await git(exec, root, ["diff", await diffBase(exec, root, task), "--numstat", "--no-renames", "-z"]);
  for (const row of (numstat ?? "").split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(row);
    if (!m) continue;
    lines.set(m[3], (m[1] === "-" ? 0 : +m[1]) + (m[2] === "-" ? 0 : +m[2]));
    if (m[2] !== "-" && +m[2] > 0) removed.set(m[3], +m[2]);
  }
  for (const file of await untrackedFiles(exec, root)) {
    const text = await fs.readFile(path.join(root, file), "utf8").catch(() => "");
    lines.set(file, text ? text.split("\n").length : 1);
  }
  const files = [...lines.keys()];
  const total = [...lines.values()].reduce((a, b) => a + b, 0);

  const reasons: string[] = [];
  let level: RiskLevel = "none";
  const raise = (to: RiskLevel, reason: string) => {
    reasons.push(reason);
    if (to === "high" || level === "none") level = to;
  };
  // Doubt goes up: an unreadable diff is not "no changes".
  if (numstat === undefined) raise("low", "git diff failed");
  const [maxLines, maxFiles] = [threshold(rule?.maxLines, MAX_LINES), threshold(rule?.maxFiles, MAX_FILES)];
  // `high` never sits below `low`.
  const [highLines, highFiles] = [Math.max(maxLines, threshold(rule?.highLines, HIGH_LINES)), Math.max(maxFiles, threshold(rule?.highFiles, HIGH_FILES))];
  if (total > maxLines) raise(total > highLines ? "high" : "low", `${total} lines changed`);
  if (files.length > maxFiles) raise(files.length > highFiles ? "high" : "low", `${files.length} files`);
  for (const reason of highRiskReasons(files, rule)) raise("high", reason);
  // Untracked and new files have no removed lines: only a test that existed before can have been weakened. Tests the approved plan names are meant to change.
  const planned = (f: string) => !!task?.plan && (inFiles(task.plan.files, f) || task.plan.seams.some((x) => x.testFile === f));
  const edited = [...removed.keys()].filter((f) => isTestFile(f) && !planned(f));
  if (edited.length) raise("low", `existing tests changed (${edited.slice(0, 3).join(", ")})`);
  if (!task?.plan) raise("low", "no plan");
  else if (task.plan.decisions.some((d) => d.status === "decided")) raise("low", "new user decisions");
  const final = level as RiskLevel; // `raise` assigns it in a closure, which narrowing does not see
  const review = rule?.minLevel === "low" ? final !== "none" : rule?.minLevel === "high" ? final === "high" : false;
  return { review, level: final, reasons };
}
