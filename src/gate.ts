import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ESCALATE_EVENT, REVIEW_EVENT, VERIFY_EVENT, type EscalatePayload, type ReviewPayload, type VerifyPayload } from "./events.ts";
import type { TaskDonePayload } from "./learn.ts";
import { TASK_DONE_EVENT } from "./learn.ts";
import { readManifest } from "./manifest.ts";
import { restoreModel, switchModel } from "./models.ts";
import { assessRisk } from "./risk.ts";
import { reviewDiff } from "./review.ts";
import { skillsBlock } from "./skills.ts";
import { readTask, updateTask } from "./task-state.ts";
import { formatVerify, isPolicyFailure, runVerify } from "./verify.ts";

const MAX_RETRIES = 3;
const MAX_REVIEWS = 1;
const ESCALATE_AFTER = 3;
const DIAGNOSE_AT = 2;

export function registerGate(pi: ExtensionAPI) {
  let start = "";
  let writes = 0;
  let retries = 0;
  let reviews = 0;
  let failures = 0;
  let escalatedFrom: string | undefined;
  let verified: string | undefined;

  const snapshot = async (cwd: string) => {
    const git = (args: string[]) => pi.exec("git", args, { cwd }).then((r) => r.stdout, () => "");
    const out = [await git(["status", "--porcelain"]), await git(["diff", "HEAD"])].join("\n--\n");
    return createHash("sha1").update(out).digest("hex");
  };
  const verify = async (steps: string[], cwd: string, emit = false) => {
    const t0 = Date.now();
    const result = await runVerify(steps, pi.exec.bind(pi), cwd);
    if (emit) pi.events.emit(VERIFY_EVENT, { root: cwd, ok: result.ok, seconds: (Date.now() - t0) / 1000 } satisfies VerifyPayload);
    return { ok: result.ok, report: formatVerify(result), policy: !result.ok && isPolicyFailure(result) };
  };
  const review = async (cwd: string, task: NonNullable<Awaited<ReturnType<typeof readTask>>>, model: string, signal: AbortSignal) => {
    const t0 = Date.now();
    const result = await reviewDiff(pi.exec.bind(pi), cwd, task, model, signal, await skillsBlock(cwd, "review")).catch((e: any) => ({ status: "skipped" as const, report: String(e?.message ?? e), cost: undefined, cancelled: false }));
    const discarded = signal.aborted || result.cancelled === true;
    pi.events.emit(REVIEW_EVENT, { root: cwd, status: result.status, model, seconds: (Date.now() - t0) / 1000, cost: result.cost, discarded } satisfies ReviewPayload);
    return result;
  };
  const deescalate = async (ctx: any) => {
    const from = escalatedFrom;
    escalatedFrom = undefined;
    failures = 0;
    if (from) await restoreModel(pi, ctx, from);
  };

  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType !== "user") return;
    await deescalate(ctx);
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

    const task = await readTask(ctx.cwd).catch(() => undefined);
    const reviewModel = manifest.models?.review;
    const abort = new AbortController();
    let wanted = task?.status === "implementing" && !!reviewModel && reviews < MAX_REVIEWS;
    if (wanted && reviewModel) {
      const risk = await assessRisk(pi.exec.bind(pi), ctx.cwd, task, manifest);
      if (!risk.review) {
        wanted = false;
        reviews++;
        ctx.ui.notify(`Revisión omitida (bajo riesgo): ${risk.reasons.join("; ") || "diff pequeño y sin zonas sensibles"}`, "info");
        pi.events.emit(REVIEW_EVENT, { root: ctx.cwd, status: "skipped-low-risk", model: reviewModel, seconds: 0, cost: 0 } satisfies ReviewPayload);
      }
    }
    const reviewing = wanted && task && reviewModel ? review(ctx.cwd, task, reviewModel, abort.signal) : undefined;
    if (reviewing) ctx.ui.setStatus("review", `revisando el diff con ${reviewModel}…`);
    const clearStatus = () => ctx.ui.setStatus("review", undefined);
    const { ok, report, policy } = await verify(manifest.verify, ctx.cwd, true);
    if (!ok) {
      // The code will change, so this review is stale: stop its subagent now instead of paying for a verdict nobody uses.
      if (reviewing) {
        abort.abort();
        clearStatus();
      }
      if (retries >= MAX_RETRIES) {
        if (!ctx.hasUI) return deescalate(ctx).then(() => undefined);
        const choice = await ctx.ui.select("La verificación sigue fallando tras varios intentos. ¿Qué hacemos?", ["Seguir intentando", "Dejarlo así"]);
        if (choice !== "Seguir intentando") return deescalate(ctx).then(() => undefined);
      } else retries++;
      if (!policy) failures++;
      const target = manifest.models?.escalate ?? manifest.models?.review ?? manifest.models?.setup;
      if (failures >= ESCALATE_AFTER && !escalatedFrom) {
        const switched = await switchModel(pi, ctx, target);
        if (switched) {
          escalatedFrom = switched.previous;
          ctx.ui.notify(`verify falló ${ESCALATE_AFTER} veces: este intento lo hace ${switched.model}`, "warning");
          pi.events.emit(ESCALATE_EVENT, { root: ctx.cwd, model: switched.model } satisfies EscalatePayload);
        }
      }
      const diagnose = !policy && failures === DIAGNOSE_AT;
      const content = policy
        ? `${report}\n\nThis is an agentlint rule. Fix the code if the finding is right. If it needs an exception, run the agentlint accept command with a specific reason: the user will be asked to approve it.`
        : failures === DIAGNOSE_AT
          ? `${report}\n\n${await skillsBlock(ctx.cwd, "diagnose")}\n\nApply the diagnosing-bugs method to this failure before changing code: reproduce, isolate, state the hypothesis, then fix.`
          : `${report}\n\nFix it, then finish.`;
      const customType = diagnose ? "verify-diagnose" : "verify-gate";
      return { entries: [{ type: "custom_message", customType, content, display: true }], continue: true };
    }

    verified = state;
    await deescalate(ctx);
    if (reviewing) {
      const review = await reviewing.finally(clearStatus);
      if (review.status === "skipped") ctx.ui.notify(`Revisión omitida: ${review.report}`, "warning");
      else ctx.ui.notify(review.status === "approved" ? "Revisión del diff: aprobada." : "Revisión del diff: pidió cambios. El agente los corrige.", review.status === "approved" ? "info" : "warning");
      reviews++;
      // One round: the fixes are checked by verify, not by another paid review.
      if (review.status === "changes") {
        verified = undefined;
        const content = `${review.report}\n\nFix these, then finish.`;
        return { entries: [{ type: "custom_message", customType: "diff-review", content, display: true }], continue: true };
      }
    }
    if (task?.status === "implementing" && ctx.hasUI && (await ctx.ui.confirm("Verificación OK", `¿Terminó la tarea "${task.title}"?`))) {
      const done = await updateTask(ctx.cwd, (t) => {
        t.status = "done";
        t.completedAt = new Date().toISOString();
      });
      pi.events.emit(TASK_DONE_EVENT, { root: ctx.cwd, task: done, hasUI: ctx.hasUI } satisfies TaskDonePayload);
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
