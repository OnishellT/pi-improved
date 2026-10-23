import * as fs from "node:fs/promises";
import * as path from "node:path";
import { planText } from "./task-prompt.ts";
import { runSubagent } from "./review.ts";
import type { Plan, Task } from "./task-state.ts";
import type { Exec } from "./verify.ts";

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
    const names = (await fs.readdir(path.join(root, dir)).catch(() => [] as string[])).filter((n) => !n.startsWith(".")).sort();
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
    "Check only these, against the ticket, the existing code (read it with your tools) and the sibling files:",
    "1. Interface: file names follow the naming convention of their sibling files; export names and argument shapes match what the ticket, docs or existing callers use (objects vs positional, units, types). Flag names the ticket never gives and a sibling module already defines differently.",
    "2. Reuse: an existing helper (validator, parser, formatter, type) in the repo that the plan should use instead of writing a new one.",
    "3. Robustness the ticket implies: invalid inputs rejected, boundaries from the ticket's acceptance criteria covered by the seams.",
    "4. Scope: a file the plan must touch and does not list, or lists and must not.",
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
  const text = output.split("\n").slice(output.slice(0, last.index).split("\n").length - 1).join("\n");
  return { status: "fix", report: text.trim() || body };
}

/** One short strong-model read of the plan (ticket + interface + siblings). Never throws. */
export async function checkPlan(exec: Exec, root: string, task: Task, plan: Plan, evidence: string, model: string): Promise<PlanCheckResult> {
  const brief = buildPlanBrief(task, plan, evidence, await siblings(root, plan));
  const run = await runSubagent(exec, root, {
    name: "plan-check",
    model,
    brief,
    waitSeconds: WAIT_SECONDS,
    prompt: "Check the plan in the attached brief against the repo. End with VERDICT: OK or VERDICT: FIX and a numbered list of fixes.",
  });
  const withCost = (r: PlanCheckResult): PlanCheckResult => (run.cost === undefined ? r : { ...r, cost: run.cost });
  if (!run.ok) return withCost({ status: "skipped", report: run.reason });
  return withCost(parsePlanVerdict(run.output) ?? { status: "skipped", report: "El chequeo del plan no incluyó un veredicto." });
}
