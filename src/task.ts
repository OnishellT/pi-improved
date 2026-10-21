import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeAdr } from "./adr.ts";
import { relatedTasks } from "./learn.ts";
import { usePhaseModel } from "./models.ts";
import { readManifest, type Manifest } from "./manifest.ts";
import { readTask, updateTask, writeTask, type Decision, type Task } from "./task-state.ts";
import { QUESTION_NUDGE, TASK_NUDGE, taskPrompt } from "./task-prompt.ts";

const MAX_NUDGES = 2;
const OTHER = "✏️  Otra respuesta…";
const TICKET = /^[A-Z][A-Z0-9]+-\d+$/;
const TRACKERS = ["jira", "linear"];

const exists = (file: string) => fs.access(file).then(() => true, () => false);

const planText = (p: NonNullable<Task["plan"]>) =>
  [
    p.summary,
    "",
    "Pasos:",
    ...p.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "Archivos:",
    ...p.files.map((f) => `- ${f}`),
    ...(p.decisions.length ? ["", "Decisiones:", ...p.decisions.map((d) => `- ${d.question} → ${d.answer ?? `ver ${d.source}`}`)] : []),
  ].join("\n");

const tracker = (manifest: Manifest) => manifest.connectors.find((c) => TRACKERS.includes(c.id))?.id;

export function registerTask(pi: ExtensionAPI) {
  let nudges = 0;

  pi.registerCommand("task", {
    description: "Empieza una tarea: el agente investiga, propone un plan y tú lo apruebas",
    handler: async (args, ctx) => {
      const root = ctx.cwd;
      const arg = args.trim();
      const active = await readTask(root);
      if (!arg) return ctx.ui.notify(active ? `${active.title} (${active.status})` : "No hay tarea activa. Usa /task <descripción o ticket>.", "info");
      if (arg === "cancel") {
        await writeTask(root, undefined);
        return ctx.ui.notify("Tarea cancelada.", "info");
      }
      const manifest = await readManifest(root);
      if (manifest.setup !== "done") return ctx.ui.notify("Primero corre /setup.", "error");

      if (active && active.status !== "done") {
        const choice = await ctx.ui.select(`Ya hay una tarea activa: ${active.title}`, ["Continuarla", "Reemplazarla", "Cancelar"]);
        if (choice === "Continuarla" && active.status === "planning") {
          nudges = 0;
          await usePhaseModel(pi, ctx, "implement");
          pi.sendUserMessage(taskPrompt(active.title, active.ticket, tracker(manifest), await relatedTasks(root, active.title)));
          return ctx.waitForIdle();
        }
        if (choice !== "Reemplazarla") return;
      }

      const ticket = TICKET.test(arg) ? arg : undefined;
      const task: Task = { id: `t${Date.now()}`, title: arg, ticket, status: "planning", allowedExtra: [], startedAt: new Date().toISOString() };
      await writeTask(root, task);
      nudges = 0;
      await usePhaseModel(pi, ctx, "implement");
      pi.sendUserMessage(taskPrompt(arg, ticket, tracker(manifest), await relatedTasks(root, arg)));
      await ctx.waitForIdle();
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
    }),
    exposure: "model-only",
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      const root = ctx.cwd;
      const task = await readTask(root);
      if (task?.status !== "planning") throw new Error("No task is being planned. The user starts one with /task.");

      const decisions: Decision[] = [];
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

      const plan = { summary: params.summary, steps: params.steps, files: params.files, decisions };
      if (!(await ctx.ui.confirm("¿Apruebas el plan?", planText(plan)))) {
        const feedback = await ctx.ui.input("¿Qué hay que cambiar?");
        throw new Error(`The user did not approve the plan. Feedback: ${feedback || "(none)"}. Revise it and call task_plan again.`);
      }

      await updateTask(root, (t) => {
        t.plan = plan;
        t.status = "implementing";
      });
      return {
        content: [{ type: "text", text: "Plan approved. Implement it now: change only the listed files, follow the decisions (read the ADRs they cite), and do not run verify yourself; it runs automatically at the end." }],
        details: { plan },
      };
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (event.messageType === "user") nudges = 0;
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
