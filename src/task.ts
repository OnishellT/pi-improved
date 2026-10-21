import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeAdr } from "./adr.ts";
import { relatedTasks } from "./learn.ts";
import { usePhaseModel } from "./models.ts";
import { skillsBlock } from "./skills.ts";
import { readManifest, type Manifest } from "./manifest.ts";
import { inScope, readTask, updateTask, writeTask, type Decision, type Task } from "./task-state.ts";
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
    ...(p.interface?.length ? ["", "Interfaz:", ...p.interface.map((i) => `- ${i.file}: ${i.exports.join(", ")}${i.source ? ` (${i.source})` : ""}`)] : []),
    ...(p.seams?.length ? ["", "Seams:", ...p.seams.map((x) => `- ${x.name} → ${x.testFile}: ${x.catches}${x.misses ? ` (no cubre: ${x.misses})` : ""}`)] : []),
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
          pi.sendUserMessage(taskPrompt(active.title, active.ticket, tracker(manifest), await relatedTasks(root, active.title), await skillsBlock(root, "plan")));
          return ctx.waitForIdle();
        }
        if (choice !== "Reemplazarla") return;
      }

      const ticket = TICKET.test(arg) ? arg : undefined;
      const task: Task = { id: `t${Date.now()}`, title: arg, ticket, status: "planning", allowedExtra: [], startedAt: new Date().toISOString() };
      await writeTask(root, task);
      nudges = 0;
      await usePhaseModel(pi, ctx, "implement");
      pi.sendUserMessage(taskPrompt(arg, ticket, tracker(manifest), await relatedTasks(root, arg), await skillsBlock(root, "plan")));
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
      interface: Type.Array(
        Type.Object({
          file: Type.String(),
          exports: Type.Array(Type.String()),
          signatures: Type.Optional(Type.Array(Type.String())),
          source: Type.Optional(Type.String({ description: '"ticket", a doc/GLOSSARY.md/existing file path that gives the names, or "user" when nobody gave them' })),
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

      const decisions: Decision[] = [];
      const invented = [];
      for (const entry of params.interface) {
        const file = entry.source && entry.source !== "user" && entry.source !== "ticket" ? entry.source.split("#")[0] : undefined;
        if (entry.source === "ticket" || (file && (await exists(path.join(root, file))))) continue;
        invented.push(entry);
      }
      if (invented.length) {
        const proposal = invented.map((i) => `${i.file}: ${[...i.exports, ...(i.signatures ?? [])].join(", ")}`).join("\n");
        const question = `Nombres propuestos (nadie los define):\n${proposal}`;
        const accept = "Aceptar los nombres propuestos";
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
      if (!(await ctx.ui.confirm("¿Apruebas el plan?", planText(plan)))) {
        const feedback = await ctx.ui.input("¿Qué hay que cambiar?");
        throw new Error(`The user did not approve the plan. Feedback: ${feedback || "(none)"}. Revise it and call task_plan again.`);
      }

      await updateTask(root, (t) => {
        t.plan = plan;
        t.status = "implementing";
      });
      return {
        content: [{ type: "text", text: "Plan approved. First write the tests at the agreed seams in the listed test files and run ONLY those test files to see them fail; then implement until they pass. Change only the listed files, use the agreed interface names and follow the decisions (read the ADRs they cite). Do not run the full verify; it runs automatically." }],
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
