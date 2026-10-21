import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Task } from "./task-state.ts";
import type { Exec } from "./verify.ts";

export type ReviewStatus = "approved" | "changes" | "skipped";
export interface ReviewResult {
  status: ReviewStatus;
  report: string;
}

const MAX_DIFF = 60_000;
const WAIT_SECONDS = 600;

const skipped = (reason: string): ReviewResult => ({ status: "skipped", report: reason });

async function collectDiff(exec: Exec, root: string) {
  const git = async (args: string[]) => (await exec("git", args, { cwd: root, timeout: 30_000 })).stdout;
  const diff = await git(["diff", "HEAD"]);
  const untracked = (await git(["ls-files", "--others", "--exclude-standard"])).split("\n").filter((f) => f && f !== ".pi/task.json");
  const truncated = diff.length > MAX_DIFF;
  return { diff: truncated ? diff.slice(0, MAX_DIFF) : diff, truncated, untracked };
}

export function buildBrief(task: Task, d: { diff: string; truncated: boolean; untracked: string[] }) {
  const plan = task.plan;
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none)");
  return [
    `# Diff review: ${task.title}`,
    "You are a strict code reviewer. Review ONLY the diff below against the plan, the decisions, AGENTS.md and docs/adr (read them with your tools).",
    "Report real bugs, violations of the plan or its decisions, and violations of project rules. No style nitpicks, no praise, no speculative refactors.",
    "Finish with a line `VERDICT: APPROVED` or `VERDICT: CHANGES`; for CHANGES follow it with a numbered list of findings (file, problem, fix).",
    "## Plan",
    plan?.summary ?? "(no plan)",
    "### Steps",
    list(plan?.steps ?? []),
    "### Files",
    list(plan?.files ?? []),
    "### Decisions",
    list((plan?.decisions ?? []).map((x) => `${x.question} -> ${x.answer ?? x.source ?? x.status}`)),
    "## Untracked files (new, read them directly)",
    list(d.untracked),
    `## Diff (git diff HEAD)${d.truncated ? `\nTRUNCATED to the first ${MAX_DIFF} characters; inspect the rest with your tools.` : ""}`,
    "```diff",
    d.diff || "(empty)",
    "```",
    "",
  ].join("\n");
}

export function parseVerdict(output: string): ReviewResult | undefined {
  const verdicts = [...output.matchAll(/^\W*VERDICT:\s*(APPROVED|CHANGES)\b/gim)];
  const last = verdicts.at(-1);
  if (!last) return undefined;
  const text = output.split("\n").slice(output.slice(0, last.index).split("\n").length - 1).join("\n");
  const body = output.trim();
  return last[1].toUpperCase() === "APPROVED" ? { status: "approved", report: body } : { status: "changes", report: text.trim() || body };
}

/** Read-only review of the working diff by a stronger model through the pi-subagent CLI. Never throws. */
export async function reviewDiff(exec: Exec, root: string, task: Task, model: string): Promise<ReviewResult> {
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1) return skipped(`Modelo de revisión inválido: "${model}" (usa provider/model-id)`);
  const [provider, id] = [model.slice(0, slash), model.slice(slash + 1)];
  let dir: string | undefined;
  let handle: string | undefined;
  try {
    const diff = await collectDiff(exec, root);
    if (!diff.diff.trim() && !diff.untracked.length) return skipped("No hay cambios que revisar.");
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-review-"));
    const brief = path.join(dir, "brief.md");
    await fs.writeFile(brief, buildBrief(task, diff));

    const spawn = await exec(
      "subagent",
      ["spawn", "--name", "review", "--provider", provider, "--model", id, "--thinking", "medium", "--tools", "read,grep,find,ls", "--cwd", root, "--file", brief, "--prompt", "Review the diff in the attached brief. End with VERDICT: APPROVED or VERDICT: CHANGES and a numbered findings list."],
      { cwd: root, timeout: 60_000 },
    );
    if (spawn.code !== 0) return skipped(`No se pudo lanzar la revisión: ${(spawn.stderr || spawn.stdout).trim().slice(0, 300) || `código ${spawn.code}`}`);
    handle = /\(([0-9a-f]+)\)/.exec(spawn.stdout)?.[1] ?? /Spawned (\S+)/.exec(spawn.stdout)?.[1];
    if (!handle) return skipped("No se pudo leer el identificador del subagente.");

    const wait = await exec("subagent", ["wait", handle, "--timeout", String(WAIT_SECONDS)], { cwd: root, timeout: (WAIT_SECONDS + 30) * 1000 });
    if (wait.code !== 0 || wait.killed) return skipped(`La revisión falló: ${(wait.stderr || wait.stdout).trim().slice(0, 300) || "sin respuesta"}`);
    return parseVerdict(wait.stdout) ?? skipped("La revisión no incluyó un veredicto.");
  } catch (error: any) {
    return skipped(`La revisión no se pudo ejecutar: ${error?.message ?? error}`);
  } finally {
    if (handle) await exec("subagent", ["stop", handle], { cwd: root, timeout: 30_000 }).catch(() => {});
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
