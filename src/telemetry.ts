import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ESCALATE_EVENT, REVIEW_EVENT, VERIFY_EVENT, type EscalatePayload, type ReviewPayload, type VerifyPayload } from "./events.ts";
import { readMemory, readTask } from "./task-state.ts";

export interface TaskMetrics {
  phases: Record<string, { input: number; output: number; cacheRead: number; cost: number; seconds: number }>;
  verifyRuns: number;
  verifyFailures: number;
  /** Failures that came back and got the premise lines. */
  premises: number;
  /** The progress checks while implementing. */
  progress: { runs: number; failures: number };
  reviews: { status: string; model: string; seconds: number; cost?: number; discarded?: boolean }[];
  escalations: number;
  /** The teach-back at the end of the task; absent when the task was closed with /task done before it. */
  understanding?: { outcome: UnderstandingOutcome; gaps: number };
}

export const METRICS_DIR = ".pi/metrics/";
const metrics = new Map<string, TaskMetrics>();

const empty = (): TaskMetrics => ({ phases: {}, verifyRuns: 0, verifyFailures: 0, premises: 0, progress: { runs: 0, failures: 0 }, reviews: [], escalations: 0 });
const snapshotPath = (root: string, id: string) => path.join(root, METRICS_DIR, `${id.replace(/[^\w.-]/g, "_")}.json`);

/** Metrics collected in memory for the task, or undefined when none were recorded or loaded. */
export function taskMetrics(taskId: string): TaskMetrics | undefined {
  return metrics.get(taskId);
}

/** Memory first, else the snapshot persisted under `.pi/metrics/` (survives a pi restart). */
export async function loadMetrics(root: string, taskId: string): Promise<TaskMetrics | undefined> {
  const known = metrics.get(taskId);
  if (known) return known;
  try {
    const loaded = { ...empty(), ...JSON.parse(await fs.readFile(snapshotPath(root, taskId), "utf8")) } as TaskMetrics;
    metrics.set(taskId, loaded);
    return loaded;
  } catch {
    return undefined;
  }
}

async function save(root: string, id: string, data: TaskMetrics) {
  metrics.set(id, data);
  try {
    const file = snapshotPath(root, id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Temp file + rename in the same directory: overlapping saves never leave a truncated snapshot.
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, file);
  } catch {}
}

/** done: the user answered the teach-back; skipped: they declined it; no-ui: nobody could answer; off: `understanding` is "off". */
export type UnderstandingOutcome = "done" | "skipped" | "no-ui" | "off";

/** Keeps the active task's understanding outcome and its number of gaps. Awaited before the task is completed, so the memory record has it. */
export async function recordUnderstanding(root: string, outcome: UnderstandingOutcome, gaps: number) {
  const task = await readTask(root).catch(() => undefined);
  if (!task || task.status === "done") return;
  const data = (await loadMetrics(root, task.id)) ?? empty();
  data.understanding = { outcome, gaps };
  await save(root, task.id, data);
}

/** How the last tasks' understanding checks ended, as rates, and the gaps per answered check; nothing when none was recorded. */
function understandingLine(records: any[]): string[] {
  const checks: { outcome: string; gaps: number }[] = records.map((r) => r.metrics.understanding).filter(Boolean);
  if (!checks.length) return [];
  const rate = (outcome: string) => `${outcome} ${Math.round((checks.filter((c) => c.outcome === outcome).length / checks.length) * 100)}%`;
  const done = checks.filter((c) => c.outcome === "done");
  const gaps = done.length ? `, ${(done.reduce((s, c) => s + c.gaps, 0) / done.length).toFixed(1)} gaps per answered check` : "";
  return [`Understanding (${checks.length} tasks): ${["done", "skipped", "no-ui", "off"].map(rate).join(", ")}${gaps}`];
}

export async function metricsReport(root: string): Promise<string> {
  const records = (await readMemory(root)).filter((r) => r.metrics);
  if (!records.length) return "No metrics yet: they are saved when each task ends.";
  const rows = records.slice(-10).map((r) => {
    const phases = Object.values<any>(r.metrics.phases ?? {});
    const sum = (k: string) => phases.reduce((s, p) => s + (p[k] ?? 0), 0);
    const reviews: any[] = r.metrics.reviews ?? [];
    // Plan checks are not diff reviews: the verdict column leaves them out; their cost still counts.
    const verdicts = reviews.filter((x) => !String(x.status).startsWith("plan-")).map((x) => (x.status === "skipped-low-risk" || x.status === "not-requested" ? "·" : x.discarded ? `(${x.status})` : x.status)).join(",") || "-";
    const reviewCost = reviews.reduce((s, x) => s + (x.cost ?? 0), 0);
    return { id: String(r.ticket ?? r.id), cost: sum("cost") + reviewCost, tokens: sum("input") + sum("output"), seconds: sum("seconds"), fails: r.metrics.verifyFailures ?? 0, verdicts };
  });
  const lines = rows.map((r) => `${r.id.padEnd(14)} $${r.cost.toFixed(3).padStart(7)} ${String(r.tokens).padStart(9)} tok ${String(Math.round(r.seconds)).padStart(6)} s  verify✗ ${r.fails}  review: ${r.verdicts}`);
  const avg = rows.reduce((s, r) => s + r.cost, 0) / rows.length;
  const all: any[] = records.flatMap((r) => r.metrics.reviews ?? []);
  const paid = all.filter((x) => x.status !== "skipped-low-risk" && x.status !== "not-requested" && !String(x.status).startsWith("plan-") && x.cost !== undefined);
  const avoided = all.filter((x) => x.status === "skipped-low-risk").length;
  const mean = paid.length ? paid.reduce((s, x) => s + x.cost, 0) / paid.length : 0;
  return [`Last ${rows.length} tasks (id, cost, tokens in+out, seconds, verify failures, reviews):`, ...lines, `Mean cost per task: $${avg.toFixed(3)}`, `Reviews avoided: ${avoided} (≈ $${(avoided * mean).toFixed(2)} saved)`, ...understandingLine(records.slice(-10))].join("\n");
}

