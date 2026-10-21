import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inScope, type Task } from "./task-state.ts";

/** Event emitted by the gate when the user confirms a task is finished. */
export const TASK_DONE_EVENT = "pi-improved:task-done";
export interface TaskDonePayload {
  root: string;
  task: Task;
}

const MEMORY_PATH = ".pi/memory/tasks.jsonl";
const STOP = new Set(
  "el la los las un una unos unas de del al y o u en con por para que se su sus es son fue como mas pero sin sobre este esta esto ese esa the a an of to in on for and or with is are be by at as it this that from not".split(" "),
);

interface Record {
  id: string;
  title: string;
  ticket?: string;
  date: string;
  summary: string;
  files: string[];
  decisions: { question: string; answer?: string; source?: string }[];
  keywords: string[];
}

function tokenize(text: string): string[] {
  const words = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[^a-z0-9]+/);
  return words.filter((w) => w.length > 2 && !STOP.has(w));
}

async function changedFiles(pi: ExtensionAPI, root: string): Promise<string[]> {
  const files = new Set<string>();
  const diff = await pi.exec("git", ["-C", root, "diff", "--name-only", "HEAD"]);
  if (diff.code === 0) for (const line of diff.stdout.split("\n")) if (line.trim()) files.add(line.trim());
  const status = await pi.exec("git", ["-C", root, "status", "--porcelain"]);
  if (status.code === 0) for (const line of status.stdout.split("\n")) if (line.startsWith("??")) files.add(line.slice(3).trim());
  return [...files].filter((f) => !f.startsWith(".pi/"));
}

async function buildRecord(pi: ExtensionAPI, root: string, task: Task): Promise<Record> {
  const plan = task.plan;
  // The working copy may also hold unrelated changes (setup output, other work): keep the task's own files.
  let files = (await changedFiles(pi, root).catch(() => [])).filter((f) => inScope(task, f));
  if (!files.length) files = plan?.files ?? [];
  const decisions = (plan?.decisions ?? []).map((d) => ({ question: d.question, answer: d.answer, source: d.source }));
  const summary = plan?.summary ?? "";
  const text = [task.title, task.ticket, summary, ...files, ...decisions.flatMap((d) => [d.question, d.answer])].join(" ");
  return {
    id: task.id,
    title: task.title,
    ticket: task.ticket,
    date: (task.completedAt ?? new Date().toISOString()).slice(0, 10),
    summary,
    files,
    decisions,
    keywords: [...new Set(tokenize(text))],
  };
}

async function readRecords(root: string): Promise<Record[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(root, MEMORY_PATH), "utf8");
  } catch {
    return [];
  }
  const out: Record[] = [];
  for (const line of raw.split("\n")) {
    try {
      if (line.trim()) out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

function format(r: Record): string {
  const head = `[${r.ticket ?? r.id}] ${r.title} (${r.date})`;
  const parts = [r.summary ? `${head}: ${r.summary}.` : `${head}.`];
  if (r.files.length) parts.push(`Files: ${r.files.slice(0, 5).join(", ")}.`);
  const decisions = r.decisions.filter((d) => d.answer).map((d) => `${d.question} → ${d.answer}`);
  if (decisions.length) parts.push(`Decisions: ${decisions.slice(0, 3).join("; ")}`);
  const text = parts.join(" ").replace(/\.\.$/, ".");
  return text.length > 400 ? `${text.slice(0, 397)}...` : text;
}

/** Compact summaries of past tasks most related to `query`, best first. */
export async function relatedTasks(root: string, query: string, limit = 3): Promise<string[]> {
  const records = await readRecords(root);
  const terms = new Set(tokenize(query));
  if (!records.length || !terms.size) return [];
  const docs = records.map((r) => new Set(r.keywords ?? tokenize(`${r.title} ${r.summary}`)));
  const idf = (t: string) => Math.log(1 + records.length / (1 + docs.filter((d) => d.has(t)).length));
  return records
    .map((r, i) => ({ r, i, score: [...terms].reduce((s, t) => s + (docs[i].has(t) ? idf(t) : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .slice(0, limit)
    .map((x) => format(x.r));
}

export function registerLearn(pi: ExtensionAPI) {
  pi.events?.on(TASK_DONE_EVENT, async (data) => {
    try {
      const { root, task } = data as TaskDonePayload;
      const record = await buildRecord(pi, root, task);
      const file = path.join(root, MEMORY_PATH);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, `${JSON.stringify(record)}\n`);
    } catch (error) {
      console.error("[memo] no se pudo guardar la tarea:", error);
    }
  });
}
