import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readManifest } from "./manifest.ts";
import { assessRisk } from "./risk.ts";
import { readTask, type Task } from "./task-state.ts";
import { formatVerify, runVerify, type Exec } from "./verify.ts";

const TEMPLATES = [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md", "pull_request_template.md"];
const EVIDENCE_SKILL = ".pi/skills/verify-app/SKILL.md";
const ADR_DIR = "docs/adr/";
const AI_MENTION = /co-authored-by|generated (with|by)|\b(claude|anthropic|chatgpt|openai|copilot|gemini)\b/i;

export interface PrFacts {
  branch: string;
  base?: string;
  commits: string[];
  /** `git diff --name-status` rows against the base. */
  changes: string[];
  /** Uncommitted paths (porcelain), outside `.pi/`. */
  dirty: string[];
  gh: boolean;
  origin?: string;
  template?: string;
  hasEvidenceSkill: boolean;
}

/** Drops every line that credits or names an AI tool: PR text carries only the work itself. */
export const scrub = (text: string) => text.split("\n").filter((l) => !AI_MENTION.test(l)).join("\n");

const slug = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);

/** `task/<ticket>` when the task has one, otherwise a short slug of its title. */
export function branchName(task: Task | undefined): string {
  const key = task?.ticket ? slug(task.ticket) : slug(task?.title ?? "");
  return `task/${AI_MENTION.test(key) ? "change" : key || "change"}`;
}

/** Paths of ADRs the diff adds, plus untracked ones (marked). */
export function newAdrs(changes: string[], dirty: string[]): string[] {
  const out = new Set<string>();
  for (const row of changes) {
    const [status, ...rest] = row.split(/\s+/);
    const file = rest.at(-1) ?? "";
    if (status?.startsWith("A") && file.startsWith(ADR_DIR)) out.add(file);
  }
  for (const row of dirty) if (row.startsWith("??") && row.slice(3).startsWith(ADR_DIR)) out.add(`${row.slice(3)} (uncommitted)`);
  return [...out];
}

export function prTitle(task: Task | undefined, commits: string[]): string {
  const title = task?.title ?? commits[0]?.replace(/^\w+\s/, "") ?? "Changes";
  return scrub(`${task?.ticket ? `[${task.ticket}] ` : ""}${title}`).trim() || "Changes";
}

export interface BodyInput {
  task?: Task;
  facts: PrFacts;
  verify?: { ok: boolean; text: string } | "none";
  risk?: { review: boolean; reasons: string[] };
}

/** The PR body: the repo's template when there is one (kept as is, facts appended), otherwise fixed sections. */
export function buildBody({ task, facts, verify, risk }: BodyInput): string {
  const plan = task?.plan;
  const issue = /^#?(\d+)$/.exec(task?.ticket ?? "")?.[1] ?? /(?:^|\/)(\d+)-/.exec(facts.branch)?.[1];
  const adrs = newAdrs(facts.changes, facts.dirty);
  const summary = [
    plan?.summary ?? task?.title ?? "",
    ...(plan?.steps.length ? ["", ...plan.steps.map((s) => `- ${s}`)] : []),
    ...(!plan && facts.commits.length ? ["", ...facts.commits.map((c) => `- ${c}`)] : []),
    ...(issue ? ["", `Closes #${issue}`] : []),
  ].join("\n").trim();
  const verified =
    !verify ? "Not run." : verify === "none" ? "The project has no verification steps." : `${verify.ok ? "Passed" : "FAILED"}:\n\n\`\`\`\n${verify.text}\n\`\`\``;
  const riskText = risk ? (risk.review ? `Risky: ${risk.reasons.join("; ")}.` : "Low risk: no reason found.") : "Not assessed.";
  const sections: [string, string][] = [
    ["Summary", summary || "(no task plan: see the commits)"],
    ["How it was verified", verified],
    ["Risk", riskText],
    ["New ADRs", adrs.length ? adrs.map((f) => `- ${f}`).join("\n") : "(none)"],
  ];
  if (facts.hasEvidenceSkill) sections.push(["Evidence", `Attach the evidence that the project's verification skill (${EVIDENCE_SKILL}) describes: screenshots, logs, output.`]);
  if (plan?.seams.length) sections.push(["Tests", plan.seams.map((s) => `- ${s.name}: catches ${s.catches}${s.misses ? `; misses ${s.misses}` : ""}`).join("\n")]);
  const generated = sections.map(([h, b]) => `## ${h}\n${b}`).join("\n\n");
  const body = facts.template ? `${facts.template.trimEnd()}\n\n---\n\n${generated}` : generated;
  return `${scrub(body)}\n`;
}

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

