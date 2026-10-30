import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ESCALATE_EVENT, REVIEW_EVENT, TASK_DONE_EVENT, UNDERSTANDING_EVENT, VERIFY_EVENT, type EscalatePayload, type ReviewPayload, type TaskDonePayload, type UnderstandingPayload, type VerifyPayload } from "./events.ts";
import { checkContract, formatContract } from "./contract.ts";
import { limitsOf } from "./config.ts";
import { git } from "./git.ts";
import { readManifest, understandingOf, type Manifest } from "./manifest.ts";
import { restoreModel, switchModel } from "./models.ts";
import { assessRisk, minLevelOf } from "./risk.ts";
import { checkAcceptances } from "./guards.ts";
import { resolvePolicyFailure } from "./policy.ts";
import { reviewDiff } from "./review.ts";
import { skillsBlock, skillsDir } from "./skills.ts";
import { assistantText, endsOnQuestion, understandingCheck } from "./task-prompt.ts";
import { oneLine, readTask, updateTask, type Task } from "./task-state.ts";
import { type Signature, failureSignature, agentlintStepOf, verifySteps, formatVerify, infraFailure, isPolicyFailure, runVerify, sameFailure, validCap } from "./verify.ts";

export const UNREADABLE = "unreadable";
const MAX_REVIEWS = 1;
const PROGRESS_TIMEOUT = 60_000;
/** A progress run of the first verify command that takes this long, or times out, turns progress checks off for the rest of the task. */
const PROGRESS_MAX_SECONDS = 30;
const PROGRESS_TAIL = 1200;
const TOUCHED_SHOWN = 10;
/** The dialog lists what could have turned verify green or slipped past it, so the person sees it before accepting. */
const listNote = (title: string, items: string[] = []) =>
  items.length ? `\n\n${title}:\n${items.slice(0, TOUCHED_SHOWN).map((f) => `- ${f}`).join("\n")}${items.length > TOUCHED_SHOWN ? `\n- and ${items.length - TOUCHED_SHOWN} more` : ""}` : "";
const dialogNotes = (risk?: { touched?: string[]; flagged?: string[] }) => `${listNote("Tests and verify setup changed (check before accepting)", risk?.touched)}${listNote("Quality check (look before accepting)", risk?.flagged)}`;
/** Added to the escalation prompt when the same failure came back: the fixes so far share a wrong assumption. */
const PREMISE = [
  "The same failure came back after a fix, so every fix so far assumed something false. Write that one premise in a sentence.",
  "Name an observation that would contradict it (a value, a log line, a file's content), then check it by reading, grepping or running before you touch code.",
  "If the premise is wrong, start again from what you observed.",
].join("\n");
/** Verify no longer runs before the change, so a failure may be old. */
const UNTOUCHED = "A failure in code the change did not touch may already have been there: do not fix it outside the plan; report it to the user at the end.";
/** What the model hears after a failed verify. The premise lines go with any failure from the escalation point on that repeats the last one. */
async function advice(cwd: string, report: string, kind: "policy" | "diagnose" | "fix", premise: boolean, agentlint = "agentlint") {
  if (kind === "policy")
    return `${report}\n\nThis is an agentlint rule. Fix the code if the finding is right. If the code is right as it is, run \`${agentlint} propose <selector> --summary "<why>"\` (selector from \`next --format json\`) so the user sees your reason, then finish again as is: the user will be asked to approve it.`;
  const head = kind === "diagnose" ? `${report}\n\n${await skillsBlock(cwd, "diagnose")}\n\nApply the diagnosing-bugs method to this failure before changing code: reproduce, isolate, state the hypothesis, then fix.` : `${report}\n\nFix it, then finish.`;
  return premise ? `${head} ${UNTOUCHED}\n\n${PREMISE}` : `${head} ${UNTOUCHED}`;
}
// `limits.verifyRetries` and `limits.failuresBeforeEscalation` (config.ts) set the retries and when the failed verify diagnoses the bug and hands the attempt to the stronger model.

