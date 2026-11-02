import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeAdr, type AdrInput } from "./adr.ts";
import { selectOrType } from "./ask.ts";
import { exists, limitsOf } from "./config.ts";
import { missingNames, relatesTo } from "./contract.ts";
import { REVIEW_EVENT, type ReviewPayload } from "./events.ts";
import { relatedTasks } from "./learn.ts";
import { completeTask } from "./gate.ts";
import { restoreModel, usePhaseModel } from "./models.ts";
import { gitHead } from "./git.ts";
import { checkPlan } from "./plan-check.ts";
import { highRiskReasons, minLevelOf, planRiskReasons } from "./risk.ts";
import { phaseSkills, skillsBlock } from "./skills.ts";
import { readManifest, understandingOf, type Manifest } from "./manifest.ts";
import { inFiles, oneLine, readTask, resolveInside, updateTask, writeTask, type Decision, type Plan, type Task } from "./task-state.ts";
import { recordUnderstanding } from "./telemetry.ts";
import { QUESTION_NUDGE, TASK_NUDGE, approachResume, assistantText, endsOnQuestion, taskPrompt } from "./task-prompt.ts";

const MAX_NUDGES = 2; // "call task_plan" / "use ask_user" reminders per user message
const MAX_TICKET_TEXT = 300_000; // characters of tracker output kept as evidence
const START_TIMEOUT = 30_000; // how long /task waits for the planner run to start
// A request that is only a ticket key (`PAY-142`); `PAY-142 add fees` or `UTF-8 handling` is free text.
const TICKET = /^[A-Z][A-Z0-9]+-\d+$/;
const TRACKERS = ["jira", "linear"];
/** What the user can do next with a task: only an implementing one can be called done. */
const nextSteps = (task: Task) =>
  task.status === "planning" ? "/task continue resumes planning, /task cancel drops it." : task.status === "implementing" ? "/task done or /task cancel ends it." : "/task <description or ticket> starts a new one.";
