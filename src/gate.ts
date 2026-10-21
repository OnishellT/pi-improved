import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskDonePayload } from "./learn.ts";
import { TASK_DONE_EVENT } from "./learn.ts";
import { readManifest } from "./manifest.ts";
import { reviewDiff } from "./review.ts";
import { readTask, updateTask } from "./task-state.ts";
import { formatVerify, runVerify } from "./verify.ts";

const MAX_RETRIES = 3;
const MAX_REVIEWS = 2;

export function registerGate(pi: ExtensionAPI) {
  let start = "";
  let writes = 0;
  let retries = 0;
  let reviews = 0;
  let verified: string | undefined;

  const snapshot = async (cwd: string) => {
    const git = (args: string[]) => pi.exec("git", args, { cwd }).then((r) => r.stdout, () => "");
    const out = [await git(["status", "--porcelain"]), await git(["diff", "HEAD"])].join("\n--\n");
    return createHash("sha1").update(out).digest("hex");
  };
  const verify = async (steps: string[], cwd: string) => {
    const result = await runVerify(steps, pi.exec.bind(pi), cwd);
    return { ok: result.ok, report: formatVerify(result) };
  };

  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType !== "user") return;
    start = await snapshot(ctx.cwd);
    writes = 0;
    retries = 0;
    reviews = 0;
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName === "write" || event.toolName === "edit") writes++;
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    const manifest = await readManifest(ctx.cwd);
    if (manifest.setup !== "done" || !manifest.verify.length || event.outcome !== "completed") return;
    const now = await snapshot(ctx.cwd);
    if (now === start && !writes) return;
    const state = `${now}:${writes}`;
    if (state === verified) return;

    const { ok, report } = await verify(manifest.verify, ctx.cwd);
    if (!ok) {
      if (retries >= MAX_RETRIES) {
        if (!ctx.hasUI) return;
        const choice = await ctx.ui.select("La verificación sigue fallando tras varios intentos. ¿Qué hacemos?", ["Seguir intentando", "Dejarlo así"]);
        if (choice !== "Seguir intentando") return;
      } else retries++;
      const content = `${report}\n\nFix it, then finish.`;
      return { entries: [{ type: "custom_message", customType: "verify-gate", content, display: true }], continue: true };
    }

    verified = state;
    const task = await readTask(ctx.cwd).catch(() => undefined);
    if (task?.status === "implementing" && manifest.models?.review) {
      ctx.ui.setStatus("review", `revisando el diff con ${manifest.models.review}…`);
      const review = await reviewDiff(pi.exec.bind(pi), ctx.cwd, task, manifest.models.review).finally(() => ctx.ui.setStatus("review", undefined));
      if (review.status === "skipped") ctx.ui.notify(`Revisión omitida: ${review.report}`, "warning");
      else ctx.ui.notify(review.status === "approved" ? "Revisión del diff: aprobada." : "Revisión del diff: pidió cambios. El agente los corrige.", review.status === "approved" ? "info" : "warning");
      if (review.status === "changes") {
        const proceed = reviews < MAX_REVIEWS || (ctx.hasUI && (await ctx.ui.select("La revisión sigue pidiendo cambios. ¿Qué hacemos?", ["Seguir corrigiendo", "Cerrar igual"])) === "Seguir corrigiendo");
        if (proceed) {
          reviews++;
          verified = undefined;
          const content = `${review.report}\n\nFix these, then finish.`;
          return { entries: [{ type: "custom_message", customType: "diff-review", content, display: true }], continue: true };
        }
      }
    }
    if (task?.status === "implementing" && ctx.hasUI && (await ctx.ui.confirm("Verificación OK", `¿Terminó la tarea "${task.title}"?`))) {
      const done = await updateTask(ctx.cwd, (t) => {
        t.status = "done";
        t.completedAt = new Date().toISOString();
      });
      pi.events.emit(TASK_DONE_EVENT, { root: ctx.cwd, task: done } satisfies TaskDonePayload);
    }
  });

  pi.registerCommand("verify", {
    description: "Ejecuta los pasos de verificación del proyecto",
    handler: async (_args, ctx) => {
      const { verify: steps } = await readManifest(ctx.cwd);
      if (!steps.length) return ctx.ui.notify("No hay pasos de verificación configurados.", "warning");
      const { ok, report } = await verify(steps, ctx.cwd);
      ctx.ui.notify(report, ok ? "info" : "error");
    },
  });
}