/** A hash of the working tree and HEAD; UNREADABLE when git could not take it. */
export async function treeSnapshot(pi: ExtensionAPI, cwd: string) {
  const exec = pi.exec.bind(pi);
  // `git diff` leaves out untracked files: their contents count too, or editing one would look like no change.
  const untracked = (await git(exec, cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))?.split("\0").filter(Boolean);
  // lstat's ctime: any write or chmod moves it and no tool can set it back; nothing is read (a large file costs nothing, a dangling link is fine).
  const contents = await Promise.all((untracked ?? []).map((f) => fs.lstat(path.join(cwd, f)).then((st) => `${f} ${st.mode} ${st.size} ${st.ctimeMs}`)))
    .then((h) => (untracked ? h.join("\n") : undefined), () => undefined);
  const parts = [await git(exec, cwd, ["status", "--porcelain"]), await git(exec, cwd, ["diff", "HEAD"]), await git(exec, cwd, ["rev-parse", "HEAD"]), contents];
  // A snapshot git could not take (no Nix, no repository) is never equal to another: the work counts as changed, and verify says what is wrong.
  if (parts.some((p) => p === undefined)) return UNREADABLE;
  // HEAD is part of it: a change committed through bash leaves the tree clean, and that is still a change.
  return createHash("sha1").update(parts.join("\n--\n")).digest("hex");
}

/** Marks the active task done: learn records it, and the model /task switched away from comes back. */
export async function completeTask(pi: ExtensionAPI, ctx: any): Promise<Task> {
  const done = await updateTask(ctx.cwd, (t) => {
    t.status = "done";
    t.completedAt = new Date().toISOString();
  });
  pi.events.emit(TASK_DONE_EVENT, { root: ctx.cwd, task: done, hasUI: ctx.hasUI } satisfies TaskDonePayload);
  await restoreModel(pi, ctx, done.model);
  return done;
}

