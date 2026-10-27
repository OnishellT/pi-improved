import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeAdr, type AdrInput } from "./adr.ts";
import { selectOrType } from "./ask.ts";
import { missingNames, relatesTo } from "./contract.ts";
import { REVIEW_EVENT, type ReviewPayload } from "./events.ts";
import { relatedTasks } from "./learn.ts";
import { usePhaseModel } from "./models.ts";
import { gitHead } from "./git.ts";
import { checkPlan } from "./plan-check.ts";
import { highRiskReasons, planRiskReasons } from "./risk.ts";
import { phaseSkills, skillsBlock } from "./skills.ts";
import { readManifest, type Manifest } from "./manifest.ts";
import { inFiles, readTask, resolveInside, updateTask, writeTask, type Decision, type Plan, type Task } from "./task-state.ts";
import { QUESTION_NUDGE, TASK_NUDGE, planText, taskPrompt } from "./task-prompt.ts";

const MAX_NUDGES = 2; // "call task_plan" / "use ask_user" reminders per user message
const MAX_PLAN_CHECKS = 1; // paid plan checks per task
const MAX_TICKET_TEXT = 300_000; // characters of tracker output kept as evidence
// A ticket key at the start of the request (`PAY-142` or `PAY-142 add fees`); anywhere else it is free text.
const TICKET = /^[A-Z][A-Z0-9]+-\d+$/;
const TRACKERS = ["jira", "linear"];
const PLAN_STATUS = { ok: "plan-ok", fix: "plan-fix", skipped: "skipped" } as const;
// Doc files named in a request: relative or absolute paths ending in .md/.txt/..., bare or quoted, with prose punctuation around them.
const SPEC_FILE = /(?:^|[\s:(\[`"'])((?:\.{1,2}\/|\/|[\w.-]+\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:md|markdown|txt|rst|adoc))(?=$|[\s:,;.)\]`"'])/g;

const exists = (file: string) => fs.access(file).then(() => true, () => false);

const tracker = (manifest: Manifest) => manifest.connectors.find((c) => TRACKERS.includes(c.id))?.id;

/** The plan check costs a model call: off unless `review.always`, `review.plan` true, or a risk policy is set and the plan touches high-risk files. `always` beats `never`. */
export function planCheckWanted(manifest: Manifest, files: string[]): boolean {
  const rule = manifest.review;
  if (rule?.always) return true;
  if (rule?.never || rule?.plan === false) return false;
  if (rule?.plan === true) return true;
  return !!rule?.minLevel && rule.minLevel !== "off" && highRiskReasons(files, rule).length > 0;
}

/** Existing spec files named in a /task request; files outside the repo are ignored. */
export async function specFiles(root: string, text: string): Promise<string[]> {
  const found: string[] = [];
  for (const m of text.matchAll(SPEC_FILE)) {
    const abs = resolveInside(root, m[1].replace(/[.,;:]+$/, ""));
    const rel = abs && path.relative(root, abs);
    if (rel && (await exists(abs)) && !found.includes(rel)) found.push(rel);
  }
  return found;
}

/** Text content of a tool result (MCP results arrive as content blocks or plain strings). */
const resultText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : "")).join("\n");
  return typeof (content as any)?.text === "string" ? (content as any).text : "";
};

/** File text for a model-cited path; "" when it is missing, unreadable or outside the project. */
const readInside = async (root: string, rel: string) => {
  const abs = resolveInside(root, rel);
  return abs ? fs.readFile(abs, "utf8").catch(() => "") : "";
};

type PlanParams = Omit<Plan, "decisions"> & { decisions: { question: string; options: string[]; source?: string }[] };
/** An ADR is only written once the user approves the plan. */
type PendingAdr = { decision: Decision; adr: AdrInput };

export function registerTask(pi: ExtensionAPI) {
  let nudges = 0;
  /** What the planner read from the tracker (MCP) while planning: the ticket, as evidence for interface names. */
  const ticketText = new Map<string, string>();
  /** Answers already given for a question text, so a task_plan retry does not ask it again. Reset per task. */
  const answers = new Map<string, string>();
  /** What the user answered through ask_user while planning, by question: decisions the plan records. Reset per task. */
  const asked = new Map<string, { question: string; options: string[]; answer: string }>();

  const evidenceFor = async (root: string, task: Task) => {
    const parts = [task.title, ...(task.ticket ? [task.ticket] : []), ticketText.get(root) ?? ""];
    for (const spec of task.spec ?? []) parts.push(await readInside(root, spec));
    return parts.join("\n");
  };

  const start = async (ctx: any, manifest: Manifest, task: Task) => {
    nudges = 0;
    answers.clear();
    asked.clear();
    ticketText.delete(ctx.cwd);
    await usePhaseModel(pi, ctx, "implement");
    pi.sendUserMessage(taskPrompt(task.title, task.ticket, tracker(manifest), await relatedTasks(ctx.cwd, task.title), await skillsBlock(ctx.cwd, "plan"), task.spec));
    return ctx.waitForIdle();
  };

  /** Ask once per question and options; a cancelled dialog stops the plan. */
  const ask = async (ctx: any, what: string, question: string, options: string[]) => {
    const key = JSON.stringify([question, options]);
    const known = answers.get(key);
    if (known !== undefined) return known;
    const answer = await selectOrType(ctx, question, options);
    if (answer === undefined) throw new Error(`The user cancelled the ${what} question, so the plan is not approved. Stop and wait for the user.`);
    answers.set(key, answer);
    return answer;
  };

  /** Shape gates: new files need a pinned interface, and every seam's test file must be in the plan. */
  const checkShape = async (root: string, params: PlanParams) => {
    const isNew = async (f: string) => !f.endsWith("/") && !(await exists(path.join(root, f)));
    if (!params.interface.length && (await Promise.all(params.files.map(isNew))).some(Boolean))
      throw new Error("The plan creates new files but interface is empty. Pin the file and export names (cite their source), then call task_plan again.");
    const stray = params.seams.filter((x) => !inFiles(params.files, x.testFile));
    if (stray.length) throw new Error(`Seam test files must be listed in files: ${stray.map((x) => x.testFile).join(", ")}. Fix the plan and call task_plan again.`);
  };

  /** Names are only "given" when the cited source really contains them; the label alone proves nothing. */
  const askInterface = async (ctx: any, root: string, task: Task, params: PlanParams, evidence: string, pending: PendingAdr[]): Promise<Decision[]> => {
    const invented: string[] = [];
    for (const entry of params.interface) {
      const file = entry.source && entry.source !== "user" && entry.source !== "ticket" ? entry.source.split("#")[0] : undefined;
      const text = entry.source === "ticket" ? evidence : file ? await readInside(root, file) : "";
      const isNew = !entry.file.endsWith("/") && !(await exists(path.join(root, entry.file)));
      const missing = text ? missingNames(entry, text, isNew) : [...entry.exports, path.basename(entry.file)];
      if (!missing.length) continue;
      const names = [...entry.exports, ...(entry.signatures ?? [])].join(", ");
      invented.push(`${entry.file}: ${names}${text ? ` (not found in ${entry.source}: ${missing.join(", ")})` : ""}`);
    }
    if (!invented.length) return [];
    const proposal = invented.join("\n");
    const accept = "Accept the proposed names";
    const answer = await ask(ctx, "interface", `Proposed names (nobody defines them):\n${proposal}`, [accept]);
    const decision: Decision = { id: "i1", question: "Interface names", options: [accept], status: "decided", answer: answer === accept ? proposal : answer };
    pending.push({ decision, adr: { title: `Interface for ${task.title}`, context: `${task.title}\n\n${params.summary}`, decision: decision.answer! } });
    return [decision];
  };

  /** A decision is settled when its source is a project file that is about the question; otherwise the user answers. */
  const askDecisions = async (ctx: any, root: string, task: Task, params: PlanParams, pending: PendingAdr[]): Promise<Decision[]> => {
    const out: Decision[] = [];
    for (const [i, d] of params.decisions.entries()) {
      const file = d.source?.split("#")[0];
      const base = { id: `d${i + 1}`, question: d.question, options: d.options };
      if (file && relatesTo(d.question, await readInside(root, file))) {
        out.push({ ...base, status: "documented", source: d.source });
        continue;
      }
      const decision: Decision = { ...base, status: "decided", answer: await ask(ctx, "decision", d.question, d.options) };
      pending.push({ decision, adr: { title: d.question, context: `${task.title}\n\n${params.summary}`, decision: decision.answer! } });
      out.push(decision);
    }
    // Questions the planner already put to the user through ask_user are decisions too.
    const listed = new Set(params.decisions.map((d) => d.question));
    for (const a of asked.values()) {
      if (listed.has(a.question)) continue;
      const decision: Decision = { id: `d${out.length + 1}`, question: a.question, options: a.options, status: "decided", answer: a.answer };
      pending.push({ decision, adr: { title: a.question, context: `${task.title}\n\n${params.summary}`, decision: a.answer } });
      out.push(decision);
    }
    return out;
  };

  /** One short strong-model read of the plan: cheaper than reviewing the diff it produces, and it fixes names before they exist. */
  const runPlanCheck = async (ctx: any, root: string, task: Task, plan: Plan, evidence: string, manifest: Manifest, signal?: AbortSignal) => {
    const checker = manifest.models?.review ?? manifest.models?.setup;
    if (!checker || !planCheckWanted(manifest, plan.files) || (task.planChecks ?? 0) >= MAX_PLAN_CHECKS) return;
    await updateTask(root, (t) => void (t.planChecks = (t.planChecks ?? 0) + 1));
    ctx.ui.setStatus("plan-check", `checking the plan with ${checker}…`);
    const t0 = Date.now();
    const check = await checkPlan(pi.exec.bind(pi), root, task, plan, evidence, checker, signal).finally(() => ctx.ui.setStatus("plan-check", undefined));
    pi.events.emit(REVIEW_EVENT, { root, status: PLAN_STATUS[check.status], model: checker, seconds: (Date.now() - t0) / 1000, cost: check.cost } satisfies ReviewPayload);
    if (check.status === "skipped") ctx.ui.notify(`Plan check skipped: ${check.report}`, "warning");
    else if (check.status === "fix") {
      ctx.ui.notify("Plan check: changes requested. The agent fixes the plan.", "warning");
      throw new Error(`A senior review of the plan found problems. Apply these fixes (or justify in the summary why not) and call task_plan again:\n\n${check.report}`);
    } else ctx.ui.notify("Plan check: OK.", "info");
  };

  /** Fast path: a small plan with no risk trigger already passed the same deterministic gates; the dialog adds only cost. */
  const approve = async (ctx: any, plan: Plan, manifest: Manifest) => {
    const risk = planRiskReasons(plan, manifest);
    if (!risk.length) return void ctx.ui.notify(`Small plan, gates passed: no approval needed.\n\n${planText(plan)}`, "info");
    ctx.ui.notify(`Plan needs your approval: ${risk.join("; ")}.`, "info");
    if (await ctx.ui.confirm("Approve the plan?", planText(plan))) return;
    const feedback = await ctx.ui.input("What should change?");
    throw new Error(`The user did not approve the plan. Feedback: ${feedback || "(none)"}. Revise it and call task_plan again.`);
  };

  pi.registerCommand("task", {
    description: "Start a task: the agent investigates and proposes a plan, you approve it",
    handler: async (args, ctx) => {
      const root = ctx.cwd;
      const arg = args.trim();
      const active = await readTask(root);
      if (!arg) return ctx.ui.notify(active ? `${active.title} (${active.status})` : "No active task. Use /task <description or ticket>.", "info");
      if (arg === "cancel") {
        if (!active) return ctx.ui.notify("No active task to cancel.", "info");
        await writeTask(root, undefined);
        return ctx.ui.notify("Task cancelled.", "info");
      }
      const manifest = await readManifest(root);
      if (manifest.setup !== "done") return ctx.ui.notify("Run /setup first.", "error");

      if (active && active.status !== "done") {
        const choice = await ctx.ui.select(`A task is already active: ${active.title}`, ["Continue it", "Replace it", "Cancel"]);
        if (choice === "Continue it") {
          if (active.status === "planning") return start(ctx, manifest, active);
          return ctx.ui.notify(`The task is already ${active.status}: keep working in the session.`, "info");
        }
        if (choice !== "Replace it") return;
      }

      const ticket = TICKET.test(arg) ? arg : undefined;
      const spec = await specFiles(root, arg);
      const task: Task = { id: `t${Date.now()}`, title: arg, ticket, status: "planning", allowedExtra: [], startedAt: new Date().toISOString(), ...(spec.length && { spec }) };
      await writeTask(root, task);
      await start(ctx, manifest, task);
    },
  });

  pi.registerTool({
    name: "task_plan",
    label: "Task plan",
    description: "Submit the plan for the active task. Code resolves undocumented decisions with the user and asks for approval. Call it once exploration is done.",
    parameters: Type.Object({
      summary: Type.String(),
      steps: Type.Array(Type.String(), { minItems: 1 }),
      files: Type.Array(Type.String(), { description: "Repo-relative files to create or change; directories end with /" }),
      decisions: Type.Array(
        Type.Object({
          question: Type.String(),
          options: Type.Array(Type.String(), { minItems: 2, maxItems: 4, description: "Recommended first" }),
          source: Type.Optional(Type.String({ description: "ADR/doc/skill path that already settles it, optionally path#section" })),
        }),
        { description: "Only choices still open: what the user answered through ask_user is recorded already" },
      ),
      interface: Type.Array(
        Type.Object({
          file: Type.String(),
          exports: Type.Array(Type.String()),
          signatures: Type.Optional(Type.Array(Type.String())),
          source: Type.Optional(Type.String({ description: '"ticket", a doc/GLOSSARY.md/existing file path that gives the names, or "user" when nobody gave them. The names must appear literally in that source.' })),
        }),
        { description: "File and export names the tests will import. May be [] only when no file in `files` is new" },
      ),
      seams: Type.Array(
        Type.Object({
          name: Type.String(),
          testFile: Type.String({ description: "Must be in `files`" }),
          catches: Type.String(),
          misses: Type.Optional(Type.String()),
        }),
        { minItems: 1 },
      ),
    }),
    exposure: "model-only",
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      const root = ctx.cwd;
      const task = await readTask(root);
      if (task?.status !== "planning") throw new Error("No task is being planned. The user starts one with /task.");

      await checkShape(root, params);
      const evidence = await evidenceFor(root, task);
      const pending: PendingAdr[] = [];
      const decisions = [...(await askInterface(ctx, root, task, params, evidence, pending)), ...(await askDecisions(ctx, root, task, params, pending))];
      const plan: Plan = { summary: params.summary, steps: params.steps, files: params.files, decisions, interface: params.interface, seams: params.seams };

      const manifest = await readManifest(root);
      await runPlanCheck(ctx, root, task, plan, evidence, manifest, signal);
      await approve(ctx, plan, manifest);

      for (const { decision, adr } of pending) decision.source = await writeAdr(root, adr);
      const baseCommit = task.baseCommit ?? (await gitHead(pi.exec.bind(pi), root));
      await updateTask(root, (t) => {
        t.plan = plan;
        t.status = "implementing";
        if (baseCommit) t.baseCommit = baseCommit;
      });
      ticketText.delete(root);
      const decided = plan.decisions.filter((d) => d.answer).map((d) => `- ${d.question} -> ${d.answer}`);
      const settled = decided.length ? `\n\nDecisions already made by the user (do not ask again):\n${decided.join("\n")}` : "";
      // Implementation starts here; skills the plan block already loaded are not sent twice.
      const skills = await skillsBlock(root, "implement", await phaseSkills(root, "plan"));
      return {
        content: [{ type: "text", text: "Plan approved. First write the tests at the agreed seams in the listed test files and run ONLY those test files to see them fail; then implement until they pass. Change only the listed files, use the agreed interface names and follow the decisions (read the ADRs they cite). Do not run the full verify; it runs automatically." + settled + (skills ? `\n\n${skills}` : "") }],
        details: { plan },
      };
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (event.messageType === "user") nudges = 0;
  });
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "ask_user" || (await readTask(ctx.cwd).catch(() => undefined))?.status !== "planning") return;
    const questions = (event.input.questions ?? []) as { question: string; options: string[] }[];
    const given = ((event as any).details?.answers ?? []) as { question: string; answer: string }[];
    // Answers come back in question order; a cancel drops the rest.
    for (const [i, a] of given.entries()) {
      const options = questions[i]?.options ?? [];
      asked.set(a.question, { question: a.question, options, answer: a.answer });
      answers.set(JSON.stringify([a.question, options]), a.answer);
    }
    // A cheap planner otherwise lists the same topics again, reworded, as task_plan decisions.
    if (given.length) return { content: [...event.content, { type: "text" as const, text: "These answers are already recorded as plan decisions. Do not list these topics again in task_plan decisions." }] };
  });
  pi.on("tool_result", async (event, ctx) => {
    if (!event.toolName.startsWith("mcp__")) return;
    const task = await readTask(ctx.cwd).catch(() => undefined);
    if (task?.status !== "planning") return;
    // Only the enabled tracker's tools are ticket evidence; browser or desktop MCP output is not.
    const id = tracker(await readManifest(ctx.cwd).catch(() => ({ connectors: [] }) as any));
    if (!id || !event.toolName.startsWith(`mcp__${id}__`)) return;
    const text = resultText((event as any).content ?? (event as any).result);
    if (!text) return;
    const current = ticketText.get(ctx.cwd) ?? "";
    if (current.length < MAX_TICKET_TEXT) ticketText.set(ctx.cwd, `${current}\n${text}`.slice(0, MAX_TICKET_TEXT));
  });
  let lastText = "";
  pi.on("message_end", async (event) => {
    const message: any = event.message;
    if (message?.role !== "assistant") return;
    const content = message.content;
    lastText = typeof content === "string" ? content : (content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed" || nudges >= MAX_NUDGES) return;
    const [task, manifest] = await Promise.all([readTask(ctx.cwd).catch(() => undefined), readManifest(ctx.cwd).catch(() => undefined)]);
    if (manifest?.setup === "running") return;
    // A run that ends on a plain-text question (last line, last 400 chars) has nobody to answer it in RPC/headless: route it to ask_user.
    const asking = task?.status === "implementing" && /\?\s*$/.test(lastText.trim().slice(-400).split("\n").filter(Boolean).at(-1) ?? "");
    if (task?.status !== "planning" && !asking) return;
    nudges++;
    const content = asking ? QUESTION_NUDGE : TASK_NUDGE;
    return { entries: [{ type: "custom_message", customType: "task-nudge", content, display: false }], continue: true };
  });
}
