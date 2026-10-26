import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Manifest } from "./manifest.ts";
import type { Task } from "./task-state.ts";
import { isManifest, isMigration } from "./triggers.ts";
import type { Exec } from "./verify.ts";

// Defaults of the size thresholds; `review.maxLines/maxFiles/highLines/highFiles` override them.
const MAX_LINES = 200;
const MAX_FILES = 6;
const HIGH_LINES = 600;
const HIGH_FILES = 15;
const HASH = /^[0-9a-f]{7,64}$/;
const DEPENDENCIES = /(^|\/)(pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|package-lock\.json|Gemfile(\.lock)?)$/;
const SENSITIVE = /(^|\/)(auth\w*|payments?|billing|security|crypto\w*|migrations?|infra(structure)?)\//i;

export type RiskLevel = "none" | "low" | "high";
type ReviewPolicy = NonNullable<Manifest["review"]>;

const globRegex = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/|\*\*/g, (m) => (m.endsWith("/") ? "\u0000" : "\u0001")).replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?").replace(/\u0001/g, ".*")}$`);

const git = async (exec: Exec, root: string, args: string[]) => (await exec("git", args, { cwd: root, timeout: 30_000 }).catch(() => undefined))?.stdout ?? "";

/** Current HEAD commit, or undefined without git, repo or commit. */
export async function gitHead(exec: Exec, root: string): Promise<string | undefined> {
  const out = (await git(exec, root, ["rev-parse", "--verify", "-q", "HEAD"])).trim();
  return HASH.test(out) ? out : undefined;
}

/** The ref diffs are measured against: the task's `baseCommit` when it is a hash that still resolves, else `HEAD`. */
export async function diffBase(exec: Exec, root: string, task: Pick<Task, "baseCommit"> | undefined): Promise<string> {
  const base = task?.baseCommit;
  if (!base || !HASH.test(base)) return "HEAD";
  return (await git(exec, root, ["rev-parse", "--verify", "-q", `${base}^{commit}`])).trim() ? base : "HEAD";
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
 * How risky the diff since the task's base commit is. The level is always computed; a model review is only requested when
 * the manifest opts in: `review.always`, or `review.minLevel` "low" (above none) or "high". Default "off".
 * Cheap: git and regexes, no LLM. Doubt goes up a level, never down.
 */
export async function assessRisk(exec: Exec, root: string, task: Task | undefined, manifest: Manifest): Promise<RiskAssessment> {
  const rule = manifest.review;
  // `always` wins over `never`.
  if (rule?.always) return { review: true, level: "high", reasons: ["review.always"] };
  if (rule?.never) return { review: false, level: "none", reasons: ["review.never"] };

  const lines = new Map<string, number>();
  for (const row of (await git(exec, root, ["diff", await diffBase(exec, root, task), "--numstat"])).split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(row);
    if (m) lines.set(m[3], (m[1] === "-" ? 0 : +m[1]) + (m[2] === "-" ? 0 : +m[2]));
  }
  for (const file of (await git(exec, root, ["ls-files", "--others", "--exclude-standard"])).split("\n")) {
    if (!file || file.startsWith(".pi/")) continue;
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
  const [maxLines, maxFiles] = [threshold(rule?.maxLines, MAX_LINES), threshold(rule?.maxFiles, MAX_FILES)];
  // `high` never sits below `low`.
  const [highLines, highFiles] = [Math.max(maxLines, threshold(rule?.highLines, HIGH_LINES)), Math.max(maxFiles, threshold(rule?.highFiles, HIGH_FILES))];
  if (total > maxLines) raise(total > highLines ? "high" : "low", `${total} lines changed`);
  if (files.length > maxFiles) raise(files.length > highFiles ? "high" : "low", `${files.length} files`);
  for (const reason of highRiskReasons(files, rule)) raise("high", reason);
  if (!task?.plan) raise("low", "no plan");
  else if (task.plan.decisions.some((d) => d.status === "decided")) raise("low", "new user decisions");
  const final = level as RiskLevel; // `raise` assigns it in a closure, which narrowing does not see
  const review = rule?.minLevel === "low" ? final !== "none" : rule?.minLevel === "high" ? final === "high" : false;
  return { review, level: final, reasons };
}
