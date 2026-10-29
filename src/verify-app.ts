import * as fs from "node:fs/promises";
import * as path from "node:path";
import { changedFiles, git, gitHead, isCommit, untrackedFiles, type Exec } from "./git.ts";
import { resolveInside } from "./task-state.ts";

export const VERIFY_APP = ".pi/skills/verify-app";
/** `{ "sync": "<commit>", "paths": ["src/", ...] }`: the commit the verification skill was last checked at and the code it covers. `"sync": ""` while the repo has no commit yet (or is no repo): the retro sets it once there is one. */
export const COVERAGE_PATH = `${VERIFY_APP}/features/coverage.json`;

const MAX_COMMITS = 10;
const MAX_SUBJECT = 100;
// The four H2s of a feature file (pstack-create-verification-skill).
const HEADINGS: [string, RegExp][] = [
  ["Sub-features", /^## Sub-features\s*$/m],
  ["How to get to it (user POV)", /^## How to get to it \(user POV\)\s*$/m],
  ["Driving it with <harness>", /^## Driving it with \S.*$/m],
  ["Gotchas", /^## Gotchas\s*$/m],
];

const read = (root: string, file: string) => fs.readFile(path.join(root, file), "utf8").catch(() => undefined);

export interface Coverage {
  sync: string;
  paths: string[];
}

/** The coverage record, or undefined when it is missing or not shaped as above. */
export async function readCoverage(root: string): Promise<Coverage | undefined> {
  try {
    const { sync, paths } = JSON.parse((await read(root, COVERAGE_PATH)) ?? "");
    const ok = typeof sync === "string" && (sync === "" || isCommit(sync)) && Array.isArray(paths) && paths.length > 0 && paths.every((p) => typeof p === "string" && p && !p.includes("\0"));
    return ok ? { sync, paths } : undefined;
  } catch {
    return undefined;
  }
}

const resolves = async (exec: Exec, root: string, sync: string) => (await git(exec, root, ["cat-file", "-e", `${sync}^{commit}`])) !== undefined;
const exists = (root: string, rel: string) => {
  const abs = resolveInside(root, rel);
  return abs ? fs.access(abs).then(() => true, () => false) : Promise.resolve(false);
};

/** What is missing from the verification skill: its SKILL.md, the feature map README, the four H2s of each feature file, and a coverage record whose commit exists and whose paths exist. */
export async function checkVerifyApp(root: string, exec: Exec): Promise<string[]> {
  const problems: string[] = [];
  if ((await read(root, `${VERIFY_APP}/SKILL.md`)) === undefined) problems.push(`${VERIFY_APP}/SKILL.md is missing (the verification skill).`);
  const dir = path.join(root, VERIFY_APP, "features");
  if ((await read(root, `${VERIFY_APP}/features/README.md`)) === undefined) problems.push(`${VERIFY_APP}/features/README.md is missing (the feature map index).`);
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
  for (const file of files) {
    const text = (await read(root, `${VERIFY_APP}/features/${file}`)) ?? "";
    const missing = HEADINGS.filter(([, re]) => !re.test(text)).map(([name]) => name);
    if (missing.length) problems.push(`${VERIFY_APP}/features/${file} needs these H2 headings: ${missing.join("; ")}.`);
  }
  const coverage = await readCoverage(root);
  if (!coverage) problems.push(`${COVERAGE_PATH} must be {"sync": "<output of git rev-parse HEAD>", "paths": ["<code path the skill covers>", ...]}. While the repo has no commit yet, use "sync": "".`);
  else {
    if (coverage.sync === "") {
      if (await gitHead(exec, root)) problems.push(`${COVERAGE_PATH}: sync is empty but the repo has a commit now. Set it to the output of \`git rev-parse HEAD\`.`);
    } else if (!(await resolves(exec, root, coverage.sync))) problems.push(`${COVERAGE_PATH}: sync ${coverage.sync} is not a commit of this repo. Set it to the output of \`git rev-parse HEAD\`.`);
    const gone = (await Promise.all(coverage.paths.map(async (p) => ((await exists(root, p)) ? undefined : p)))).filter(Boolean);
    if (gone.length) problems.push(`${COVERAGE_PATH}: these paths do not exist: ${gone.join(", ")}.`);
  }
  return problems;
}

/** Commits since the verification skill was synced that touched the code it covers, newest first, plus covered files changed but not committed yet (a task's own work is still uncommitted when its retro runs); undefined when none, or when there is no usable record or git. `gone`: the sync commit no longer exists, so nothing can be listed. */
export async function coverageChanges(exec: Exec, root: string): Promise<{ sync: string; commits: string[]; dirty?: string[]; gone?: boolean; unsynced?: boolean } | undefined> {
  const coverage = await readCoverage(root);
  if (!coverage) return undefined;
  // Set up before the first commit: once there is one, the skill still has to be synced to it.
  if (!coverage.sync) return (await gitHead(exec, root)) ? { sync: "", commits: [], unsynced: true } : undefined;
  if (!(await resolves(exec, root, coverage.sync))) return { sync: coverage.sync, commits: [], gone: true };
  const out = await git(exec, root, ["log", "--format=%h %s", `${coverage.sync}..HEAD`, "--", ...coverage.paths]);
  const commits = (out ?? "").split("\n").filter(Boolean);
  const dirty = [...new Set([...(await changedFiles(exec, root, "HEAD", coverage.paths)), ...(await untrackedFiles(exec, root, coverage.paths))])];
  if (!commits.length && !dirty.length) return undefined;
  const shown = commits.slice(0, MAX_COMMITS).map((c) => c.slice(0, MAX_SUBJECT));
  return {
    sync: coverage.sync,
    commits: commits.length > shown.length ? [...shown, `…and ${commits.length - shown.length} more`] : shown,
    ...(dirty.length && { dirty: dirty.length > MAX_COMMITS ? [...dirty.slice(0, MAX_COMMITS), `…and ${dirty.length - MAX_COMMITS} more`] : dirty }),
  };
}
