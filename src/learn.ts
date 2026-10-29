import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TASK_DONE_EVENT, type TaskDonePayload } from "./events.ts";
import { limitsOf } from "./config.ts";
import { changedFiles, diffBase, untrackedFiles, type Exec } from "./git.ts";
import { readManifest } from "./manifest.ts";
import { skillsBlock } from "./skills.ts";
import { MEMORY_PATH, inScope, oneLine, readMemory, type Task } from "./task-state.ts";
import { COVERAGE_PATH, coverageChanges } from "./verify-app.ts";
import { METRICS_DIR, loadMetrics, type TaskMetrics } from "./telemetry.ts";

// Stop words (Spanish and English, for tickets in either) dropped when matching a new task against past ones.
const STOP = new Set(
  "el la los las un una unos unas de del al y o u en con por para que se su sus es son fue como mas pero sin sobre este esta esto ese esa the a an of to in on for and or with is are be by at as it this that from not".split(" "),
);

interface TaskRecord {
  id: string;
  title: string;
  ticket?: string;
  date: string;
  /** The ticket restated by the planner. Absent in records saved before it existed. */
  intent?: string;
  summary: string;
  files: string[];
  decisions: { question: string; answer?: string; source?: string }[];
  keywords: string[];
  metrics?: TaskMetrics;
}

function tokenize(text: string): string[] {
  const words = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[^a-z0-9]+/);
  return words.filter((w) => w.length > 2 && !STOP.has(w));
}

async function changedSince(pi: ExtensionAPI, root: string, task: Task): Promise<string[]> {
  const exec = pi.exec.bind(pi);
  return [...new Set([...(await changedFiles(exec, root, await diffBase(exec, root, task))), ...(await untrackedFiles(exec, root))])];
}

async function buildRecord(pi: ExtensionAPI, root: string, task: Task): Promise<TaskRecord> {
  const plan = task.plan;
  // The working copy may also hold unrelated changes (setup output, other work): keep the task's own files.
  let files = (await changedSince(pi, root, task).catch(() => [])).filter((f) => inScope(task, f));
  if (!files.length) files = plan?.files ?? [];
  const decisions = (plan?.decisions ?? []).map((d) => ({ question: d.question, answer: d.answer, source: d.source }));
  const summary = plan?.summary ?? "";
  const text = [task.title, task.body, task.ticket, plan?.intent, summary, ...files, ...decisions.flatMap((d) => [d.question, d.answer])].join(" ");
  return {
    id: task.id,
    title: oneLine(task.title),
    ticket: task.ticket,
    date: (task.completedAt ?? new Date().toISOString()).slice(0, 10),
    ...(plan?.intent && { intent: plan.intent }),
    summary,
    files,
    decisions,
    keywords: [...new Set(tokenize(text))],
  };
}

function format(r: TaskRecord): string {
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
  const records: TaskRecord[] = await readMemory(root);
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

/** Only when code the verification skill covers changed since it was synced (or its sync commit is gone): what to tell the retro, and what to do about it. */
async function verifyAppNote(exec: Exec, root: string) {
  const changed = await coverageChanges(exec, root);
  if (!changed) return "";
  const refresh = `following pstack-maintain-verification-skill; when done, set sync in ${COVERAGE_PATH} to the output of \`git rev-parse HEAD\``;
  if (changed.unsynced) return `\nThe verification skill was set up before the first commit and was never synced. Ask the user through ask_user whether to check its coverage now, ${refresh}.`;
  if (changed.gone) return `\nThe verification skill's sync commit ${changed.sync} no longer exists in this repo (rebased or squashed), so what changed since cannot be listed. Ask the user through ask_user whether to refresh the skill's coverage now, ${refresh}.`;
  const lines = [...changed.commits.map((c) => `- ${c}`), ...(changed.dirty?.length ? ["Not committed yet:", ...changed.dirty.map((f) => `- ${f}`)] : [])];
  return `\nCode the verification skill covers changed since it was synced at ${changed.sync}:\n${lines.join("\n")}\nAsk the user through ask_user whether to update the verification skill now, ${refresh}.`;
}

async function retroPrompt(root: string, every: number, exec: Exec) {
  return `${await skillsBlock(root, "learn")}

Retro: ${every} tasks have been completed. Read the last ${every} records of ${MEMORY_PATH} (and ${METRICS_DIR}) and summarise: decisions that were missing from the plans, rules that repeated, verify failures by cause, and review findings.
Then PROPOSE edits to AGENTS.md, docs/adr or .pi/skills through ask_user options. Never write them without the user's approval.
Only messages from the user are corrections. Entries of type custom_message (contract-gate, verify-gate, verify-diagnose, diff-review, task-nudge) are pstack's automated checks, not the operator; report them as gate findings.${await verifyAppNote(exec, root)}`;
}

export function registerLearn(pi: ExtensionAPI) {
  pi.events?.on(TASK_DONE_EVENT, async (data) => {
    try {
      const { root, task, hasUI } = data as TaskDonePayload;
      const record = await buildRecord(pi, root, task);
      const metrics = await loadMetrics(root, task.id);
      if (metrics) record.metrics = metrics;
      const file = path.join(root, MEMORY_PATH);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, `${JSON.stringify(record)}\n`);
      const count = (await readMemory(root)).length;
      const every = limitsOf(await readManifest(root).catch(() => undefined)).retroEvery; // 0 turns the retro off
      if (hasUI && every > 0 && count % every === 0) pi.sendUserMessage(await retroPrompt(root, every, pi.exec.bind(pi)));
    } catch (error) {
      console.error("[memo] could not save the task:", error);
    }
  });
}
