import * as fs from "node:fs/promises";
import * as path from "node:path";

export type TaskStatus = "planning" | "implementing" | "done";

export interface Decision {
  id: string;
  question: string;
  options: string[];
  /** documented: already covered by `source`; decided: the user answered and an ADR was written. */
  status: "documented" | "decided";
  source?: string;
  answer?: string;
}

export interface Plan {
  summary: string;
  steps: string[];
  /** Repo-relative files the task may create or change. */
  files: string[];
  decisions: Decision[];
  /** Names the implementation must expose, pinned before any code is written. */
  interface: { file: string; exports: string[]; signatures?: string[]; source?: string }[];
  /** Where the tests attach: what each catches and what it leaves uncovered. */
  seams: { name: string; testFile: string; catches: string; misses?: string }[];
}

/** The active task, local to the working copy at `.pi/task.json` (not committed). */
export interface Task {
  id: string;
  title: string;
  ticket?: string;
  status: TaskStatus;
  plan?: Plan;
  /** Files outside the plan the user allowed during implementation. */
  allowedExtra: string[];
  /** Spec files named in the /task request: their text counts as ticket evidence for interface names. */
  spec?: string[];
  /** Strong-model plan spot checks already spent on this task (bounded to keep the cost flat). */
  planChecks?: number;
  /** HEAD when the task entered implementing: risk and review measure the diff against it. */
  baseCommit?: string;
  startedAt: string;
  completedAt?: string;
}

export const TASK_PATH = ".pi/task.json";

export async function readTask(root: string): Promise<Task | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(root, TASK_PATH), "utf8"));
  } catch (error: any) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`${TASK_PATH} is not valid JSON: ${error.message}`);
  }
}

export async function writeTask(root: string, task: Task | undefined) {
  const file = path.join(root, TASK_PATH);
  if (!task) return fs.rm(file, { force: true });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(task, null, 2)}\n`);
}

export async function updateTask(root: string, change: (task: Task) => void): Promise<Task> {
  const task = await readTask(root);
  if (!task) throw new Error("No active task. Start one with /task.");
  change(task);
  await writeTask(root, task);
  return task;
}

/** True when `file` is in the plan or was allowed later. Plan entries ending in `/` cover a directory. */
export function inScope(task: Task, file: string) {
  const allowed = [...(task.plan?.files ?? []), ...task.allowedExtra];
  return allowed.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));
}
