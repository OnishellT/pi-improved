import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { exists } from "./config.ts";
import type { Exec } from "./git.ts";
import { readManifest } from "./manifest.ts";
import { isNixFailure, NixError } from "./nix.ts";
import { commitSubject, mayCommit } from "./quality.ts";
import { assessRisk } from "./risk.ts";
import { isLocalState, LOCAL_STATE, oneLine, readTask, type Task } from "./task-state.ts";
import { formatVerify, runVerify, validCap, verifySteps } from "./verify.ts";

const TEMPLATES = [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md", "pull_request_template.md"];
const EVIDENCE_SKILL = ".pi/skills/verify-app/SKILL.md";
const ADR_DIR = "docs/adr/";
const ATTRIBUTION = /co-authored-by|\b(generated|written|created|authored|assisted) (with|by)\b.*\b(claude code|claude|anthropic|chatgpt|copilot|gemini)\b/i;

export interface PrFacts {
  branch: string;
  base?: string;
  commits: string[];
  /** `git diff --name-status` rows against the base. */
  changes: string[];
  /** Uncommitted paths (porcelain), except the machine-local `.pi/` state; versioned `.pi/` files are in. */
  dirty: string[];
  gh: boolean;
  origin?: string;
  template?: string;
  hasEvidenceSkill: boolean;
}

/** Drops attribution lines (co-author trailers, "Generated with ... Claude Code"); product names in the work itself stay. */
export const scrub = (text: string) => text.split("\n").filter((l) => !ATTRIBUTION.test(l)).join("\n");

/** Branch names never carry the agent's vendor (the owner's attribution rule); other product names are the work's subject and stay. */
const VENDOR = /claude|anthropic/;

const slug = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);

/** `task/<ticket>` when the task has one, otherwise a short slug of its title. */
export function branchName(task: Task | undefined): string {
  const key = (task?.ticket ? slug(task.ticket) : slug(oneLine(task?.title ?? "", 50))).split("-").filter((w) => !VENDOR.test(w)).join("-");
  return `task/${key || "change"}`;
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
  const title = oneLine(task?.title ?? commits[0]?.replace(/^\w+\s/, "") ?? "Changes", 200);
  // The title is also the commit subject: at most 72 characters with the ticket prefix, no trailing period.
  return scrub(commitSubject(title, task?.ticket ? `[${task.ticket}] ` : "")).trim() || "Changes";
}

export interface BodyInput {
  task?: Task;
  facts: PrFacts;
  verify?: { ok: boolean; text: string } | "none";
  risk?: { review: boolean; level: string; reasons: string[] };
}