export async function gatherFacts(exec: Exec, root: string, wanted?: string): Promise<PrFacts | undefined> {
  const run = async (cmd: string, args: string[]) => {
    const r = await exec(cmd, args, { cwd: root, timeout: 30_000 }).catch(() => undefined);
    return r && r.code === 0 ? r.stdout : undefined;
  };
  if ((await run("git", ["rev-parse", "--git-dir"])) === undefined) return undefined;
  let base: string | undefined;
  for (const ref of [wanted, "origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    if (ref && (await run("git", ["rev-parse", "--verify", "-q", ref])) !== undefined) {
      base = ref;
      break;
    }
  }
  // origin/HEAD is a symbolic ref: use the branch it points to, or the base would be named "HEAD".
  if (base === "origin/HEAD") base = (await run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))?.trim() || "origin/main";
  const branch = (await run("git", ["branch", "--show-current"]))?.trim() || "(detached HEAD)";
  const commits = base ? lines((await run("git", ["log", "--format=%h %s", `${base}..HEAD`])) ?? "") : [];
  const changes = base ? lines((await run("git", ["diff", "--name-status", `${base}...HEAD`])) ?? "") : [];
  const dirty = ((await run("git", ["status", "--porcelain"])) ?? "").split("\n").filter(Boolean).filter((l) => !l.slice(3).startsWith(".pi/"));
  let template: string | undefined;
  for (const rel of TEMPLATES) {
    template = await fs.readFile(path.join(root, rel), "utf8").catch(() => undefined);
    if (template !== undefined) break;
  }
  return {
    branch,
    base,
    commits,
    changes,
    dirty,
    gh: (await run("gh", ["--version"])) !== undefined,
    origin: (await run("git", ["remote", "get-url", "origin"]))?.trim() || undefined,
    template,
    hasEvidenceSkill: await fs.access(path.join(root, EVIDENCE_SKILL)).then(() => true, () => false),
  };
}

export type PrOutcome = { status: "not-ready" | "shown" | "declined" | "failed" | "opened"; detail: string };

/** The /pr flow. Nothing is pushed and no PR is opened without a yes from ctx.ui.confirm. */
export async function runPr(exec: Exec, root: string, ui: any, wantedBase?: string): Promise<PrOutcome> {
  const facts = await gatherFacts(exec, root, wantedBase?.trim() || undefined);
  if (!facts) return { status: "not-ready", detail: "This folder is not a git repository." };
  if (!facts.base) return { status: "not-ready", detail: "No base branch found. Run /pr <base-branch>." };
  const baseName = facts.base.replace(/^origin\//, "");
  const task = await readTask(root).catch(() => undefined);
  const manifest = await readManifest(root).catch(() => undefined);

  let branch = facts.branch;
  if (branch === baseName || branch === "(detached HEAD)") {
    const proposed = branchName(task);
    if (!(await ui.confirm("Create a task branch?", `You are on ${branch}. Create ${proposed} from here? Uncommitted work stays out of the PR.`)))
      return { status: "not-ready", detail: `A task branch is needed before a PR (suggested: ${proposed}).` };
    const made = await exec("git", ["switch", "-c", proposed], { cwd: root, timeout: 30_000 });
    if (made.code !== 0) return { status: "failed", detail: `git switch -c ${proposed} failed: ${made.stderr.trim()}` };
    branch = proposed;
  }

  let verify: BodyInput["verify"] = "none";
  if (manifest?.verify.length) {
    const result = await runVerify(manifest.verify, exec, root);
    verify = { ok: result.ok, text: formatVerify(result) };
    if (!result.ok && !(await ui.confirm("Verify failed", `${verify.text}\n\nOpen the PR anyway?`))) return { status: "declined", detail: "Verify failed; nothing was pushed." };
  }
  const risk = manifest ? await assessRisk(exec, root, task, manifest) : undefined;

  const title = prTitle(task, facts.commits);
  const body = buildBody({ task, facts: { ...facts, branch }, verify, risk });
  ui.notify(`${title}\n\n${body}${facts.dirty.length ? `\nNot in the PR until committed:\n${facts.dirty.join("\n")}\n` : ""}`, "info");

  if (!facts.gh || !facts.origin) return { status: "shown", detail: `${facts.gh ? "" : "gh is not installed. "}${facts.origin ? "" : "There is no origin remote. "}Push and open the PR yourself with the title and body above.` };
  if (!(await ui.confirm("Open the PR?", `Push ${branch} to origin and open a PR against ${baseName}?`))) return { status: "declined", detail: "Nothing was pushed. The body stays above." };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-pr-"));
  const file = path.join(dir, "body.md");
  try {
    await fs.writeFile(file, body);
    const push = await exec("git", ["push", "-u", "origin", branch], { cwd: root, timeout: 120_000 });
    if (push.code !== 0) return { status: "failed", detail: `git push failed: ${push.stderr.trim()}` };
    const pr = await exec("gh", ["pr", "create", "--base", baseName, "--title", title, "--body-file", file], { cwd: root, timeout: 60_000 });
    if (pr.code !== 0) return { status: "failed", detail: `gh pr create failed: ${pr.stderr.trim()}` };
    return { status: "opened", detail: pr.stdout.trim() };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export function registerPr(pi: ExtensionAPI) {
  pi.registerCommand("pr", {
    description: "Prepare the task's PR (summary, verify report, risk, ADRs); pushes only after you confirm",
    handler: async (args, ctx) => {
      const outcome = await runPr(pi.exec.bind(pi) as Exec, ctx.cwd, ctx.ui, args);
      ctx.ui.notify(outcome.detail, outcome.status === "failed" || outcome.status === "not-ready" ? "warning" : "info");
    },
  });
}
