import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Manifest } from "./manifest.ts";
import type { Task } from "./task-state.ts";
import { isManifest, isMigration } from "./triggers.ts";
import type { Exec } from "./verify.ts";

const MAX_LINES = 200;
const MAX_FILES = 6;
const DEPENDENCIES = /(^|\/)(pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|package-lock\.json|Gemfile(\.lock)?)$/;
const SENSITIVE = /(^|\/)(auth\w*|payments?|billing|security|crypto\w*|migrations?|infra(structure)?)\//i;

const globRegex = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/|\*\*/g, (m) => (m.endsWith("/") ? "\u0000" : "\u0001")).replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?").replace(/\u0001/g, ".*")}$`);

/** Whether the diff needs the paid strong-model review. Cheap: git and regexes, no LLM. */
export async function assessRisk(exec: Exec, root: string, task: Task | undefined, manifest: Manifest): Promise<{ review: boolean; reasons: string[] }> {
  const rule = manifest.review;
  if (rule?.never) return { review: false, reasons: ["review.never"] };
  if (rule?.always) return { review: true, reasons: ["review.always"] };

  const git = async (args: string[]) => (await exec("git", args, { cwd: root, timeout: 30_000 }).catch(() => undefined))?.stdout ?? "";
  const lines = new Map<string, number>();
  for (const row of (await git(["diff", "HEAD", "--numstat"])).split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(row);
    if (m) lines.set(m[3], (m[1] === "-" ? 0 : +m[1]) + (m[2] === "-" ? 0 : +m[2]));
  }
  for (const file of (await git(["ls-files", "--others", "--exclude-standard"])).split("\n")) {
    if (!file || file === ".pi/task.json" || file.startsWith(".pi/")) continue;
    const text = await fs.readFile(path.join(root, file), "utf8").catch(() => "");
    lines.set(file, text ? text.split("\n").length : 1);
  }
  const files = [...lines.keys()];
  const total = [...lines.values()].reduce((a, b) => a + b, 0);

  const reasons: string[] = [];
  if (total > MAX_LINES) reasons.push(`${total} lines changed`);
  if (files.length > MAX_FILES) reasons.push(`${files.length} files`);
  const pick = (test: (f: string) => boolean) => files.filter(test).slice(0, 3).join(", ");
  const deps = pick((f) => isManifest(f) || DEPENDENCIES.test(f));
  if (deps) reasons.push(`dependencias (${deps})`);
  const migrations = pick(isMigration);
  if (migrations) reasons.push(`migration (${migrations})`);
  const globs = (rule?.paths ?? []).map(globRegex);
  const matched = pick((f) => globs.some((g) => g.test(f)));
  if (matched) reasons.push(`review.paths (${matched})`);
  const sensitive = pick((f) => SENSITIVE.test(f));
  if (sensitive) reasons.push(`zona sensible (${sensitive})`);
  if (!task?.plan) reasons.push("no plan");
  else if (task.plan.decisions.some((d) => d.status === "decided")) reasons.push("new user decisions");
  return { review: reasons.length > 0, reasons };
}
