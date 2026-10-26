import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeAdr } from "./adr.ts";
import { missingNames } from "./contract.ts";
import { REVIEW_EVENT, type ReviewPayload } from "./events.ts";
import { relatedTasks } from "./learn.ts";
import { usePhaseModel } from "./models.ts";
import { checkPlan } from "./plan-check.ts";
import { gitHead, highRiskReasons } from "./risk.ts";
import { skillsBlock } from "./skills.ts";
import { readManifest, type Manifest } from "./manifest.ts";
import { inScope, readTask, updateTask, writeTask, type Decision, type Task } from "./task-state.ts";
import { QUESTION_NUDGE, TASK_NUDGE, planText, taskPrompt } from "./task-prompt.ts";

const MAX_NUDGES = 2;
const MAX_PLAN_CHECKS = 1;
const MAX_TICKET_TEXT = 300_000;
const OTHER = "✏️  Other answer…";
const TICKET = /^[A-Z][A-Z0-9]+-\d+$/;
const TRACKERS = ["jira", "linear"];
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

/** Existing spec files named in a /task request, repo-relative when inside the repo. */
export async function specFiles(root: string, text: string): Promise<string[]> {
  const found: string[] = [];
  for (const m of text.matchAll(SPEC_FILE)) {
    const raw = m[1].replace(/[.,;:]+$/, "");
    const abs = path.resolve(root, raw);
    if (!(await exists(abs)) || found.includes(abs)) continue;
    found.push(abs);
  }
  return found.map((f) => (f.startsWith(`${root}${path.sep}`) ? path.relative(root, f) : f));
}

/** Text content of a tool result (MCP results arrive as content blocks or plain strings). */
const resultText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : "")).join("\n");
  return typeof (content as any)?.text === "string" ? (content as any).text : "";
};