export function registerGate(pi: ExtensionAPI) {
  let start = "";
  let writes = 0;
  let retries = 0;
  let contractRetries = 0;
  let reviews = 0;
  // The working copy each task was last reviewed at: `reviews` resets every turn, and the same diff is never paid for twice.
  const reviewed = new Map<string, string>();
  let failures = 0;
  let escalatedFrom: string | undefined;
  let escalatedTo: string | undefined;
  let verified: string | undefined;
  let policyRepeats = 0;
  let lastSignature: Signature | undefined;
  let repeats = 0;
  let sinceCheck = 0;
  let skip: ReviewPayload | undefined;
  let warnedNoReviewModel = false;
  let lastText = "";
  // A TUI turn that ends on a question waits for the answer once; the next turn always runs the gate.
  let deferred = false;
  pi.on("message_end", async (event) => void (lastText = assistantText(event.message) ?? lastText));

  const snapshot = (cwd: string) => treeSnapshot(pi, cwd);
  const checkPending = async (cwd: string, now: string) => {
    const t = await readTask(cwd).catch(() => undefined);
    return t?.status === "implementing" && t.understanding !== undefined && t.understanding.tree !== now;
  };
  const verify = async (manifest: Manifest, cwd: string) => {
    const t0 = Date.now();
    const isAgentlint = agentlintStepOf(manifest);
    const result = await runVerify(verifySteps(manifest), pi.exec.bind(pi), cwd, undefined, validCap(manifest.maxReport));
    return { ok: result.ok, report: formatVerify(result), infra: infraFailure(result), policy: !result.ok && isPolicyFailure(result, isAgentlint), signature: failureSignature(result), seconds: (Date.now() - t0) / 1000 };
  };
  const emitVerify = (payload: Omit<VerifyPayload, "kind"> & { kind?: VerifyPayload["kind"] }) => void pi.events?.emit(VERIFY_EVENT, { kind: "gate", ...payload } satisfies VerifyPayload);
  /** Every `limits.verifyEvery` writes while implementing: the first verify command's result, to append to that tool result. Off for the task once a run is slow or times out. */
  const progress = async (cwd: string) => {
    const manifest = await readManifest(cwd).catch(() => undefined);
    const every = limitsOf(manifest).verifyEvery;
    if (!manifest || manifest.setup !== "done" || !manifest.verify.length || !every) return;
    const task = await readTask(cwd).catch(() => undefined);
    if (task?.status !== "implementing" || task.progressOff) return;
    if (++sinceCheck < every) return;
    sinceCheck = 0;
    const step = manifest.verify[0];
    const t0 = Date.now();
    const result = await runVerify([step], pi.exec.bind(pi), cwd, PROGRESS_TIMEOUT, validCap(manifest.maxReport));
    const seconds = (Date.now() - t0) / 1000;
    const slow = seconds >= PROGRESS_MAX_SECONDS || !!result.results[0].killed;
    // A slow run that could not run the check (Nix still building) would cost the same time again: it turns the check off too.
    if (slow) await updateTask(cwd, (t) => void (t.progressOff = true));
    if (infraFailure(result)) return slow ? `Progress check off: \`${step}\` could not run after ${Math.round(seconds)} s (${oneLine(infraFailure(result)!, 120)}). Run the tests you are working on yourself; verify runs when you finish.` : undefined;
    emitVerify({ root: cwd, kind: "progress", ok: result.ok, seconds });
    if (slow) {
      const took = result.results[0].killed ? `timed out after ${PROGRESS_TIMEOUT / 1000} s` : `took ${Math.round(seconds)} s, over ${PROGRESS_MAX_SECONDS} s`;
      return `Progress check off: \`${step}\` ${took}. Run the tests you are working on yourself; verify runs when you finish.`;
    }
    if (result.ok) return `Progress check: \`${step}\` passes.`;
    return `Progress check: \`${step}\` fails. This is not the final gate, and a failure can be expected mid-change (a test for code you have not written yet). Fix it only if it is not.\n${result.results[0].output.slice(-PROGRESS_TAIL)}`;
  };
  const review = async (cwd: string, task: NonNullable<Awaited<ReturnType<typeof readTask>>>, model: string, signal: AbortSignal, steps: string[]) => {
    const t0 = Date.now();
    // Advisory: a throw here must not stop the task from settling.
    const result = await skillsBlock(cwd, "review")
      .then((skills) => reviewDiff(pi.exec.bind(pi), cwd, task, model, signal, skills, steps))
      .catch((e: any) => ({ status: "skipped" as const, report: String(e?.message ?? e), cost: undefined, cancelled: false }));
    const discarded = signal.aborted || result.cancelled === true;
    pi.events.emit(REVIEW_EVENT, { root: cwd, status: result.status, model, seconds: (Date.now() - t0) / 1000, cost: result.cost, discarded } satisfies ReviewPayload);
    return result;
  };
  const deescalate = async (ctx: any) => {
    const [from, to] = [escalatedFrom, escalatedTo];
    escalatedFrom = escalatedTo = undefined;
    failures = 0;
    lastSignature = undefined;
    repeats = 0;
    // A model picked since (by /task cancel, /task done or the user) stays.
    if (from && (!ctx.model || `${ctx.model.provider}/${ctx.model.id}` === to)) await restoreModel(pi, ctx, from);
  };

  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType !== "user") return;
    await deescalate(ctx);
    start = await snapshot(ctx.cwd);
    writes = 0;
    sinceCheck = 0;
    retries = 0;
    contractRetries = 0;
    reviews = 0;
    policyRepeats = 0;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    writes++;
    const note = await progress(ctx.cwd).catch(() => undefined);
    if (note) return { content: [...event.content, { type: "text" as const, text: note }] };
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    // An exception the user never saw must not open the gate, even one a background process wrote after the last command.
    await checkAcceptances(ctx);
    // A broken manifest (a merge conflict) must not turn the gate off unnoticed.
    const manifest = await readManifest(ctx.cwd).catch((e: Error) => void ctx.ui.notify(`Verify did not run: ${e.message}`, "error"));
    // An empty verify list still runs the contract check, the risk report and the review; only the task cannot pass verify.
    if (!manifest || manifest.setup !== "done" || event.outcome !== "completed") return;
    const { verifyRetries, failuresBeforeEscalation } = limitsOf(manifest);
    const now = await snapshot(ctx.cwd);
    // A deferred gate runs on the next turn even when that turn changes nothing.
    // A tree changed between turns during the understanding check is checked too: understanding_done waits for it.
    if (now === start && now !== UNREADABLE && !writes && !deferred && !(await checkPending(ctx.cwd, now))) return;
    const state = `${now}:${writes}`;
    if (state === verified) return;
    // A state git could not read says nothing about the next one: never remember it as verified.
    const remembered = now === UNREADABLE ? undefined : state;

    const task = await readTask(ctx.cwd).catch(() => undefined);
    if (ctx.mode === "tui" && task?.status === "implementing" && !deferred && endsOnQuestion(lastText)) return void (deferred = true);
    deferred = false;
    // The pinned names are a contract: check them before spending verify time or a paid review on code that misses them.
    if (task?.status === "implementing" && task.plan) {
      const problems = await checkContract(ctx.cwd, task.plan);
      if (problems.length) {
        // Out of retries (none at all with verifyRetries 0): only the user lets a task with a missing interface go on.
        if (contractRetries >= verifyRetries) {
          const choice = ctx.hasUI ? await ctx.ui.select("The plan's interface is still missing after several attempts. What now?", ["Keep trying", "Leave it as is"]) : undefined;
          if (choice !== "Keep trying") return deescalate(ctx).then(() => undefined);
        }
        contractRetries++;
        return { entries: [{ type: "custom_message", customType: "contract-gate", content: `${formatContract(problems)}\n\nExpose exactly these names in these files (the plan's interface), then finish.`, display: true }], continue: true };
      }
    }
    const reviewModel = manifest.models?.review;
    const abort = new AbortController();
    skip = undefined;
    let wanted = task?.status === "implementing" && !!reviewModel && reviews < MAX_REVIEWS && (now === UNREADABLE || reviewed.get(task.id) !== now);
    // The level is measured and reported; whether it asks for a model review is the manifest's policy.
    const risk = task?.status === "implementing" ? await assessRisk(pi.exec.bind(pi), ctx.cwd, task, manifest) : undefined;
    if (wanted && reviewModel && risk) {
      if (!risk.review) {
        wanted = false;
        const why = risk.reasons.join("; ") || "small diff outside sensitive areas";
        // Off by policy is not the same as too small to need one: only the second counts as a saving.
        const off = !!manifest.review?.never || minLevelOf(manifest.review) === "off";
        ctx.ui.notify(off ? `Review not requested (risk ${risk.level}): ${why}.${manifest.review?.never ? "" : ' Set review.minLevel to "high" or "low" in .pi/workflow.json to have the diff reviewed.'}` : `Review skipped (risk ${risk.level}): ${why}`, "info");
        // Counted when the task completes without a review (below), not here: a settle that fails verify, or a diff that grows, has not skipped anything yet.
        skip = { root: ctx.cwd, status: off ? "not-requested" : "skipped-low-risk", model: reviewModel, seconds: 0, cost: 0 };
      }
    }
    // A review the policy asks for cannot run without a model: say so once instead of skipping silently.
    if (task?.status === "implementing" && !reviewModel && risk?.review && !warnedNoReviewModel) {
      warnedNoReviewModel = true;
      ctx.ui.notify("The review policy asks for a review, but it needs models.review in .pi/workflow.json.", "warning");
    }
    const reviewing = wanted && task && reviewModel ? review(ctx.cwd, task, reviewModel, abort.signal, verifySteps(manifest)) : undefined;
    if (reviewing) ctx.ui.setStatus("review", `reviewing the diff with ${reviewModel}…`);
    const clearStatus = () => ctx.ui.setStatus("review", undefined);
    const { ok, report, policy, infra, signature, seconds } = await verify(manifest, ctx.cwd);
    const unverified = !verifySteps(manifest).length;
    const emit = (extra: Pick<VerifyPayload, "premise"> = {}) => void (unverified || emitVerify({ root: ctx.cwd, ok, seconds, ...extra }));
    if (infra) {
      // Not a verify failure: the code cannot be at fault, so the model hears nothing and no retry is spent.
      emit();
      if (reviewing) {
        abort.abort();
        clearStatus();
      }
      const message = `Verify did not run. ${infra}`;
      ctx.ui.notify(message, "error");
      if (ctx.hasUI) {
        // The work stays a task in progress either way; only the user decides to go on without checking it.
        const choice = await ctx.ui.select(`${message}\n\nThe change cannot be checked until this is fixed.`, ["Leave the work unverified", "Stop here: I will fix it and finish again"]);
        if (choice === "Leave the work unverified") {
          verified = remembered;
          if (task?.status === "implementing") ctx.ui.notify("The task stays open: /task done closes it.", "info");
        }
      } else {
        ctx.ui.notify(`Unverified: ${infra} Nobody can answer here, so the task is not marked done; /task done closes it.`, "warning");
        verified = remembered;
      }
      return deescalate(ctx).then(() => undefined);
    }
    if (!ok) {
      // The code will change, so this review is stale: stop its subagent now instead of paying for a verdict nobody uses.
      if (reviewing) {
        abort.abort();
        clearStatus();
      }
      if (!policy) {
        failures++;
        repeats = sameFailure(signature, lastSignature) ? repeats + 1 : 1;
        lastSignature = signature;
      }
      const premise = !policy && failures >= failuresBeforeEscalation && repeats >= 2;
      emit({ premise });
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
      if (retries >= verifyRetries) {
        if (!ctx.hasUI) return deescalate(ctx).then(() => undefined);
        const choice = await ctx.ui.select("Verification still fails after several attempts. What now?", ["Keep trying", "Leave it as is"]);
        if (choice !== "Keep trying") return deescalate(ctx).then(() => undefined);
      } else retries++;
      const target = manifest.models?.escalate ?? manifest.models?.review ?? manifest.models?.setup;
      if (failures >= failuresBeforeEscalation && !escalatedFrom) {
        const switched = await switchModel(pi, ctx, target);
        if (switched) {
          escalatedFrom = switched.previous;
          escalatedTo = switched.model;
          ctx.ui.notify(`verify failed ${failuresBeforeEscalation} times: ${switched.model} takes this attempt`, "warning");
          pi.events.emit(ESCALATE_EVENT, { root: ctx.cwd, model: switched.model } satisfies EscalatePayload);
        }
      }
      const diagnose = !policy && failures === failuresBeforeEscalation;
      const content = await advice(ctx.cwd, report, policy ? "policy" : diagnose ? "diagnose" : "fix", premise, manifest.agentlint);
      const customType = diagnose ? "verify-diagnose" : "verify-gate";
      return { entries: [{ type: "custom_message", customType, content, display: true }], continue: true };
    }
    emit();

    verified = remembered;
    await deescalate(ctx);
    if (risk) ctx.ui.notify(`Risk ${risk.level}${risk.reasons.length ? `: ${risk.reasons.join("; ")}` : ""}${reviewing ? " (review requested)" : !risk.review ? ` (review not requested${reviewModel ? "" : "; models.review is not set"})` : reviewModel ? " (already reviewed)" : " (no review model)"}`, "info");
    if (reviewing) {
      const review = await reviewing.finally(clearStatus);
      if (review.status === "skipped") ctx.ui.notify(`Review skipped: ${review.report}`, "warning");
      else ctx.ui.notify(review.status === "approved" ? "Diff review: approved." : "Diff review: changes requested. The agent fixes them.", review.status === "approved" ? "info" : "warning");
      reviews++;
      // A review that did not run (no tmux, a failed child) is tried again on the same diff, and still counts as one for the low-risk skip.
      if (task) reviewed.set(task.id, review.status === "skipped" ? "" : now);
      if (review.status === "skipped") verified = undefined;
      // One round: the fixes are checked by verify, not by another paid review.
      if (review.status === "changes") {
        verified = undefined;
        const content = `${review.report}\n\nFix these, then finish.`;
        return { entries: [{ type: "custom_message", customType: "diff-review", content, display: true }], continue: true };
      }
    }
    if (task?.status !== "implementing") return;
    // The understanding check was sent for this tree: understanding_done (or /task done) closes the task.
    const checking = task.understanding;
    if (checking?.tree === now) return;
    // Headless, a pass is the answer; with no verify steps nothing passed, so only a person can call it done.
    const title = unverified ? "No verify steps: nothing checked this change" : "Verification OK";
    const done = ctx.hasUI ? await ctx.ui.confirm(title, `Is the task "${oneLine(task.title, 80)}" done?${dialogNotes(risk)}`) : !unverified;
    if (!done) {
      ctx.ui.notify(`The task stays open${ctx.hasUI ? "" : ": no verify steps checked it"}. /task done closes it.`, "info");
      return;
    }
    // Changed during the check, verified and confirmed again: this tree is the one understanding_done may close.
    if (checking) {
      await updateTask(ctx.cwd, (t) => void (t.understanding = { tree: now }));
      const content = "The changed code passed the gate and the user confirmed it. Finish the understanding check with understanding_done.";
      return { entries: [{ type: "custom_message", customType: "understanding-check", content, display: true }], continue: true };
    }
    // Before the task is marked done: telemetry looks up the active task, and a done one is not.
    if (skip && !reviewed.has(task.id)) pi.events.emit(REVIEW_EVENT, skip satisfies ReviewPayload);
    const understanding = understandingOf(manifest);
    // The teach-back runs once, on the final code (after any review fixes); understanding_done completes the task.
    if (understanding !== "off" && ctx.hasUI) {
      await updateTask(ctx.cwd, (t) => void (t.understanding = { tree: now }));
      const content = understandingCheck(path.join(skillsDir(), "understanding-check", "SKILL.md"));
      return { entries: [{ type: "custom_message", customType: "understanding-check", content, display: true }], continue: true };
    }
    pi.events.emit(UNDERSTANDING_EVENT, { root: ctx.cwd, outcome: understanding === "off" ? "off" : "no-ui", gaps: 0 } satisfies UnderstandingPayload);
    await completeTask(pi, ctx);
  });

  pi.registerCommand("verify", {
    description: "Run the project's verification steps",
    handler: async (_args, ctx) => {
      const manifest = await readManifest(ctx.cwd);
      if (!manifest.verify.length) return ctx.ui.notify("No verification steps configured.", "warning");
      const { ok, report } = await verify(manifest, ctx.cwd);
      ctx.ui.notify(report, ok ? "info" : "error");
    },
  });
}
