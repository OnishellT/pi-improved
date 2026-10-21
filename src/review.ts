import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBin } from "./bin.ts";
import type { Task } from "./task-state.ts";
import { ensureTrusted } from "./subagent-ext.ts";
import type { Exec } from "./verify.ts";

export type ReviewStatus = "approved" | "changes" | "skipped";
export interface ReviewResult {
  status: ReviewStatus;
  report: string;
  /** Cost of the subagent's model calls, read from its session before it is stopped. */
  cost?: number;
  cancelled?: boolean;
}

const MAX_DIFF = 60_000;
const WAIT_SECONDS = 600;

const skipped = (reason: string): ReviewResult => ({ status: "skipped", report: reason });

async function collectDiff(exec: Exec, root: string) {
  const git = async (args: string[]) => (await exec("git", args, { cwd: root, timeout: 30_000 })).stdout;
  const diff = await git(["diff", "HEAD"]);
  const untracked = (await git(["ls-files", "--others", "--exclude-standard"])).split("\n").filter((f) => f && f !== ".pi/task.json");
  const truncated = diff.length > MAX_DIFF;
  // New files are not in `git diff HEAD`: inline them while the budget lasts so the reviewer does not spend turns reading them.
  const contents: Record<string, string> = {};
  let budget = MAX_DIFF - Math.min(diff.length, MAX_DIFF);
  for (const file of untracked) {
    const text = await fs.readFile(path.join(root, file), "utf8").catch(() => undefined);
    if (text === undefined || text.length > budget || text.includes("\0")) continue;
    contents[file] = text;
    budget -= text.length;
  }
  return { diff: truncated ? diff.slice(0, MAX_DIFF) : diff, truncated, untracked, contents };
}

export function buildBrief(task: Task, d: { diff: string; truncated: boolean; untracked: string[]; contents?: Record<string, string> }, skills = "") {
  const plan = task.plan;
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none)");
  return [
    `# Diff review: ${task.title}`,
    ...(skills ? [skills] : []),
    "You are a strict code reviewer. Review ONLY the diff below against the plan, the decisions, AGENTS.md and docs/adr (read them with your tools).",
    "CHANGES is only for blocking problems: wrong behavior, crashes, data loss, security holes, or breaking the plan, its decisions, the agreed interface, AGENTS.md or an ADR. Style, naming, extra tests, refactors and anything you are not sure about are not blocking: approve and leave them out.",
    "The diff and the new files are below in full: read other files only when you need them to confirm a bug.",
    "Finish with a line `VERDICT: APPROVED` or `VERDICT: CHANGES`; for CHANGES follow it with a numbered list of blocking findings only (file, problem, fix).",
    "## Plan",
    plan?.summary ?? "(no plan)",
    "### Steps",
    list(plan?.steps ?? []),
    "### Files",
    list(plan?.files ?? []),
    "### Decisions",
    list((plan?.decisions ?? []).map((x) => `${x.question} -> ${x.answer ?? x.source ?? x.status}`)),
    "## Interface",
    ...(plan?.interface?.length ? plan.interface.map((i) => `- ${i.file} → ${[...i.exports, ...(i.signatures ?? [])].join("; ")}${i.source ? ` (source: ${i.source})` : ""}`) : ["- (none)"]),
    "Any deviation of the diff from this interface (file, export name or signature) is BLOCKING.",
    "## Seams",
    ...(plan?.seams?.length ? plan.seams.map((x) => `- ${x.name} → ${x.testFile}: catches ${x.catches}${x.misses ? `; misses ${x.misses}` : ""}`) : ["- (none)"]),
    "## New files",
    ...(d.untracked.length ? d.untracked.map((f) => (d.contents?.[f] === undefined ? `- ${f} (read it directly)` : `### ${f}\n\`\`\`\n${d.contents[f]}\n\`\`\``)) : ["- (none)"]),
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

const runsDir = () => path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "subagents");