/** The PR body: the repo's template when there is one (kept as is, facts appended), otherwise fixed sections. */
export function buildBody({ task, facts, verify, risk }: BodyInput): string {
  const plan = task?.plan;
  const issue = /(?:^|\/)(\d+)-/.exec(facts.branch)?.[1];
  const adrs = newAdrs(facts.changes, facts.dirty);
  const summary = [
    ...(plan?.intent ? [plan.intent, ""] : []),
    plan?.summary ?? oneLine(task?.title ?? ""),
    ...(plan?.steps.length ? ["", ...plan.steps.map((s) => `- ${s}`)] : []),
    ...(!plan && facts.commits.length ? ["", ...facts.commits.map((c) => `- ${c}`)] : []),
    ...(issue ? ["", `Closes #${issue}`] : []),
  ].join("\n").trim();
  const verified =
    !verify ? "Not run." : verify === "none" ? "The project has no verification steps." : `${verify.ok ? "Passed" : "FAILED"}:\n\n\`\`\`\n${verify.text}\n\`\`\``;
  // The reasons show whatever the review policy decided.
  const riskText = !risk ? "Not assessed." : risk.reasons.length ? `${risk.review ? "Risky" : `Risk ${risk.level}`}: ${risk.reasons.join("; ")}.` : "Low risk: no reason found.";
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

/** Throws a NixError with Nix's message when Nix is missing or failing. */
export async function gatherFacts(exec: Exec, root: string, wanted?: string): Promise<PrFacts | undefined> {
  // Not git.ts `git`: also runs gh, and "undefined" here is a signal the facts code checks (e.g. no repo).
  const run = async (cmd: string, args: string[]) => {
    const r = await exec(cmd, args, { cwd: root, timeout: 30_000 }).catch(() => undefined);
    // Without Nix every git call fails alike: say so, instead of letting the caller read it as "not a repository".
    if (r && cmd === "git" && isNixFailure(r)) throw new NixError(r.stderr);
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
  const status = await run("git", ["status", "--porcelain", "--untracked-files=all"]);
  // An unreadable status is not a clean tree: the PR would leave uncommitted work out without saying so.
  if (status === undefined) throw new NixError("git status failed, so the uncommitted work is unknown. Fix git, then run /pr again.");
  const dirty = status.split("\n").filter(Boolean).filter((l) => !isLocalState(l.slice(3)));
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
    hasEvidenceSkill: await exists(path.join(root, EVIDENCE_SKILL)),
  };
}

export type PrOutcome = { status: "not-ready" | "shown" | "declined" | "failed" | "opened"; detail: string };

/**
 * The /pr flow. Nothing is pushed and no PR is opened without a yes from ctx.ui.confirm.
 * It always pushes to `origin`, whatever the base ref is, and `gh --version` only proves gh is installed:
 * a missing `gh auth login` shows up late, as "gh pr create failed".
 */
export async function runPr(exec: Exec, root: string, ui: Pick<ExtensionContext["ui"], "confirm" | "notify">, wantedBase?: string): Promise<PrOutcome> {
  let facts: PrFacts | undefined;
  try {
    facts = await gatherFacts(exec, root, wantedBase?.trim() || undefined);
  } catch (error) {
    if (error instanceof NixError) return { status: "not-ready", detail: error.message };
    throw error;
  }
  if (!facts) return { status: "not-ready", detail: "This folder is not a git repository." };
  if (!facts.base) return { status: "not-ready", detail: "No base branch found. Run /pr <base-branch>." };
  const baseName = facts.base.replace(/^origin\//, "");
  const task = await readTask(root).catch(() => undefined);
  const manifest = await readManifest(root).catch(() => undefined);

  let branch = facts.branch;
  if (branch === baseName || branch === "(detached HEAD)") {
    const proposed = branchName(task);
    if (!(await ui.confirm("Create a task branch?", `You are on ${branch}. Create ${proposed} from here? Uncommitted work comes along.`)))
      return { status: "not-ready", detail: `A task branch is needed before a PR (suggested: ${proposed}).` };
    const made = await exec("git", ["switch", "-c", proposed], { cwd: root, timeout: 30_000 });
    if (made.code !== 0) return { status: "failed", detail: `git switch -c ${proposed} failed: ${made.stderr.trim()}` };
    branch = proposed;
  }

  // Verify runs before anything is committed: /pr commits only a tree that passes.
  let verify: BodyInput["verify"] = "none";
  if (manifest?.verify.length) {
    const result = await runVerify(verifySteps(manifest), exec, root, undefined, validCap(manifest.maxReport));
    verify = { ok: result.ok, text: formatVerify(result) };
    // Verify can write files (reports, caches): the commit offer lists the tree as it is now.
    facts = (await gatherFacts(exec, root, facts.base)) ?? facts;
  }
  // /task leaves its work uncommitted; without this the PR would miss it.
  if (facts.dirty.length && !mayCommit(verify === "none" ? "none" : verify.ok ? "pass" : "fail"))
    return { status: "declined", detail: `Verify failed, so the uncommitted work was not committed and nothing was pushed. Fix it and run /pr again.\n\n${verify === "none" ? "" : verify.text}` };
  if (facts.dirty.length) {
    if (await ui.confirm("Commit the uncommitted work?", `Commit these to ${branch} so they go in the PR?\n${facts.dirty.join("\n")}`)) {
      // Add then unstage, not exclude pathspecs: git fails on an excluded path that .gitignore already ignores.
      // Both from the repository root (`:/`), like the porcelain list offered above, even when pi runs in a subfolder.
      let added = await exec("git", ["add", "-A", "--", ":/"], { cwd: root, timeout: 30_000 });
      if (added.code === 0) added = await exec("git", ["reset", "-q", "--", ...LOCAL_STATE.map((p) => `:/${p}`)], { cwd: root, timeout: 30_000 });
      const made = added.code === 0 ? await exec("git", ["commit", "-m", prTitle(task, [])], { cwd: root, timeout: 120_000 }) : added;
      if (made.code !== 0) return { status: "failed", detail: `Commit failed: ${(made.stderr || made.stdout).trim()}` };
      facts = (await gatherFacts(exec, root, facts.base)) ?? facts;
    }
  }

  if (verify !== "none" && !verify.ok && !(await ui.confirm("Verify failed", `${verify.text}\n\nOpen the PR anyway?`))) return { status: "declined", detail: "Verify failed; nothing was pushed." };
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
