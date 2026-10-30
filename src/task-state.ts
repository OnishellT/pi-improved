import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeFileAtomicAsync } from "./config.ts";

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
  /** The ticket restated in the planner's own words, one short paragraph. Absent in plans saved before it existed. */
  intent?: string;
  summary: string;
  steps: string[];
  /** Repo-relative files the task may create or change. */
  files: string[];
  decisions: Decision[];
  /** Names the implementation must expose, pinned before any code is written. */
  interface: { file: string; exports: string[]; signatures?: string[]; source?: string; usage?: string }[];
  /** Where the tests attach: what each catches and what it leaves uncovered. */
  seams: { name: string; testFile: string; catches: string; misses?: string }[];
}

/** The active task, local to the working copy at `.pi/task.json` (not committed). */
export interface Task {
  id: string;
  /** One line: the request's first line, cut. A longer request (a pasted ticket) is kept whole in `body`. */
  title: string;
  /** The full /task request when it was more than the title. */
  body?: string;
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
  /** The model in use before /task switched to the implement one: put back when the task ends. */
  model?: string;
  startedAt: string;
  completedAt?: string;
}

/** The first non-empty line of `text` without markdown heading/quote marks, cut to `max` characters: for dialog titles, PR titles and commit subjects. */
export const oneLine = (text: string, max = 72) => {
  const first = text.split("\n").map((l) => l.replace(/^[\s#>]+/, "").trim()).find(Boolean) ?? "";
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
};

export const TASK_PATH = ".pi/task.json";
export const MEMORY_PATH = ".pi/memory/tasks.jsonl";

/** Anything under `.pi/` is workflow state, not the task's own work: reviews and risk look past all of it. */
export const isPiState = (file: string) => file.startsWith(".pi/");

/**
 * The part of `.pi/` that stays on this machine: /setup puts it in `.gitignore`, /pr leaves it out of the commit.
 * Everything else under `.pi/` (workflow.json, memory/tasks.jsonl, skills/) is versioned project state.
 * An entry ending in `/` is a folder. Its owner (telemetry.ts) defines the same string; a test keeps them in step.
 * `.pi/contract.json` is legacy: nothing writes it any more, but a stale tracked or staged copy must never reach a PR.
 */
export const LOCAL_STATE = [TASK_PATH, ".pi/contract.json", ".pi/metrics/", ".pi/evidence/"];
export const isLocalState = (file: string) => LOCAL_STATE.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));

/** Records of finished tasks (JSONL); lines that do not parse are skipped. */
export async function readMemory(root: string): Promise<any[]> {
  const raw = await fs.readFile(path.join(root, MEMORY_PATH), "utf8").catch(() => "");
  const out: any[] = [];
  for (const line of raw.split("\n")) {
    try {
      if (line.trim()) out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

export async function readTask(root: string): Promise<Task | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(root, TASK_PATH), "utf8"));
  } catch (error: any) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`${TASK_PATH} ${error.code ? "cannot be read" : "is not valid JSON"}: ${error.message}`);
  }
}

export async function writeTask(root: string, task: Task | undefined) {
  const file = path.join(root, TASK_PATH);
  if (!task) return fs.rm(file, { force: true });
  // Temp file + rename: a crash mid-write never leaves a truncated task that blocks /task.
  await writeFileAtomicAsync(file, `${JSON.stringify(task, null, 2)}\n`);
}

export async function updateTask(root: string, change: (task: Task) => void): Promise<Task> {
  const task = await readTask(root);
  if (!task) throw new Error("No active task. Start one with /task.");
  change(task);
  await writeTask(root, task);
  return task;
}

/** True when `file` is listed in `files`. Entries ending in `/` cover a directory. */
export const inFiles = (files: string[], file: string) => files.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));

/** True when `file` is in the plan or was allowed later. */
export const inScope = (task: Task, file: string) => inFiles([...(task.plan?.files ?? []), ...task.allowedExtra], file);

/** `rel` resolved against `root`, or undefined when it escapes the project (model-written paths are never trusted). */
export function resolveInside(root: string, rel: string): string | undefined {
  const abs = path.resolve(root, rel);
  const from = path.relative(path.resolve(root), abs);
  return from === ".." || from.startsWith(`..${path.sep}`) || path.isAbsolute(from) ? undefined : abs;
}
