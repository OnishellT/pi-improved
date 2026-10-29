import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isLaws } from "./bend.ts";
import { limitsOf } from "./config.ts";
import { diffBase, EMPTY_TREE, git, untrackedFiles, type Exec } from "./git.ts";
import { BREAK, collectDiffs, isDocs, isFixTask, isGenerated, qualityVerdict, weakenedNotes } from "./quality.ts";
import { MANIFEST_PATH, type Manifest } from "./manifest.ts";
import { inFiles, isLocalState, MEMORY_PATH, type Task } from "./task-state.ts";
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

const PACKAGE_MANAGER = /^(npm|pnpm|yarn|bun)$/;

/** Files the verify commands name (a script path or any word with a file name shape), and package.json when a command runs a package-manager script: changing them can turn verify green without fixing anything. A leading `cd <dir> &&` puts them under `dir`. Nothing else is parsed. */
export function verifyFiles(commands: string[]): string[] {
  const named = commands.flatMap((c) => {
    const [, dir = "", rest = c] = c.match(/^\s*cd\s+([^\s;&|]+)\s*&&(.*)$/s) ?? [];
    const words = rest.split(/[\s|;&<>()="']+/).filter(Boolean);
    const files = words.filter((w) => /[\w-]\.\w|\//.test(w) && !w.startsWith("-") && !w.endsWith("/"));
    if (words.some((w) => PACKAGE_MANAGER.test(w))) files.push("package.json");
    return files.map((w) => (dir && !w.startsWith("/") ? path.posix.join(dir, w) : w.replace(/^\.\//, "")));
  });
  return [...new Set(named)].filter((w) => w !== "." && !w.startsWith(".."));
}

export type RiskLevel = "none" | "low" | "high";
type ReviewPolicy = NonNullable<Manifest["review"]>;

/** The risk level from which a model review runs: `review.minLevel`, "high" when unset. */
export const minLevelOf = (rule: ReviewPolicy | undefined) => rule?.minLevel ?? "high";

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

/** The files pi-improved itself writes under `.pi/`. Any other `.pi/` file, `.pi/skills/**` included, is the project's and counts like any other. */
const isOwnState = (file: string) => isLocalState(file) || file === MANIFEST_PATH || file === MEMORY_PATH || file === ".pi/self-compact.json";

/** The files a `git diff --name-status -z` lists as modified or deleted, without pi-improved's own state. */
function nameStatus(out: string | undefined, added = false) {
  const parts = (out ?? "").split("\0");
  const files: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) if ((parts[i] === "M" || parts[i] === "D" || parts[i] === "T" || added) && !isOwnState(parts[i + 1])) files.push(parts[i + 1]);
  return files;
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
  /** Files that existed before the task, look like tests or are named by the verify commands, were changed or deleted and are not in the plan. The person should look at them. */
  touched?: string[];
  /** What the completion dialog lists next to `touched`: the quality reasons (a bug fix with no test, weakened tests, an oversize change) and which test files lost assertions or gained skip markers. */
  flagged?: string[];
}

/**
 * How risky the diff since the task's base commit is. The level is computed from the diff, under any policy; a model review is only requested when
 * the manifest asks for it: `review.always`, or `review.minLevel` "low" (above none) or "high" (the default). "off" never reviews.
 * Cheap: git and regexes, no LLM. Doubt goes up a level, never down.
 */
export async function assessRisk(exec: Exec, root: string, task: Task | undefined, manifest: Manifest): Promise<RiskAssessment> {
  const rule = manifest.review;
  const ref = await diffBase(exec, root, task);
  // Only a file that existed before the task (changed or deleted, `M`/`D`) can have been weakened to turn verify green. Files the approved plan names are meant to change.
  const planned = (f: string) => !!task?.plan && (inFiles(task.plan.files, f) || task.plan.seams.some((x) => x.testFile === f));
  const watched = new Set(verifyFiles(manifest.verify));
  // Without a base, nothing tells which files existed before the task: every test and verify file counts.
  const noBase = ref === EMPTY_TREE;
  const existing = nameStatus(await git(exec, root, ["diff", ref, "--name-status", "--no-renames", "-z"]), noBase);
  const touched = existing.filter((f) => (isTestFile(f) || watched.has(f)) && !planned(f));
  const lines = new Map<string, number>();
  // `-z` keeps odd names intact; `--no-renames` lists a rename as delete + add, so a moved lockfile or migration still shows.
  const numstat = await git(exec, root, ["diff", ref, "--numstat", "--no-renames", "-z"]);
  for (const row of (numstat ?? "").split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(row);
    if (!m || isOwnState(m[3])) continue;
    lines.set(m[3], (m[1] === "-" ? 0 : +m[1]) + (m[2] === "-" ? 0 : +m[2]));
  }
  for (const file of await untrackedFiles(exec, root)) {
    const text = await fs.readFile(path.join(root, file), "utf8").catch(() => "");
    // Like git, a final newline ends the last line; it does not start another.
    lines.set(file, text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 1);
  }
  const files = [...lines.keys()];
  const total = [...lines.values()].reduce((a, b) => a + b, 0);
  // Quality rules (quality.ts): facts from the diff and the task, one pure verdict. Each reason makes the change high risk, and the dialog lists it, whatever the review policy.
  const diffs = await collectDiffs(exec, root, ref);
  const weakened = weakenedNotes(diffs, isTestFile);
  const quality = qualityVerdict({
    fix: isFixTask(task),
    source: diffs.some((d) => !isTestFile(d.file) && !isDocs(d.file)),
    // A test that only lost lines (deleted, trimmed) does not test the fix.
    tests: diffs.some((d) => isTestFile(d.file) && d.added.some((l) => l !== BREAK && l.trim() !== "")),
    weakened: weakened.length > 0,
    lines: [...lines].reduce((n, [file, count]) => (isGenerated(file) ? n : n + count), 0),
    cap: limitsOf(manifest).changeCap,
    // The laws are the human's spec: a change to an existing LAWS.bend is the user's call, not the agent's (a new one is added, not `M`/`D`).
    extra: existing.filter(isLaws).slice(0, 3).map((f) => `laws changed (${f}): the user must review them`),
  });
  const flagged = [...quality.map((r) => r[0].toUpperCase() + r.slice(1)), ...weakened];
  const listed = { ...(touched.length && { touched }), ...(flagged.length && { flagged }) };

  const reasons: string[] = [];
  let level: RiskLevel = "none";
  const raise = (to: RiskLevel, reason: string) => {
    reasons.push(reason);
    if (to === "high" || level === "none") level = to;
  };
  // Doubt goes up: an unreadable diff is not "no changes".
  if (numstat === undefined) raise("low", "git diff failed");
  if (noBase && numstat !== undefined) raise("high", "no base: the task has no recorded start commit, so the whole tree counts as changed");
  const [maxLines, maxFiles] = [threshold(rule?.maxLines, MAX_LINES), threshold(rule?.maxFiles, MAX_FILES)];
  // `high` never sits below `low`.
  const [highLines, highFiles] = [Math.max(maxLines, threshold(rule?.highLines, HIGH_LINES)), Math.max(maxFiles, threshold(rule?.highFiles, HIGH_FILES))];
  if (total > maxLines) raise(total > highLines ? "high" : "low", `${total} lines changed`);
  if (files.length > maxFiles) raise(files.length > highFiles ? "high" : "low", `${files.length} files`);
  for (const reason of highRiskReasons(files, rule)) raise("high", reason);
  if (touched.length) raise("high", `tests or verify setup changed (${touched.slice(0, 3).join(", ")})`);
  if (!task?.plan) raise("low", "no plan");
  else if (task.plan.decisions.some((d) => d.status === "decided")) raise("low", "new user decisions");
  for (const reason of quality) raise("high", reason);
  const final = level as RiskLevel; // `raise` assigns it in a closure, which narrowing does not see
  const min = minLevelOf(rule);
  // `always` wins over `never`; either decides the review, not the level.
  const review = rule?.always ? true : rule?.never ? false : min === "low" ? final !== "none" : min === "high" ? final === "high" : false;
  return { review, level: final, reasons, ...listed };
}
