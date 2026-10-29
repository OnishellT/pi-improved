import { isPiState, type Task } from "./task-state.ts";

export type Exec = (command: string, args: string[], options: { cwd: string; timeout: number; signal?: AbortSignal }) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

const HASH = /^[0-9a-f]{7,64}$/;

export const isCommit = (text: string) => HASH.test(text);

/** stdout of `git args` in `root`, or undefined when the command fails, is killed or throws. */
export async function git(exec: Exec, root: string, args: string[]): Promise<string | undefined> {
  const r = await exec("git", args, { cwd: root, timeout: 30_000 }).catch(() => undefined);
  return r && r.code === 0 && !r.killed ? r.stdout : undefined;
}

const names = (out: string | undefined) => (out ?? "").split("\0").filter((f) => f && !isPiState(f));

/** Current HEAD commit, or undefined without git, repo or commit. */
export async function gitHead(exec: Exec, root: string): Promise<string | undefined> {
  const out = ((await git(exec, root, ["rev-parse", "--verify", "-q", "HEAD"])) ?? "").trim();
  return HASH.test(out) ? out : undefined;
}

/** The ref diffs are measured against: the task's `baseCommit` when it is a hash that still resolves, else `HEAD`. */
export async function diffBase(exec: Exec, root: string, task: Pick<Task, "baseCommit"> | undefined): Promise<string> {
  const base = task?.baseCommit;
  if (!base || !HASH.test(base)) return "HEAD";
  return ((await git(exec, root, ["rev-parse", "--verify", "-q", `${base}^{commit}`])) ?? "").trim() ? base : "HEAD";
}

/** Untracked, not-ignored files outside the `.pi/` state; empty when git fails. */
export const untrackedFiles = async (exec: Exec, root: string, paths: string[] = []) => names(await git(exec, root, ["ls-files", "--others", "--exclude-standard", "-z", ...(paths.length ? ["--", ...paths] : [])]));

/** Tracked files that differ from `base`, outside the `.pi/` state; empty when git fails. `paths` limits it to those pathspecs. */
export const changedFiles = async (exec: Exec, root: string, base: string, paths: string[] = []) => names(await git(exec, root, ["diff", "--name-only", "-z", base, ...(paths.length ? ["--", ...paths] : [])]));