export function registerTask(pi: ExtensionAPI) {
  let nudges = 0;
  /** What the planner read from the tracker (MCP) while planning: the ticket, as evidence for interface names. */
  const ticketText = new Map<string, string>();

  const evidenceFor = async (root: string, task: Task) => {
    const parts = [task.title, ...(task.ticket ? [task.ticket] : [])];
    for (const spec of task.spec ?? []) parts.push(await fs.readFile(path.resolve(root, spec), "utf8").catch(() => ""));
    parts.push(ticketText.get(root) ?? "");
    return parts.join("\n");
  };

  const start = async (ctx: any, manifest: Manifest, task: Task) => {
    nudges = 0;
    ticketText.delete(ctx.cwd);
    await usePhaseModel(pi, ctx, "implement");
    pi.sendUserMessage(taskPrompt(task.title, task.ticket, tracker(manifest), await relatedTasks(ctx.cwd, task.title), await skillsBlock(ctx.cwd, "plan"), task.spec));
    return ctx.waitForIdle();
  };

  pi.registerCommand("task", {
    description: "Start a task: the agent investigates and proposes a plan, you approve it",
    handler: async (args, ctx) => {
      const root = ctx.cwd;
      const arg = args.trim();
      const active = await readTask(root);
      if (!arg) return ctx.ui.notify(active ? `${active.title} (${active.status})` : "No active task. Use /task <description or ticket>.", "info");
      if (arg === "cancel") {
        await writeTask(root, undefined);
        return ctx.ui.notify("Task cancelled.", "info");
      }
      const manifest = await readManifest(root);
      if (manifest.setup !== "done") return ctx.ui.notify("Run /setup first.", "error");

      if (active && active.status !== "done") {
        const choice = await ctx.ui.select(`A task is already active: ${active.title}`, ["Continue it", "Replace it", "Cancel"]);
        if (choice === "Continue it" && active.status === "planning") return start(ctx, manifest, active);
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
    async execute(_id, params, _signal, _update, ctx) {
      const root = ctx.cwd;
      const task = await readTask(root);
      if (task?.status !== "planning") throw new Error("No task is being planned. The user starts one with /task.");

      const isNew = async (f: string) => !f.endsWith("/") && !(await exists(path.join(root, f)));
      if (!params.interface.length && (await Promise.all(params.files.map(isNew))).some(Boolean))
        throw new Error("The plan creates new files but interface is empty. Pin the file and export names (cite their source), then call task_plan again.");
      const scope = { ...task, plan: { files: params.files } } as Task;
      const stray = params.seams.filter((x) => !inScope(scope, x.testFile));
      if (stray.length) throw new Error(`Seam test files must be listed in files: ${stray.map((x) => x.testFile).join(", ")}. Fix the plan and call task_plan again.`);

      // Names are only "given" when the cited source really contains them; the label alone proves nothing.
      const evidence = await evidenceFor(root, task);
      const decisions: Decision[] = [];
      const invented: string[] = [];
      for (const entry of params.interface) {
        const file = entry.source && entry.source !== "user" && entry.source !== "ticket" ? entry.source.split("#")[0] : undefined;
        const text = entry.source === "ticket" ? evidence : file && (await exists(path.join(root, file))) ? await fs.readFile(path.join(root, file), "utf8").catch(() => "") : "";
        const missing = text ? missingNames(entry, text, await isNew(entry.file)) : [...entry.exports, path.basename(entry.file)];
        if (!missing.length) continue;
        const names = [...entry.exports, ...(entry.signatures ?? [])].join(", ");
        invented.push(`${entry.file}: ${names}${text ? ` (not found in ${entry.source}: ${missing.join(", ")})` : ""}`);
      }
      if (invented.length) {
        const proposal = invented.join("\n");
        const question = `Proposed names (nobody defines them):\n${proposal}`;
        const accept = "Accept the proposed names";
        let answer = await ctx.ui.select(question, [accept, OTHER]);
        if (answer === OTHER) answer = await ctx.ui.input(question);
        if (answer === undefined) throw new Error("The user cancelled the interface question, so the plan is not approved. Stop and wait for the user.");
        const decision = answer === accept ? proposal : answer;
        const adr = await writeAdr(root, { title: `Interface for ${task.title}`, context: `${task.title}\n\n${params.summary}`, decision });
        decisions.push({ id: "i1", question: "Interface names", options: [accept], status: "decided", answer: decision, source: adr });
      }
      for (const [i, d] of params.decisions.entries()) {
        const file = d.source?.split("#")[0];
        const base = { id: `d${i + 1}`, question: d.question, options: d.options };
        if (file && (await exists(path.join(root, file)))) {
          decisions.push({ ...base, status: "documented", source: d.source });
          continue;
        }
        let answer = await ctx.ui.select(d.question, [...d.options, OTHER]);
        if (answer === OTHER) answer = await ctx.ui.input(d.question);
        if (answer === undefined) throw new Error("The user cancelled a decision question, so the plan is not approved. Stop and wait for the user.");
        const adr = await writeAdr(root, { title: d.question, context: `${task.title}\n\n${params.summary}`, decision: answer });
        decisions.push({ ...base, status: "decided", answer, source: adr });
      }

      const plan = { summary: params.summary, steps: params.steps, files: params.files, decisions, interface: params.interface, seams: params.seams };

      // One short strong-model read of the plan: cheaper than reviewing the diff it produces, and it fixes names before they exist.
      const manifest = await readManifest(root);
      const checker = manifest.models?.review ?? manifest.models?.setup;
      if (checker && planCheckWanted(manifest, plan.files) && (task.planChecks ?? 0) < MAX_PLAN_CHECKS) {
        await updateTask(root, (t) => void (t.planChecks = (t.planChecks ?? 0) + 1));
        ctx.ui.setStatus("plan-check", `checking the plan with ${checker}…`);
        const t0 = Date.now();
        const check = await checkPlan(pi.exec.bind(pi), root, task, plan, evidence, checker).finally(() => ctx.ui.setStatus("plan-check", undefined));
        pi.events.emit(REVIEW_EVENT, { root, status: check.status === "ok" ? "plan-ok" : check.status === "fix" ? "plan-fix" : "skipped", model: checker, seconds: (Date.now() - t0) / 1000, cost: check.cost } satisfies ReviewPayload);
        if (check.status === "skipped") ctx.ui.notify(`Plan check skipped: ${check.report}`, "warning");
        else if (check.status === "fix") {
          ctx.ui.notify("Plan check: changes requested. The agent fixes the plan.", "warning");
          throw new Error(`A senior review of the plan found problems. Apply these fixes (or justify in the summary why not) and call task_plan again:\n\n${check.report}`);
        } else ctx.ui.notify("Plan check: OK.", "info");
      }

      if (!(await ctx.ui.confirm("Approve the plan?", planText(plan)))) {
        const feedback = await ctx.ui.input("What should change?");
        throw new Error(`The user did not approve the plan. Feedback: ${feedback || "(none)"}. Revise it and call task_plan again.`);
      }

      const baseCommit = task.baseCommit ?? (await gitHead(pi.exec.bind(pi), root));
      await updateTask(root, (t) => {
        t.plan = plan;
        t.status = "implementing";
        if (baseCommit) t.baseCommit = baseCommit;
      });
      ticketText.delete(root);
      const decided = (plan.decisions ?? []).filter((d: any) => d.answer).map((d: any) => `- ${d.question} -> ${d.answer}`);
      const settled = decided.length ? `\n\nDecisions already made by the user (do not ask again):\n${decided.join("\n")}` : "";
      return {
        content: [{ type: "text", text: "Plan approved. First write the tests at the agreed seams in the listed test files and run ONLY those test files to see them fail; then implement until they pass. Change only the listed files, use the agreed interface names and follow the decisions (read the ADRs they cite). Do not run the full verify; it runs automatically." + settled }],
        details: { plan },
      };
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (event.messageType === "user") nudges = 0;
  });
  pi.on("tool_result", async (event, ctx) => {
    if (!/^mcp__/.test(event.toolName)) return;
    const task = await readTask(ctx.cwd).catch(() => undefined);
    if (task?.status !== "planning") return;
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
    // A plain-text question ends the run with nobody to answer it (RPC, headless): route it to ask_user.
    const asking = task?.status === "implementing" && /\?\s*$/.test(lastText.trim().slice(-400).split("\n").filter(Boolean).at(-1) ?? "");
    if (task?.status !== "planning" && !asking) return;
    nudges++;
    const content = asking ? QUESTION_NUDGE : TASK_NUDGE;
    return { entries: [{ type: "custom_message", customType: "task-nudge", content, display: false }], continue: true };
  });
}