/** The active task's phase, cost and tokens per phase, and the last risk verdict, from the persisted metrics. */
export async function costReport(root: string): Promise<string> {
  const task = await readTask(root).catch(() => undefined);
  if (!task || task.status === "done") return "No active task. /metrics shows the latest finished ones.";
  const data = await loadMetrics(root, task.id);
  if (!data) return `${task.id}: ${task.status}, nothing recorded yet.`;
  const rows = Object.entries(data.phases).map(([name, p]) => `  ${name.padEnd(13)} $${p.cost.toFixed(3).padStart(7)} ${String(p.input + p.output).padStart(9)} tok (${p.cacheRead} cached) ${String(Math.round(p.seconds)).padStart(5)} s`);
  const reviewCost = data.reviews.reduce((s, r) => s + (r.cost ?? 0), 0);
  const total = Object.values(data.phases).reduce((s, p) => s + p.cost, 0) + reviewCost;
  const verdict = [...data.reviews].reverse().find((r) => !r.status.startsWith("plan-"));
  const risk = !verdict ? "not assessed yet" : verdict.status === "skipped-low-risk" ? "low (review skipped)" : verdict.status === "not-requested" ? "review not requested (review.minLevel)" : `review ${verdict.status}`;
  return [`${task.id}: phase ${task.status}`, ...rows, `  review        $${reviewCost.toFixed(3).padStart(7)}`, `Total $${total.toFixed(3)} | last risk: ${risk} | verify runs ${data.verifyRuns} (${data.verifyFailures} failed)`].join("\n");
}

/**
 * Seconds are wall-clock deltas between consecutive message_end events (the first one counts from
 * agent_start), charged to the task phase current at that moment.
 */
export function registerTelemetry(pi: ExtensionAPI) {
  const last = new Map<string, number>();

  async function active(root: string) {
    const task = await readTask(root).catch(() => undefined);
    if (!task || task.status === "done") return undefined;
    return { id: task.id, status: task.status, data: (await loadMetrics(root, task.id)) ?? empty() };
  }
  async function bump(root: string, change: (m: TaskMetrics) => void) {
    const t = await active(root);
    if (!t) return;
    change(t.data);
    await save(root, t.id, t.data);
  }

  pi.on("agent_start", (_e, ctx) => void last.set(ctx.cwd, Date.now()));
  pi.on("message_end", async (event, ctx) => {
    const now = Date.now();
    const seconds = (now - (last.get(ctx.cwd) ?? now)) / 1000;
    last.set(ctx.cwd, now);
    const message: any = event.message;
    const t = await active(ctx.cwd);
    if (!t) return;
    const phase = (t.data.phases[t.status] ??= { input: 0, output: 0, cacheRead: 0, cost: 0, seconds: 0 });
    phase.seconds += seconds;
    if (message.role === "assistant" && message.usage) {
      phase.input += message.usage.input ?? 0;
      phase.output += message.usage.output ?? 0;
      phase.cacheRead += message.usage.cacheRead ?? 0;
      phase.cost += message.usage.cost?.total ?? 0;
    }
    await save(ctx.cwd, t.id, t.data);
  });

  pi.events?.on(VERIFY_EVENT, (d) => {
    const { root, kind, ok, premise } = d as VerifyPayload;
    return bump(root, (m) => {
      if (kind === "progress") {
        m.progress.runs++;
        if (!ok) m.progress.failures++;
      } else {
        m.verifyRuns++;
        if (!ok) m.verifyFailures++;
        if (premise) m.premises++;
      }
    });
  });
  pi.events?.on(REVIEW_EVENT, (d) => {
    const { root, status, model, seconds, cost, discarded } = d as ReviewPayload;
    return bump(root, (m) => void m.reviews.push({ status, model, seconds, ...(cost !== undefined && { cost }), ...(discarded && { discarded }) }));
  });
  pi.events?.on(ESCALATE_EVENT, (d) => bump((d as EscalatePayload).root, (m) => void m.escalations++));

  pi.registerCommand("cost", {
    description: "Phase, cost and tokens of the active task, and its last risk level",
    handler: async (_args, ctx) => ctx.ui.notify(await costReport(ctx.cwd), "info"),
  });
  pi.registerCommand("metrics", {
    description: "Cost, tokens and time of the latest tasks",
    handler: async (_args, ctx) => ctx.ui.notify(await metricsReport(ctx.cwd), "info"),
  });
}
