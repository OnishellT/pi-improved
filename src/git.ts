import * as fs from "node:fs/promises";
import * as path from "node:path";
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

export interface FileChange {
  file: string;
  status: "added" | "modified" | "deleted";
  /** Line counts; absent for a binary file, and for a new file that is unreadable, over 1 MiB or not a regular file. */
  added?: number;
  removed?: number;
  binary?: boolean;
}

/** Lines in a file's bytes the way git counts them: a final newline ends the last line, it does not start another. */
const lineCount = (bytes: Buffer) => {
  let n = 0;
  for (const b of bytes) if (b === 10) n++;
  return bytes.length && bytes[bytes.length - 1] !== 10 ? n + 1 : n;
};

/**
 * A file's bytes, read without following a symlink and without blocking on a FIFO: the opened file is the one checked, and at most
 * `limit` + 1 bytes are read, so nothing swapped in or grown meanwhile can stall the caller. Undefined when it cannot be opened or is
 * not a regular file. `whole` is false when it has more than `limit` bytes, or more than it had when checked; `bytes` is then the start.
 */
export async function readRegular(file: string, limit: number): Promise<{ bytes: Buffer; whole: boolean } | undefined> {
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  const handle = await fs.open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK).catch(() => undefined);
  if (!handle) return undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    const bytes = Buffer.alloc(Math.min(stat.size, limit) + 1);
    let size = 0;
    for (let n = 1; n && size < bytes.length; size += n) n = (await handle.read(bytes, size, bytes.length - size, size)).bytesRead;
    return { bytes: bytes.subarray(0, size), whole: size < bytes.length };
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Largest new file whose lines are counted; a bigger one, a symlink or anything else that is not a regular file shows without counts. */
const COUNT_LIMIT = 1 << 20;

/** +/- lines of a new untracked file, read with `readRegular`. */
export async function newFileCounts(file: string): Promise<Pick<FileChange, "added" | "removed" | "binary">> {
  const read = await readRegular(file, COUNT_LIMIT);
  if (!read) return {};
  // git's own test: a NUL byte in the first 8000 bytes makes the file binary.
  if (read.bytes.subarray(0, 8000).includes(0)) return { binary: true };
  // Not whole: more bytes than the limit, or than the file had when checked. No counts rather than wrong ones.
  return read.whole ? { added: lineCount(read.bytes), removed: 0 } : {};
}

/**
 * Every file that differs from `base`: tracked changes plus new untracked files, outside the `.pi/` state, sorted by path, each
 * with its status and +/- lines. Ignored files are left out, as in a commit. Undefined when git fails, so the caller can say the
 * list is missing rather than show an empty one.
 */
export async function fileChanges(exec: Exec, root: string, base: string): Promise<FileChange[] | undefined> {
  // `--no-renames` lists a rename as delete + add, so both paths show.
  const [status, numstat, untracked] = await Promise.all([
    git(exec, root, ["diff", "--name-status", "--no-renames", "-z", base]),
    git(exec, root, ["diff", "--numstat", "--no-renames", "-z", base]),
    git(exec, root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  if (status === undefined || numstat === undefined || untracked === undefined) return undefined;
  const byFile = new Map<string, FileChange>();
  const rows = status.split("\0");
  for (let i = 0; i + 1 < rows.length; i += 2) {
    const file = rows[i + 1];
    if (file && !isPiState(file)) byFile.set(file, { file, status: rows[i] === "A" ? "added" : rows[i] === "D" ? "deleted" : "modified" });
  }
  for (const row of numstat.split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(row);
    const change = m && byFile.get(m[3]);
    if (!change) continue;
    if (m[1] === "-") change.binary = true;
    else Object.assign(change, { added: +m[1], removed: +m[2] });
  }
  for (const file of names(untracked)) byFile.set(file, { file, status: "added", ...(await newFileCounts(path.join(root, file))) });
  return [...byFile.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
