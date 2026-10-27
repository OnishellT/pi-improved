import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ESCALATE_EVENT, REVIEW_EVENT, TASK_DONE_EVENT, VERIFY_EVENT, type EscalatePayload, type ReviewPayload, type TaskDonePayload, type VerifyPayload } from "./events.ts";
import { checkContract, formatContract } from "./contract.ts";
import { git } from "./git.ts";
import { readManifest } from "./manifest.ts";
import { restoreModel, switchModel } from "./models.ts";
import { assessRisk } from "./risk.ts";
import { resolvePolicyFailure } from "./policy.ts";
import { reviewDiff } from "./review.ts";
import { skillsBlock } from "./skills.ts";
import { readTask, updateTask } from "./task-state.ts";
import { formatVerify, isPolicyFailure, runVerify, validCap } from "./verify.ts";

const MAX_RETRIES = 2;
const MAX_REVIEWS = 1;
// The 2nd failed verify diagnoses the bug and hands the attempt to the stronger model.
const FAILURES_BEFORE_ESCALATION = 2;

export function registerGate(pi: ExtensionAPI) {
  let start = "";
  let writes = 0;
  let retries = 0;
  let contractRetries = 0;
  let reviews = 0;
  let failures = 0;
  let escalatedFrom: string | undefined;
  let verified: string | undefined;
  let policyRepeats = 0;
  let warnedNoReviewModel = false;

  const snapshot = async (cwd: string) => {
    const run = async (args: string[]) => (await git(pi.exec.bind(pi), cwd, args)) ?? "";
    const out = [await run(["status", "--porcelain"]), await run(["diff", "HEAD"])].join("\n--\n");
    return createHash("sha1").update(out).digest("hex");
  };
  const verify = async (steps: string[], cwd: string, maxReport: unknown, emit = false) => {
    const t0 = Date.now();
    const result = await runVerify(steps, pi.exec.bind(pi), cwd, undefined, validCap(maxReport));
    if (emit) pi.events.emit(VERIFY_EVENT, { root: cwd, ok: result.ok, seconds: (Date.now() - t0) / 1000 } satisfies VerifyPayload);
    return { ok: result.ok, report: formatVerify(result), policy: !result.ok && isPolicyFailure(result) };
  };
  const review = async (cwd: string, task: NonNullable<Awaited<ReturnType<typeof readTask>>>, model: string, signal: AbortSignal) => {
    const t0 = Date.now();
    const result = await reviewDiff(pi.exec.bind(pi), cwd, task, model, signal, await skillsBlock(cwd, "review"));
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
    contractRetries = 0;
    reviews = 0;
    policyRepeats = 0;
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName === "write" || event.toolName === "edit") writes++;
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    const manifest = await readManifest(ctx.cwd).catch(() => undefined);
    if (!manifest || manifest.setup !== "done" || !manifest.verify.length || event.outcome !== "completed") return;
    const now = await snapshot(ctx.cwd);
    if (now === start && !writes) return;
    const state = `${now}:${writes}`;
    if (state === verified) return;

    const task = await readTask(ctx.cwd).catch(() => undefined);
    // The pinned names are a contract: check them before spending verify time or a paid review on code that misses them.
    if (task?.status === "implementing" && task.plan && contractRetries < MAX_RETRIES) {
      const problems = await checkContract(ctx.cwd, task.plan);
      if (problems.length) {
        contractRetries++;
        return { entries: [{ type: "custom_message", customType: "contract-gate", content: `${formatContract(problems)}\n\nExpose exactly these names in these files (the plan's interface), then finish.`, display: true }], continue: true };
      }
    }
    const reviewModel = manifest.models?.review;
    const abort = new AbortController();
    let wanted = task?.status === "implementing" && !!reviewModel && reviews < MAX_REVIEWS;
    // The level is measured and reported (except under review.always/never, which short-circuit); whether it asks for a model review is the manifest's policy.
    const risk = task?.status === "implementing" ? await assessRisk(pi.exec.bind(pi), ctx.cwd, task, manifest) : undefined;
    if (wanted && reviewModel && risk) {
      if (!risk.review) {
        wanted = false;
        reviews++;
        ctx.ui.notify(`Review skipped (risk ${risk.level}): ${risk.reasons.join("; ") || "small diff outside sensitive areas"}`, "info");
        pi.events.emit(REVIEW_EVENT, { root: ctx.cwd, status: "skipped-low-risk", model: reviewModel, seconds: 0, cost: 0 } satisfies ReviewPayload);
      }
    }
    // A review the policy asks for cannot run without a model: say so once instead of skipping silently.
    if (task?.status === "implementing" && !reviewModel && risk?.review && !warnedNoReviewModel) {
      warnedNoReviewModel = true;
      ctx.ui.notify("The review policy asks for a review, but it needs models.review in .pi/workflow.json.", "warning");
    }
    const reviewing = wanted && task && reviewModel ? review(ctx.cwd, task, reviewModel, abort.signal) : undefined;
    if (reviewing) ctx.ui.setStatus("review", `reviewing the diff with ${reviewModel}…`);
    const clearStatus = () => ctx.ui.setStatus("review", undefined);
    const { ok, report, policy } = await verify(manifest.verify, ctx.cwd, manifest.maxReport, true);
    if (!ok) {
      // The code will change, so this review is stale: stop its subagent now instead of paying for a verdict nobody uses.
      if (reviewing) {
        abort.abort();
        clearStatus();
      }
      // The model gets one chance to fix an agentlint finding; after that only the user can decide, so ask them instead of looping.
      if (policy && ctx.hasUI && policyRepeats++ >= 1) {
        const outcome = await resolvePolicyFailure(pi, ctx, manifest, report);
        if (outcome === "stop") return deescalate(ctx).then(() => undefined);
        if (outcome === "approved") {
          const content = "The user approved the agentlint exception and it is recorded. Do not change the code: finish so verify runs again.";
          return { entries: [{ type: "custom_message", customType: "verify-gate", content, display: true }], continue: true };
        }
        if (outcome === "failed") ctx.ui.notify("Could not record the agentlint exception. The model continues.", "warning");
      }
      if (retries >= MAX_RETRIES) {
        if (!ctx.hasUI) return deescalate(ctx).then(() => undefined);
        const choice = await ctx.ui.select("Verification still fails after several attempts. What now?", ["Keep trying", "Leave it as is"]);
        if (choice !== "Keep trying") return deescalate(ctx).then(() => undefined);
      } else retries++;
      if (!policy) failures++;
      const target = manifest.models?.escalate ?? manifest.models?.review ?? manifest.models?.setup;
      if (failures >= FAILURES_BEFORE_ESCALATION && !escalatedFrom) {
        const switched = await switchModel(pi, ctx, target);
        if (switched) {
          escalatedFrom = switched.previous;
          ctx.ui.notify(`verify failed ${FAILURES_BEFORE_ESCALATION} times: ${switched.model} takes this attempt`, "warning");
          pi.events.emit(ESCALATE_EVENT, { root: ctx.cwd, model: switched.model } satisfies EscalatePayload);
        }
      }
      const diagnose = !policy && failures === FAILURES_BEFORE_ESCALATION;
      const content = policy
        ? `${report}\n\nThis is an agentlint rule. Fix the code if the finding is right. If it needs an exception, finish again as is: the user will be asked to approve it.`
        : diagnose
          ? `${report}\n\n${await skillsBlock(ctx.cwd, "diagnose")}\n\nApply the diagnosing-bugs method to this failure before changing code: reproduce, isolate, state the hypothesis, then fix.`
          : `${report}\n\nFix it, then finish.`;
      const customType = diagnose ? "verify-diagnose" : "verify-gate";
      return { entries: [{ type: "custom_message", customType, content, display: true }], continue: true };
    }

    verified = state;
    await deescalate(ctx);
    if (risk) ctx.ui.notify(`Risk ${risk.level}${risk.reasons.length ? `: ${risk.reasons.join("; ")}` : ""}${reviewing ? " (review requested)" : !risk.review ? " (review not requested)" : reviewModel ? " (already reviewed)" : " (no review model)"}`, "info");
    if (reviewing) {
      const review = await reviewing.finally(clearStatus);
      if (review.status === "skipped") ctx.ui.notify(`Review skipped: ${review.report}`, "warning");
      else ctx.ui.notify(review.status === "approved" ? "Diff review: approved." : "Diff review: changes requested. The agent fixes them.", review.status === "approved" ? "info" : "warning");
      reviews++;
      // One round: the fixes are checked by verify, not by another paid review.
      if (review.status === "changes") {
        verified = undefined;
        const content = `${review.report}\n\nFix these, then finish.`;
        return { entries: [{ type: "custom_message", customType: "diff-review", content, display: true }], continue: true };
      }
    }
    if (task?.status === "implementing" && ctx.hasUI && (await ctx.ui.confirm("Verification OK", `Is the task "${task.title}" done?`))) {
      const done = await updateTask(ctx.cwd, (t) => {
        t.status = "done";
        t.completedAt = new Date().toISOString();
      });
      pi.events.emit(TASK_DONE_EVENT, { root: ctx.cwd, task: done, hasUI: ctx.hasUI } satisfies TaskDonePayload);
    }
  });

  pi.registerCommand("verify", {
    description: "Run the project's verification steps",
    handler: async (_args, ctx) => {
      const { verify: steps, maxReport } = await readManifest(ctx.cwd);
      if (!steps.length) return ctx.ui.notify("No verification steps configured.", "warning");
      const { ok, report } = await verify(steps, ctx.cwd, maxReport);
      ctx.ui.notify(report, ok ? "info" : "error");
    },
  });
}