/** Sums the cost of every assistant message in the child's session; undefined when it can't be read. */
export async function subagentCost(handle: string, dir = runsDir()): Promise<number | undefined> {
  for (const run of await fs.readdir(dir).catch(() => [] as string[])) {
    try {
      const meta = JSON.parse(readFileSync(path.join(dir, run, "metadata.json"), "utf8"));
      if (meta.handle !== handle) continue;
      let cost = 0;
      for (const line of readFileSync(meta.sessionFile, "utf8").split("\n")) {
        if (!line) continue;
        const entry = JSON.parse(line);
        if (entry.message?.role === "assistant") cost += entry.message.usage?.cost?.total ?? 0;
      }
      return cost;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Read-only review of the working diff by a stronger model through the pi-subagent CLI. Never throws. */
export async function reviewDiff(exec: Exec, root: string, task: Task, model: string, signal?: AbortSignal, skills?: string): Promise<ReviewResult> {
  const spent: { cost?: number } = {};
  const result = await runReview(exec, root, task, model, signal, spent, skills);
  return spent.cost === undefined ? result : { ...result, cost: spent.cost };
}

async function runReview(exec: Exec, root: string, task: Task, model: string, signal: AbortSignal | undefined, spent: { cost?: number }, skills?: string): Promise<ReviewResult> {
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1) return skipped(`Modelo de revisión inválido: "${model}" (usa provider/model-id)`);
  const [provider, id] = [model.slice(0, slash), model.slice(slash + 1)];
  let dir: string | undefined;
  let handle: string | undefined;
  const cancelled = (): ReviewResult => ({ status: "skipped", report: "Revisión cancelada: el diff cambió.", cancelled: true });
  try {
    const diff = await collectDiff(exec, root);
    if (!diff.diff.trim() && !diff.untracked.length) return skipped("No hay cambios que revisar.");
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-review-"));
    const brief = path.join(dir, "brief.md");
    await fs.writeFile(brief, buildBrief(task, diff, skills));

    await ensureTrusted(root).catch(() => false);
    const spawn = await exec(
      resolveBin("subagent"),
      ["spawn", "--name", "review", "--provider", provider, "--model", id, "--thinking", "medium", "--tools", "read,grep,find,ls", "--cwd", root, "--file", brief, "--prompt", "Review the diff in the attached brief. End with VERDICT: APPROVED or VERDICT: CHANGES and a numbered findings list."],
      { cwd: root, timeout: 60_000 },
    );
    if (spawn.code !== 0) return skipped(`No se pudo lanzar la revisión: ${(spawn.stderr || spawn.stdout).trim().slice(0, 300) || `código ${spawn.code}`}`);
    handle = /\(([0-9a-f]+)\)/.exec(spawn.stdout)?.[1] ?? /Spawned (\S+)/.exec(spawn.stdout)?.[1];
    if (!handle) return skipped("No se pudo leer el identificador del subagente.");
    if (signal?.aborted) return cancelled();

    const wait = await exec(resolveBin("subagent"), ["wait", handle, "--timeout", String(WAIT_SECONDS)], { cwd: root, timeout: (WAIT_SECONDS + 30) * 1000, signal });
    if (signal?.aborted) return cancelled();
    if (wait.code !== 0 || wait.killed) return skipped(`La revisión falló: ${(wait.stderr || wait.stdout).trim().slice(0, 300) || "sin respuesta"}`);
    return parseVerdict(wait.stdout) ?? skipped("La revisión no incluyó un veredicto.");
  } catch (error: any) {
    return signal?.aborted ? cancelled() : skipped(`La revisión no se pudo ejecutar: ${error?.message ?? error}`);
  } finally {
    if (handle) {
      spent.cost = await subagentCost(handle);
      await exec(resolveBin("subagent"), ["stop", handle], { cwd: root, timeout: 30_000 }).catch(() => {});
    }
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