/** Said in the plan, the ADR and the decision when a run with no UI takes the recommended option. */
const WITHOUT_USER = "chosen without the user: no UI, so pi took the recommended option";
// A plan check that did not run is still a plan check: /metrics must not count it as a code review.
const PLAN_STATUS = { ok: "plan-ok", fix: "plan-fix", skipped: "plan-skipped" } as const;
// Doc files named in a request: relative or absolute paths ending in .md/.txt/..., bare or quoted, with prose punctuation around them.
const SPEC_FILE = /(?:^|[\s:(\[`"'])((?:\.{1,2}\/|\/|[\w.-]+\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:md|markdown|txt|rst|adoc))(?=$|[\s:,;.)\]`"'])/g;


const tracker = (manifest: Manifest) => manifest.connectors.find((c) => TRACKERS.includes(c.id))?.id;

/** The plan check costs a model call: off unless `review.always`, `review.plan` true, or the review policy is not "off" and the plan touches high-risk files. `always` beats `never`. */
export function planCheckWanted(manifest: Manifest, files: string[]): boolean {
  const rule = manifest.review;
  if (rule?.always) return true;
  if (rule?.never || rule?.plan === false) return false;
  if (rule?.plan === true) return true;
  return minLevelOf(rule) !== "off" && highRiskReasons(files, rule).length > 0;
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

type PlanParams = Omit<Plan, "decisions" | "intent"> & { intent: string; decisions: { question: string; options: string[]; source?: string }[] };
/** An ADR is only written once the plan passes its gates and is recorded. */
type PendingAdr = { decision: Decision; adr: AdrInput };

const setupRunning = async (root: string) => (await readManifest(root).catch(() => undefined))?.setup === "running";

export function registerTask(pi: ExtensionAPI) {
  let nudges = 0;
  let onStart: (() => void) | undefined;
  pi.on("agent_start", () => {
    onStart?.();
    onStart = undefined;
  });
  /** The user cancelled a planning question: no "call task_plan" nudge until they write again. */
  let paused = false;
  /** The task the answers below belong to: continuing it keeps them. */
  let planning: string | undefined;
  /** The user answered the approach question (open ask_user questions) for that task: continuing it does not ask again. */
  let approached = false;
  /** The prompt /task sent last, and whether the current run is the planner's (that prompt, or the user typing). */
  let plannerPrompt: string | undefined;
  let plannerRun = true;
  /** Prompts other extensions sent (/retro, /setup...): their runs ask their own questions, not the planner's. */
  const otherPrompts = new Set<string>();
  /** A partly answered approach round: what the user answered and the open questions still pending. */
  let approach: { answered: { question: string; answer: string }[]; open: string[] } | undefined;
  /** What the planner read from the tracker (MCP) while planning: the ticket, as evidence for interface names. */
  const ticketText = new Map<string, string>();
  /** Answers already given for a question text, so a task_plan retry does not ask it again. Reset per task. */
  const answers = new Map<string, string>();
  /** What the user answered through ask_user while planning, by question: decisions the plan records. Reset per task. */
  const asked = new Map<string, { question: string; options: string[]; answer: string }>();

  const evidenceFor = async (root: string, task: Task) => {
    const parts = [task.title, ...(task.body ? [task.body] : []), ...(task.ticket ? [task.ticket] : []), ticketText.get(root) ?? ""];
    for (const spec of task.spec ?? []) parts.push(await readInside(root, spec));
    return parts.join("\n");
  };

  const start = async (ctx: any, manifest: Manifest, task: Task) => {
    nudges = 0;
    paused = false;
    // Continuing the task planned in this session keeps its answers and tracker text, and does not ask again for an approach the user gave.
    const resumed = planning === task.id;
    if (!resumed) {
      answers.clear();
      asked.clear();
      ticketText.delete(ctx.cwd);
      approached = false;
      approach = undefined;
      planning = task.id;
    }
    const previous = await usePhaseModel(pi, ctx, "implement");
    if (previous && !task.model) await updateTask(ctx.cwd, (t) => void (t.model = previous));
    plannerPrompt = taskPrompt(task.title, task.ticket, tracker(manifest), await relatedTasks(ctx.cwd, task.body ?? task.title), await skillsBlock(ctx.cwd, "plan"), task.spec, task.body, !approached && understandingOf(manifest) === "plan+end" && ctx.hasUI && (approach ? approachResume(approach.answered, approach.open) : true));
    // sendUserMessage does not wait for the run: idle before it starts would end a print-mode /task (pi -p) before planning.
    const started = new Promise<void>((resolve) => {
      onStart = resolve;
      setTimeout(resolve, START_TIMEOUT).unref();
    });
    pi.sendUserMessage(plannerPrompt);
    await started;
    return ctx.waitForIdle();
  };

  /** The user cancelled a planning question: say how to go on, and hold the plan until they write or run /task continue. */
  const pause = (ctx: any, question: string) => {
    paused = true;
    ctx.ui.notify(`Planning paused at: ${oneLine(question, 80)}. ${nextSteps({ status: "planning" } as Task)}`, "info");
  };

  /** Ask once per question and options; a cancelled dialog pauses the plan. With no UI nobody can answer: the recommended (first) option is taken. */
  const ask = async (ctx: any, what: string, question: string, options: string[]) => {
    const key = JSON.stringify([question, options]);
    const known = answers.get(key);
    if (known !== undefined) return known;
    if (!ctx.hasUI) {
      ctx.ui.notify(`No UI: took "${options[0]}" for: ${oneLine(question, 80)}`, "info");
      answers.set(key, options[0]);
      return options[0];
    }
    const answer = await selectOrType(ctx, question, options);
    if (answer === undefined) {
      pause(ctx, question);
      throw new Error(`The user cancelled the ${what} question, so the plan stops here. Stop and wait for the user.`);
    }
    answers.set(key, answer);
    return answer;
  };

  /** Shape gates: new files need a pinned interface, and every seam's test file must be in the plan. */
  const checkShape = async (root: string, params: PlanParams) => {
    if (!params.intent?.trim()) throw new Error("The plan has no intent. Restate the ticket in your own words (one short paragraph), then call task_plan again.");
    const isNew = async (f: string) => !f.endsWith("/") && !(await exists(path.join(root, f)));
    if (!params.interface.length && (await Promise.all(params.files.map(isNew))).some(Boolean))
      throw new Error("The plan creates new files but interface is empty. Pin the file and export names (cite their source), then call task_plan again.");
    const stray = params.seams.filter((x) => !inFiles(params.files, x.testFile));
    if (stray.length) throw new Error(`Seam test files must be listed in files: ${stray.map((x) => x.testFile).join(", ")}. Fix the plan and call task_plan again.`);
  };

  /**
   * Names are only "given" when the cited source or the ticket (title, body, tracker text, spec files) really contains them; the label alone proves nothing.
   * Names nobody gave are asked once. The accepted names stay in task.json as a decision: no ADR, they are not architecture.
   */
  const askInterface = async (ctx: any, root: string, params: PlanParams, evidence: string): Promise<Decision[]> => {
    const invented: string[] = [];
    for (const entry of params.interface) {
      const file = entry.source && entry.source !== "user" && entry.source !== "ticket" ? entry.source.split("#")[0] : undefined;
      const text = entry.source === "ticket" ? evidence : file ? await readInside(root, file) : "";
      const isNew = !entry.file.endsWith("/") && !(await exists(path.join(root, entry.file)));
      let missing = text ? missingNames(entry, text, isNew) : [...entry.exports, ...(isNew ? [path.basename(entry.file)] : [])];
      if (missing.length && text !== evidence) {
        const notInTicket = new Set(missingNames(entry, evidence, isNew));
        missing = missing.filter((m) => notInTicket.has(m));
      }
      if (!missing.length) continue;
      const names = [...entry.exports, ...(entry.signatures ?? [])].join(", ");
      invented.push(`${entry.file}${names ? `: ${names}` : ""}`);
    }
    if (!invented.length) return [];
    const proposal = invented.join("\n");
    const use = "Use them";
    const answer = await ask(ctx, "interface", `The ticket does not name these. Use them?\n${proposal}`, [use]);
    const chosen = answer === use ? proposal : answer;
    return [{ id: "i1", question: "Interface names", options: [use], status: "decided", answer: ctx.hasUI ? chosen : `${chosen} (${WITHOUT_USER})` }];
  };

  /** A decision is settled when its source is a project file that is about the question; otherwise the user answers. */
  const askDecisions = async (ctx: any, root: string, task: Task, params: PlanParams, pending: PendingAdr[]): Promise<Decision[]> => {
    const out: Decision[] = [];
    for (const d of params.decisions) {
      // A question put through ask_user keeps that answer, even listed again with other options: the loop below records it.
      if (asked.has(d.question)) continue;
      const file = d.source?.split("#")[0];
      const base = { id: `d${out.length + 1}`, question: d.question, options: d.options };
      if (file && relatesTo(d.question, await readInside(root, file))) {
        out.push({ ...base, status: "documented", source: d.source });
        continue;
      }
      const answer = await ask(ctx, "decision", d.question, d.options);
      const decision: Decision = { ...base, status: "decided", answer: ctx.hasUI ? answer : `${answer} (${WITHOUT_USER})` };
      pending.push({ decision, adr: { title: d.question, context: `${task.title}\n\n${params.summary}`, decision: decision.answer! } });
      out.push(decision);
    }
    // Questions the planner already put to the user through ask_user are decisions too.
    for (const a of asked.values()) {
      const decision: Decision = { id: `d${out.length + 1}`, question: a.question, options: a.options, status: "decided", answer: a.answer };
      pending.push({ decision, adr: { title: a.question, context: `${task.title}\n\n${params.summary}`, decision: a.answer } });
      out.push(decision);
    }
    return out;
  };

  /** One short strong-model read of the plan: cheaper than reviewing the diff it produces, and it fixes names before they exist. */
  const runPlanCheck = async (ctx: any, root: string, task: Task, plan: Plan, evidence: string, manifest: Manifest, signal?: AbortSignal) => {
    const checker = manifest.models?.review ?? manifest.models?.setup;
    // Not wanted (or no model to run it): /metrics shows it as plan-skipped, with no cost.
    if (!checker || !planCheckWanted(manifest, plan.files)) return void pi.events?.emit(REVIEW_EVENT, { root, status: PLAN_STATUS.skipped, model: checker ?? "none", seconds: 0 } satisfies ReviewPayload);
    const budget = limitsOf(manifest).planChecks;
    // planChecks 0 turns the check off; a used-up budget keeps the earlier verdict.
    if (!budget) return void pi.events?.emit(REVIEW_EVENT, { root, status: PLAN_STATUS.skipped, model: checker, seconds: 0 } satisfies ReviewPayload);
    if ((task.planChecks ?? 0) >= budget) return;
    ctx.ui.setStatus("plan-check", `checking the plan with ${checker}…`);
    const t0 = Date.now();
    const check = await checkPlan(pi.exec.bind(pi), root, task, plan, evidence, checker, signal).finally(() => ctx.ui.setStatus("plan-check", undefined));
    // A check that did not run (no tmux, a failed child) does not use up the budget.
    if (check.status !== "skipped") await updateTask(root, (t) => void (t.planChecks = (t.planChecks ?? 0) + 1));
    pi.events.emit(REVIEW_EVENT, { root, status: PLAN_STATUS[check.status], model: checker, seconds: (Date.now() - t0) / 1000, cost: check.cost } satisfies ReviewPayload);
    if (check.status === "skipped") ctx.ui.notify(`Plan check skipped: ${check.report}`, "warning");
    else if (check.status === "fix") {
      ctx.ui.notify("Plan check: changes requested. The agent fixes the plan.", "warning");
      throw new Error(`A senior review of the plan found problems. Apply these fixes (or justify in the summary why not) and call task_plan again:\n\n${check.report}`);
    } else ctx.ui.notify("Plan check: OK.", "info");
  };

  /** No approval dialog: the person confirms at the end, with every file written. One line says the plan is in, with its risk reasons; task.json keeps the plan. */
  const announce = (ctx: any, plan: Plan, manifest: Manifest) => {
    const risk = planRiskReasons(plan, manifest);
    const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    ctx.ui.notify(`Plan recorded: ${count(plan.steps.length, "step")}, ${count(plan.files.length, "file")}. Implementing.${risk.length ? ` Risk: ${risk.join("; ")}.` : ""}`, "info");
  };

  pi.registerCommand("task", {
    description: "Start a task: the agent plans and implements it, you confirm the files it wrote at the end. /task alone shows it; /task continue, /task done, /task cancel",
    handler: async (args, ctx) => {
      const root = ctx.cwd;
      const arg = args.trim();
      // An unreadable task file must not block the way out of it.
      let active: Task | undefined;
      try {
        active = await readTask(root);
      } catch (error: any) {
        if (arg !== "cancel") return ctx.ui.notify(`${error.message}. /task cancel removes it.`, "error");
        await writeTask(root, undefined);
        paused = false;
        return ctx.ui.notify("Task cancelled.", "info");
      }
      if (!arg) return ctx.ui.notify(active ? `${oneLine(active.title)} (${active.status}). ${nextSteps(active)}` : "No active task. Use /task <description or ticket>.", "info");
      if (arg === "cancel") {
        if (!active) return ctx.ui.notify("No active task to cancel.", "info");
        await writeTask(root, undefined);
        paused = false;
        await restoreModel(pi, ctx, active.model);
        return ctx.ui.notify("Task cancelled.", "info");
      }
      if (arg === "done") {
        if (active?.status !== "implementing") return ctx.ui.notify(active ? `The task is ${active.status}, so it cannot be marked done yet. ${nextSteps(active)}` : "No active task.", "info");
        // Closing the task during the understanding check skips it.
        if (active.understanding) await recordUnderstanding(root, "skipped", 0);
        await completeTask(pi, ctx);
        return ctx.ui.notify(`Task done: ${oneLine(active.title)}.`, "info");
      }
      const manifest = await readManifest(root);
      if (manifest.setup !== "done") return ctx.ui.notify("Run /setup first.", "error");
      if (arg === "continue") {
        if (active?.status === "planning") return start(ctx, manifest, active);
        return ctx.ui.notify(active?.status === "implementing" ? `The task is implementing: keep working in the session. ${nextSteps(active)}` : "No task to continue. Use /task <description or ticket>.", "info");
      }

      if (active && active.status !== "done") {
        if (!ctx.hasUI) return ctx.ui.notify(`A task is already ${active.status}: ${oneLine(active.title, 80)}. ${nextSteps(active)}`, "error");
        // Only a planning task has something to continue; an implementing one goes on in the session.
        const options = active.status === "planning" ? ["Continue it", "Replace it", "Keep it"] : ["Replace it", "Keep it"];
        const choice = await ctx.ui.select(`A task is already ${active.status}: ${oneLine(active.title, 80)}`, options);
        if (choice === "Continue it") return start(ctx, manifest, active);
        if (choice !== "Replace it") return;
      }

      const ticket = TICKET.test(arg) ? arg : undefined;
      const spec = await specFiles(root, arg);
      // A request that is only a spec file is titled by the file's first line; a long or multi-line one keeps its text in `body`.
      const onlyFile = spec.length === 1 && arg.replace(/^@/, "") === spec[0];
      const title = oneLine(onlyFile ? await readInside(root, spec[0]) : arg) || arg;
      // A replaced task hands on the model to go back to.
      const model = active?.status !== "done" ? active?.model : undefined;
      const task: Task = { id: `t${Date.now()}`, title, ...(!onlyFile && title !== arg && { body: arg }), ticket, status: "planning", allowedExtra: [], startedAt: new Date().toISOString(), ...(spec.length && { spec }), ...(model && { model }) };
      await writeTask(root, task);
      if (ticket && !tracker(manifest))
        ctx.ui.notify(`No tracker is enabled, so the agent sees only "${ticket}". To plan from the ticket: /task cancel, then /task ${ticket} <pasted ticket text>. /setup adds Jira or Linear.`, "warning");
      await start(ctx, manifest, task);
    },
  });

  pi.registerTool({
    name: "task_plan",
    label: "Task plan",
    description: "Submit the plan for the active task. Code resolves undocumented decisions with the user, records the plan and starts implementing. Call it once exploration is done.",
    parameters: Type.Object({
      intent: Type.String({ minLength: 1, description: "The ticket restated in your own words, one short paragraph" }),
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
          usage: Type.Optional(Type.String({ description: 'For callables: the call a test would make, in the ticket\'s words, e.g. slugify("Hello World"). The call only, no assertion.' })),
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
      if (paused) throw new Error("Planning is paused: the user cancelled a question. Stop and wait for the user.");

      await checkShape(root, params);
      const evidence = await evidenceFor(root, task);
      const pending: PendingAdr[] = [];
      const decisions = [...(await askInterface(ctx, root, params, evidence)), ...(await askDecisions(ctx, root, task, params, pending))];
      const plan: Plan = { intent: params.intent, summary: params.summary, steps: params.steps, files: params.files, decisions, interface: params.interface, seams: params.seams };

      const manifest = await readManifest(root);
      await runPlanCheck(ctx, root, task, plan, evidence, manifest, signal);

      const baseCommit = task.baseCommit ?? (await gitHead(pi.exec.bind(pi), root));
      for (const { decision, adr } of pending) decision.source = await writeAdr(root, adr);
      await updateTask(root, (t) => {
        t.plan = plan;
        t.status = "implementing";
        if (baseCommit) t.baseCommit = baseCommit;
      });
      ticketText.delete(root);
      announce(ctx, plan, manifest);
      const decided = plan.decisions.filter((d) => d.answer).map((d) => `- ${d.question} -> ${d.answer}${d.source ? ` (${d.source})` : ""}`);
      const settled = decided.length
        ? `\n\nDecisions already made (do not ask again):\n${decided.join("\n")}\npi wrote an ADR for each one that shows a path. They belong to this change and go in the PR: keep them, do not rewrite or delete them, and do not write ADRs for these yourself.`
        : "";
      // Implementation starts here; skills the plan block already loaded are not sent twice.
      const skills = await skillsBlock(root, "implement", await phaseSkills(root, "plan"));
      return {
        content: [{ type: "text", text: "Plan recorded. First write the tests at the agreed seams in the listed test files and run ONLY those test files to see them fail; then implement until they pass. Change only the listed files, use the agreed interface names and follow the decisions (read the ADRs they cite). Do not change existing tests or the verify configuration (test scripts, verify commands) to make verify pass, unless the ticket asks for it: a failing existing test means the code is wrong. Do not run the full verify; it runs automatically. If the new tests or a service they need cannot run here, keep implementing: verify runs at the end and reports what did not run." + settled + (skills ? `\n\n${skills}` : "") }],
        details: { plan },
      };
    },
  });

  // A paused plan waits for the user: the agent may not open another dialog before they write.
  pi.on("tool_call", async (event, ctx) => {
    if (paused && plannerRun && event.toolName === "ask_user" && !(await setupRunning(ctx.cwd))) return { block: true, reason: "Planning is paused: the user cancelled a question. Stop and wait for the user." };
  });
  pi.on("input", async (event) => {
    if (event.source === "extension" && event.text !== plannerPrompt) otherPrompts.add(event.text);
  });
  pi.on("before_agent_start", async (event) => {
    if (event.messageType !== "user") return;
    nudges = 0;
    // A run another command started (a /retro, say) is not the planner's: it neither pauses nor resumes planning.
    plannerRun = !otherPrompts.delete(event.prompt);
    if (plannerRun) paused = false;
  });
  // A task left open in an earlier session still drives the gates here: say so once.
  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "reload") return;
    const task = await readTask(ctx.cwd).catch(() => undefined);
    if (task && task.status !== "done") ctx.ui.notify(`Task "${oneLine(task.title, 80)}" is ${task.status}: ${nextSteps(task)}`, "info");
  });
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "ask_user" || !plannerRun || (await readTask(ctx.cwd).catch(() => undefined))?.status !== "planning") return;
    // The /setup interview asks through ask_user too, while a task may be open: its rounds are not the planner's.
    if (await setupRunning(ctx.cwd)) return;
    const questions = (event.input.questions ?? []) as { question: string; options?: string[] }[];
    // With no UI nobody answers: pi takes each recommended (first) option, as task_plan does, and the plan records it as chosen without the user.
    if ((event as any).isError && !ctx.hasUI) {
      const closed = questions.filter((q) => q.options?.length);
      for (const q of closed) {
        ctx.ui.notify(`No UI: took "${q.options![0]}" for: ${oneLine(q.question, 80)}`, "info");
        asked.set(q.question, { question: q.question, options: q.options!, answer: `${q.options![0]} (${WITHOUT_USER})` });
        answers.set(JSON.stringify([q.question, q.options]), q.options![0]);
      }
      if (closed.length) return { content: [{ type: "text" as const, text: "No UI, so pi took the first option of each question with options. These are recorded as plan decisions: follow them, and do not list these topics again in task_plan decisions." }], isError: false };
      return;
    }
    const given = ((event as any).details?.answers ?? []) as { question: string; answer: string }[];
    // Answers come back in question order; a cancel drops the rest and pauses the plan.
    if (!(event as any).isError && given.length < questions.length) pause(ctx, questions[given.length].question);
    // The approach round is done only when every open question in it got an answer.
    // A partial round keeps its answers, so continuing asks only the open questions still pending.
    const open = questions.flatMap((q, i) => (q.options ? [] : [i]));
    if (open.length && open.every((i) => i < given.length)) {
      approached = true;
      approach = undefined;
    } else if (open.length) {
      const answered = open.filter((i) => i < given.length).map((i) => ({ question: questions[i].question, answer: given[i].answer }));
      const all = [...(approach?.answered ?? []), ...answered];
      // With nothing answered yet, continuing asks the round from scratch.
      approach = all.length ? { answered: all, open: open.filter((i) => i >= given.length).map((i) => questions[i].question) } : undefined;
    }
    let recorded = 0;
    for (const [i, a] of given.entries()) {
      // An open question asks for the user's reasoning (their approach), not a choice: the plan builds on it, no ADR records it.
      const options = questions[i]?.options;
      if (!options) continue;
      recorded++;
      asked.set(a.question, { question: a.question, options, answer: a.answer });
      answers.set(JSON.stringify([a.question, options]), a.answer);
    }
    // A cheap planner otherwise lists the same topics again, reworded, as task_plan decisions.
    if (recorded) return { content: [...event.content, { type: "text" as const, text: "These answers are already recorded as plan decisions. Do not list these topics again in task_plan decisions." }] };
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
  pi.on("message_end", async (event) => void (lastText = assistantText(event.message) ?? lastText));
  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed" || nudges >= MAX_NUDGES) return;
    const [task, manifest] = await Promise.all([readTask(ctx.cwd).catch(() => undefined), readManifest(ctx.cwd).catch(() => undefined)]);
    if (manifest?.setup === "running") return;
    // A run that ends on a plain-text question (last line, last 400 chars) has nobody to answer it in RPC/print/json: route it to ask_user.
    // In the TUI the person reads it and answers (`hasUI` is true in RPC too, so it is the mode that tells).
    const asking = task?.status === "implementing" && ctx.mode !== "tui" && endsOnQuestion(lastText);
    // While planning, a cancelled question or a plain-text question in the TUI waits for the user: no "call task_plan".
    // Another command's run (a /retro, say) is not the planner's to push on.
    if (task?.status === "planning" && (!plannerRun || paused || (ctx.mode === "tui" && endsOnQuestion(lastText)))) return;
    if (task?.status !== "planning" && !asking) return;
    nudges++;
    const content = asking ? QUESTION_NUDGE : TASK_NUDGE;
    return { entries: [{ type: "custom_message", customType: "task-nudge", content, display: false }], continue: true };
  });
}
