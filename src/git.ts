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

/** Git's empty tree: a diff against it counts every file as changed. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The ref a task's diffs are measured against: its `baseCommit` when that is a hash that still resolves, else the last commit
 * before the task started, else no base at all: the empty tree, so the whole tree counts as the task's change. Never HEAD for
 * a task, since commits made during it would drop out of the diff. Without a task, HEAD.
 */
export async function diffBase(exec: Exec, root: string, task: Partial<Pick<Task, "baseCommit" | "startedAt">> | undefined): Promise<string> {
  if (!task) return "HEAD";
  const base = task.baseCommit;
  if (base && HASH.test(base) && ((await git(exec, root, ["rev-parse", "--verify", "-q", `${base}^{commit}`])) ?? "").trim()) return base;
  const started = Date.parse(task.startedAt ?? "");
  const before = Number.isNaN(started) ? "" : ((await git(exec, root, ["rev-list", "-1", `--before=${new Date(started).toISOString()}`, "HEAD"])) ?? "").trim();
  return HASH.test(before) ? before : EMPTY_TREE;
}

/** Untracked, not-ignored files outside the `.pi/` state; empty when git fails. */
export const untrackedFiles = async (exec: Exec, root: string, paths: string[] = []) => names(await git(exec, root, ["ls-files", "--others", "--exclude-standard", "-z", ...(paths.length ? ["--", ...paths] : [])]));

/** Tracked files that differ from `base`, outside the `.pi/` state; empty when git fails. `paths` limits it to those pathspecs. */
export const changedFiles = async (exec: Exec, root: string, base: string, paths: string[] = []) => names(await git(exec, root, ["diff", "--name-only", "-z", base, ...(paths.length ? ["--", ...paths] : [])]));
