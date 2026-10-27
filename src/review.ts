import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBin } from "./bin.ts";
import { ownRuns } from "./subagent-panes.ts";
import type { Task } from "./task-state.ts";
import { agentDir, ensureTrusted } from "./subagent-ext.ts";
import { diffBase, git, untrackedFiles, type Exec } from "./git.ts";

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
// codemode batches reads in one script. Its scripts can call MCP tools outside --tools unless an entry starts
// with `mcp__`; `mcp__none` matches no tool, so codemode reaches only the four read tools.
const CHILD_TOOLS = "read,grep,find,ls,codemode,mcp__none";

const skipped = (reason: string): ReviewResult => ({ status: "skipped", report: reason });

async function collectDiff(exec: Exec, root: string, task?: Pick<Task, "baseCommit">) {
  const base = await diffBase(exec, root, task);
  const diff = await git(exec, root, ["diff", base, "--", ".", ":(exclude).pi"]);
  if (diff === undefined) throw new Error("git diff failed");
  const untracked = await untrackedFiles(exec, root);
  const truncated = diff.length > MAX_DIFF;
  // New files are not in `git diff <base>`: inline them while the budget lasts so the reviewer does not spend turns reading them.
  const contents: Record<string, string> = {};
  let budget = MAX_DIFF - Math.min(diff.length, MAX_DIFF);
  for (const file of untracked) {
    // stat first: do not read a huge file just to drop it.
    const stat = await fs.stat(path.join(root, file)).catch(() => undefined);
    if (!stat?.isFile() || stat.size > budget) continue;
    const text = await fs.readFile(path.join(root, file), "utf8").catch(() => undefined);
    if (text === undefined || text.length > budget || text.includes("\0")) continue;
    contents[file] = text;
    budget -= text.length;
  }
  return { diff: truncated ? diff.slice(0, MAX_DIFF) : diff, truncated, untracked, contents, base };
}

export function buildBrief(task: Task, d: { diff: string; truncated: boolean; untracked: string[]; contents?: Record<string, string>; base?: string }, skills = "") {
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
    `## Diff (git diff ${d.base ?? "HEAD"})${d.truncated ? `\nTRUNCATED to the first ${MAX_DIFF} characters; inspect the rest with your tools.` : ""}`,
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

const runsDir = () => path.join(agentDir(), "subagents");

/** Sums the cost of every assistant message in the child's session; undefined when it can't be read. */
export async function subagentCost(handle: string, dir = runsDir()): Promise<number | undefined> {
  for (const run of await fs.readdir(dir).catch(() => [] as string[])) {
    // A corrupt or half-written run of another subagent must not hide this one's cost.
    let meta: any;
    try {
      meta = JSON.parse(readFileSync(path.join(dir, run, "metadata.json"), "utf8"));
    } catch {
      continue;
    }
    if (meta?.handle !== handle) continue;
    try {
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

export type SubagentRun = { ok: true; output: string; cost?: number } | { ok: false; reason: string; cancelled?: boolean; cost?: number };

/**
 * One read-only subagent (pi-subagent CLI) on `model`, fed a brief file, waited for and stopped. Never throws.
 * Shared by the diff review and the plan spot check so both pay the same way and die the same way.
 */
export async function runSubagent(exec: Exec, root: string, opts: { name: string; model: string; brief: string; prompt: string; signal?: AbortSignal; waitSeconds?: number }): Promise<SubagentRun> {
  const { model, signal } = opts;
  const waitSeconds = opts.waitSeconds ?? WAIT_SECONDS;
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1) return { ok: false, reason: `Invalid model: "${model}" (use provider/model-id)` };
  const [provider, id] = [model.slice(0, slash), model.slice(slash + 1)];
  let dir: string | undefined;
  let handle: string | undefined;
  let cost: number | undefined;
  const cancelled = (): SubagentRun => ({ ok: false, reason: "cancelled", cancelled: true });
  const fail = (reason: string): SubagentRun => ({ ok: false, reason });
  const result = await attempt();
  return cost === undefined ? result : { ...result, cost };

  async function attempt(): Promise<SubagentRun> {
    try {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), `pi-${opts.name}-`));
      const brief = path.join(dir, "brief.md");
      await fs.writeFile(brief, opts.brief);

      await ensureTrusted(root).catch(() => false);
      const spawn = await exec(
        resolveBin("subagent"),
        ["spawn", "--name", opts.name, "--provider", provider, "--model", id, "--thinking", "medium", "--tools", CHILD_TOOLS, "--cwd", root, "--file", brief, "--prompt", opts.prompt],
        { cwd: root, timeout: 60_000 },
      );
      if (spawn.code !== 0) return fail(`Could not launch the subagent: ${(spawn.stderr || spawn.stdout).trim().slice(0, 300) || `code ${spawn.code}`}`);
      // pi-subagent prints "Spawned <name> (<handle>)" on its first line.
      handle = /^Spawned \S+ \(([0-9a-f]+)\)/m.exec(spawn.stdout)?.[1];
      if (!handle) return fail("Could not start the review: no subagent handle in the spawn output.");
      ownRuns.add(handle);
      if (signal?.aborted) return cancelled();

      const wait = await exec(resolveBin("subagent"), ["wait", handle, "--timeout", String(waitSeconds)], { cwd: root, timeout: (waitSeconds + 30) * 1000, signal });
      if (signal?.aborted) return cancelled();
      if (wait.code !== 0 || wait.killed) return fail(`The subagent failed: ${(wait.stderr || wait.stdout).trim().slice(0, 300) || "no response"}`);
      return { ok: true, output: wait.stdout };
    } catch (error: any) {
      return signal?.aborted ? cancelled() : fail(`Could not run: ${error?.message ?? error}`);
    } finally {
      if (handle) {
        cost = await subagentCost(handle);
        await exec(resolveBin("subagent"), ["stop", handle], { cwd: root, timeout: 30_000 }).catch(() => {});
        ownRuns.delete(handle);
      }
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Read-only review of the working diff by a stronger model through the pi-subagent CLI. Never throws. */
export async function reviewDiff(exec: Exec, root: string, task: Task, model: string, signal?: AbortSignal, skills?: string): Promise<ReviewResult> {
  let diff: Awaited<ReturnType<typeof collectDiff>>;
  try {
    diff = await collectDiff(exec, root, task);
  } catch (error: any) {
    return skipped(`The review could not run: ${error?.message ?? error}`);
  }
  if (!diff.diff.trim() && !diff.untracked.length) return skipped("No changes to review.");
  const run = await runSubagent(exec, root, {
    name: "review",
    model,
    signal,
    brief: buildBrief(task, diff, skills),
    prompt: "Review the diff in the attached brief. End with VERDICT: APPROVED or VERDICT: CHANGES and a numbered findings list.",
  });
  const withCost = (r: ReviewResult): ReviewResult => (run.cost === undefined ? r : { ...r, cost: run.cost });
  if (!run.ok) return withCost(run.cancelled ? { status: "skipped", report: "Review cancelled: the diff changed.", cancelled: true } : skipped(`The review failed: ${run.reason}`));
  return withCost(parseVerdict(run.output) ?? skipped("The review did not include a verdict."));
}
