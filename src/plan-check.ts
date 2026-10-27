import * as fs from "node:fs/promises";
import * as path from "node:path";
import { planText } from "./task-prompt.ts";
import { runSubagent } from "./review.ts";
import { resolveInside, type Plan, type Task } from "./task-state.ts";
import type { Exec } from "./git.ts";

export type PlanCheckStatus = "ok" | "fix" | "skipped";
export interface PlanCheckResult {
  status: PlanCheckStatus;
  report: string;
  cost?: number;
}

const MAX_EVIDENCE = 20_000;
const MAX_SIBLINGS = 40;
const WAIT_SECONDS = 240;

/** Files next to each planned file: the naming convention the new names must follow. */
export async function siblings(root: string, plan: Plan): Promise<string[]> {
  const dirs = [...new Set(plan.files.map((f) => (f.endsWith("/") ? f.slice(0, -1) : path.posix.dirname(f))))];
  const lines: string[] = [];
  for (const dir of dirs) {
    const abs = resolveInside(root, dir);
    const names = (abs ? await fs.readdir(abs).catch(() => [] as string[]) : []).filter((n) => !n.startsWith(".")).sort();
    if (!names.length) continue;
    lines.push(`- ${dir}/: ${names.slice(0, MAX_SIBLINGS).join(", ")}${names.length > MAX_SIBLINGS ? ", …" : ""}`);
  }
  return lines;
}

export function buildPlanBrief(task: Task, plan: Plan, evidence: string, siblingLines: string[]) {
  const text = evidence.length > MAX_EVIDENCE ? `${evidence.slice(0, MAX_EVIDENCE)}\n…(truncated)` : evidence;
  return [
    `# Plan check: ${task.title}`,
    "You are a senior engineer checking a plan BEFORE any code is written. The plan was made by a cheaper model; a cheap model will implement it literally, so what is wrong here is wrong in the code.",
    "Naming rule:",
    "- Names come exactly from the ticket; a name the ticket does not give must match what a sibling file or an existing caller already uses.",
    "- Every interface name (export, file, argument shape) needs a source: the ticket line or the existing code that decides it.",
    "Check only these, against the ticket, the existing code (read it with your tools) and the sibling files:",
    "1. Interface: file names follow the naming convention of their sibling files; export names and argument shapes match what the ticket, docs or existing callers use (objects vs positional, units, types). Flag names the ticket never gives and a sibling module already defines differently.",
    "2. Reuse: an existing helper (validator, parser, formatter, type) in the repo that the plan should use instead of writing a new one.",
    "3. Robustness the ticket implies: invalid inputs rejected, boundaries from the ticket's acceptance criteria covered by the seams.",
    "4. Scope: a file the plan must touch and does not list, or lists and must not.",
    "The plan's Decisions are settled: an answer came from the user, a `see <path>` from that document. Treat them as evidence like the ticket; never ask to confirm them.",
    "Do not comment on style, wording or things you are not sure about. Keep it under 250 words.",
    "Finish with `VERDICT: OK` or `VERDICT: FIX` followed by a numbered list of concrete fixes (what to rename/change and why, with the file or ticket line that decides it).",
    "## Ticket evidence",
    text || "(only the title)",
    "## Plan",
    planText(plan),
    "## Sibling files",
    ...(siblingLines.length ? siblingLines : ["- (new directories)"]),
    "",
  ].join("\n");
}

export function parsePlanVerdict(output: string): PlanCheckResult | undefined {
  const verdicts = [...output.matchAll(/^\W*VERDICT:\s*(OK|FIX)\b/gim)];
  const last = verdicts.at(-1);
  if (!last) return undefined;
  const body = output.trim();
  if (last[1].toUpperCase() === "OK") return { status: "ok", report: body };
  return { status: "fix", report: output.slice(last.index).trim() || body };
}

/** One short strong-model read of the plan (ticket + interface + siblings). Never throws. */
export async function checkPlan(exec: Exec, root: string, task: Task, plan: Plan, evidence: string, model: string, signal?: AbortSignal): Promise<PlanCheckResult> {
  const brief = buildPlanBrief(task, plan, evidence, await siblings(root, plan));
  const run = await runSubagent(exec, root, {
    name: "plan-check",
    model,
    brief,
    waitSeconds: WAIT_SECONDS,
    signal,
    prompt: "Check the plan in the attached brief against the repo. End with VERDICT: OK or VERDICT: FIX and a numbered list of fixes.",
  });
  const withCost = (r: PlanCheckResult): PlanCheckResult => (run.cost === undefined ? r : { ...r, cost: run.cost });
  if (!run.ok) return withCost({ status: "skipped", report: run.reason });
  return withCost(parsePlanVerdict(run.output) ?? { status: "skipped", report: "The plan check did not include a verdict." });
}
