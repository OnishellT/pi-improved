import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ESCALATE_EVENT, REVIEW_EVENT, TASK_DONE_EVENT, VERIFY_EVENT, type EscalatePayload, type ReviewPayload, type TaskDonePayload, type VerifyPayload } from "./events.ts";
import { checkContract, formatContract } from "./contract.ts";
import { limitsOf } from "./config.ts";
import { diffBase, fileChanges, git, type FileChange } from "./git.ts";
import { recordUnderstanding } from "./telemetry.ts";
import { MANIFEST_PATH, readManifest, understandingOf, type Manifest } from "./manifest.ts";
import { restoreModel, switchModel } from "./models.ts";
import { assessRisk, minLevelOf } from "./risk.ts";
import { checkAcceptances } from "./guards.ts";
import { resolvePolicyFailure } from "./policy.ts";
import { reviewDiff } from "./review.ts";
import { skillsBlock, skillsDir } from "./skills.ts";
import { assistantText, endsOnQuestion, understandingCheck } from "./task-prompt.ts";
import { oneLine, readTask, savedVerifyOf, saveVerify, updateTask, type Task } from "./task-state.ts";
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
const FILES_SHOWN = 30;
/** One line per file: a name with a newline or another control character is quoted, so it cannot split the line. */
const fileRow = (c: FileChange) => `- ${/[\u0000-\u001f\u007f]/.test(c.file) ? JSON.stringify(c.file) : c.file} (${c.status}${c.added !== undefined ? `, +${c.added} -${c.removed}` : c.binary ? ", binary" : ""})`;
/** The done dialog lists every file the task wrote, so the person knows what to open before confirming. */
const filesNote = (changes: FileChange[] | undefined) =>
  !changes ? "\n\nFiles changed: unknown, git could not list them." : changes.length ? `\n\nFiles changed (${changes.length}):\n${changes.slice(0, FILES_SHOWN).map(fileRow).join("\n")}${changes.length > FILES_SHOWN ? `\n…and ${changes.length - FILES_SHOWN} more` : ""}` : "";
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
// `limits.verifyRetries` (config.ts) sets the automatic retries. The 2nd failed verify diagnoses the bug with the current model;
// the `limits.failuresBeforeEscalation`-th hands the attempt to the stronger model (both at once when the limit is 2 or lower).
/** The failure that asks the model to diagnose: the 2nd, or the escalation point when that comes first. */
export const diagnoseAt = (failuresBeforeEscalation: number) => Math.min(2, failuresBeforeEscalation);
const STEPS_CHANGED = "The verify steps changed during the task. Use the new ones?";
/** A failed run, without running anything: the verify steps changed and nobody can approve it. Its signature makes a repeat count as the same failure. */
const stepsChanged = (saved: string[]) => {
  const lines = ["verify FAILED: the verify steps changed during the task, and nobody can approve that here.", `Put back the steps the task started with in ${MANIFEST_PATH}:`, ...saved.map((s) => `- ${s}`)];
  return { ok: false, report: lines.join("\n"), policy: false, infra: undefined, signature: { step: "verify steps changed", lines } as Signature | undefined, seconds: 0 };
};
/** Where a gate that stops leaves the task, and what closes it. */
const STAYS_OPEN = "The task stays open: /task done closes it.";
const REPORT_TAIL = 600;
const tail = (report: string) => (report.length > REPORT_TAIL ? `…${report.slice(-REPORT_TAIL)}` : report);
const idOf = (model: any) => (model ? `${model.provider}/${model.id}` : undefined);
type Risk = { level: string; reasons: string[] };
/** One line on the risk and what happened to the review; undefined when there is nothing to say (no risk, no review). */
export function riskLine(risk: Risk | undefined, review: string | undefined) {
  if (!risk || (risk.level === "none" && !risk.reasons.length && !review)) return undefined;
  return `Risk ${risk.level}${risk.reasons.length ? `: ${risk.reasons.join("; ")}` : ""}.${review ? ` ${review}` : ""}`;
}

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
  // Every failed verify since the last pass or user turn, agentlint ones included: the count the person sees.
  let failedRuns = 0;
  // The failure the last gate message showed: the question does not show it again.
  let shownSignature: Signature | undefined;
  // The exit code before this gate set 1, so a later prompt of the same headless run that passes verify gives it back.
  let exitBefore: typeof process.exitCode | null = null;
  /** Headless, a notice reaches nobody (print mode drops it): the run's red end goes to stderr in one line, and the exit code says it too. */
  const endRed = (ctx: any, line: string) => {
    if (ctx.hasUI) return;
    console.error(`[pi-improved] ${line}`);
    if (exitBefore === null) exitBefore = process.exitCode;
    process.exitCode = 1;
  };
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
  const verify = async (manifest: Manifest, cwd: string, steps = verifySteps(manifest)) => {
    const t0 = Date.now();
    const isAgentlint = agentlintStepOf(manifest);
    const result = await runVerify(steps, pi.exec.bind(pi), cwd, undefined, validCap(manifest.maxReport));
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
    failures = failedRuns = 0;
    lastSignature = shownSignature = undefined;
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
    if (ctx.mode === "tui" && task?.status === "implementing" && !deferred && endsOnQuestion(lastText)) {
      deferred = true;
      return void ctx.ui.notify("The agent asked a question: verify runs after your reply.", "info");
    }
    deferred = false;
    const open = task?.status === "implementing" ? ` ${STAYS_OPEN}` : "";
    // The pinned names are a contract: check them before spending verify time or a paid review on code that misses them.
    if (task?.status === "implementing" && task.plan) {
      const problems = await checkContract(ctx.cwd, task.plan);
      if (problems.length) {
        // Out of retries (none at all with verifyRetries 0): only the user lets a task with a missing interface go on.
        if (contractRetries >= verifyRetries) {
          const missing = "The plan's interface is still missing after the automatic retries.";
          // Headless, nobody can answer: say why the run ended red, with what is missing. With a UI, show it before asking.
          // In full: the list is one short line per pinned name, and any one left out is one the user cannot judge.
          if (!ctx.hasUI) {
            ctx.ui.notify(`${missing}${open}\n\n${formatContract(problems)}`, "warning");
            endRed(ctx, `${missing}${open}`);
          } else ctx.ui.notify(formatContract(problems), "warning");
          const choice = ctx.hasUI ? await ctx.ui.select(`${missing} What now?`, ["Keep trying", "Leave it as is"]) : undefined;
          if (choice !== "Keep trying") {
            if (ctx.hasUI) ctx.ui.notify(STAYS_OPEN, "info");
            return deescalate(ctx).then(() => undefined);
          }
        }
        contractRetries++;
        return { entries: [{ type: "custom_message", customType: "contract-gate", content: `${formatContract(problems)}\n\nExpose exactly these names in these files (the plan's interface), then finish.`, display: true }], continue: true };
      }
    }
    // The steps the task started with: an edit to them during the task (with any tool) is not the gate's to accept.
    let steps = verifySteps(manifest);
    let restore = "";
    let refused: string[] | undefined;
    if (task?.status === "implementing") {
      const saved = savedVerifyOf(ctx.cwd, task);
      // A task from before the list was saved: this gate saves it and checks from the next one on.
      if (!saved) await updateTask(ctx.cwd, (t) => saveVerify(ctx.cwd, t, steps)).catch(() => {});
      else if (JSON.stringify(saved) !== JSON.stringify(steps)) {
        const use = ctx.hasUI && (await ctx.ui.select(STEPS_CHANGED, ["Use the new ones", "Keep the old ones"])) === "Use the new ones";
        if (use) await updateTask(ctx.cwd, (t) => saveVerify(ctx.cwd, t, steps));
        else if (ctx.hasUI) {
          steps = saved;
          restore = `The user kept the verify steps the task started with (${saved.map((v) => `\`${v}\``).join(", ")}): put them back in ${MANIFEST_PATH}.`;
        } else refused = saved;
      }
    }
    const reviewModel = manifest.models?.review;
    const abort = new AbortController();
    skip = undefined;
    let wanted = task?.status === "implementing" && !!reviewModel && reviews < MAX_REVIEWS && (now === UNREADABLE || reviewed.get(task.id) !== now);
    // The level is measured and reported; whether it asks for a model review is the manifest's policy.
    const risk = task?.status === "implementing" ? await assessRisk(pi.exec.bind(pi), ctx.cwd, task, manifest) : undefined;
    // Off by policy is not the same as too small to need one: only the second counts as a saving.
    const off = !!manifest.review?.never || minLevelOf(manifest.review) === "off";
    if (wanted && reviewModel && risk && !risk.review) {
      wanted = false;
      // Counted when the task completes without a review (below), not here: a settle that fails verify, or a diff that grows, has not skipped anything yet.
      skip = { root: ctx.cwd, status: off ? "not-requested" : "skipped-low-risk", model: reviewModel, seconds: 0, cost: 0 };
    }
    // A review the policy asks for cannot run without a model: say so once instead of skipping silently.
    if (task?.status === "implementing" && !reviewModel && risk?.review && !warnedNoReviewModel) {
      warnedNoReviewModel = true;
      ctx.ui.notify("This change needs a review, but no review model is set. Run /models and pick Review.", "warning");
    }
    const reviewing = wanted && !refused && task && reviewModel ? review(ctx.cwd, task, reviewModel, abort.signal, steps) : undefined;
    if (reviewing) ctx.ui.setStatus("review", `reviewing the diff with ${reviewModel}…`);
    const clearStatus = () => ctx.ui.setStatus("review", undefined);
    // Headless, nobody can approve the new steps: they do not run, and the failure goes through the usual retries.
    const { ok, report, policy, infra, signature, seconds } = refused ? stepsChanged(refused) : await verify(manifest, ctx.cwd, steps);
    const unverified = !steps.length;
    const emit = (extra: Pick<VerifyPayload, "premise"> = {}) => void (unverified || emitVerify({ root: ctx.cwd, ok, seconds, ...extra }));
    if (infra) {
      // Not a verify failure: the code cannot be at fault, so the model hears nothing and no retry is spent.
      emit();
      if (reviewing) {
        abort.abort();
        clearStatus();
      }
      // No question: nothing the user picks here changes what happens. The work stays unverified and the task open;
      // a turn that changes nothing does not run the gate again, so the notice names the commands that do.
      ctx.ui.notify(`Verify did not run. ${infra}${task?.status === "implementing" ? " The task stays open: once this is fixed, /verify checks the change and /task done closes the task." : ""}`, "error");
      verified = remembered;
      return deescalate(ctx).then(() => undefined);
    }
    if (!ok) {
      // The code will change, so this review is stale: stop its subagent now instead of paying for a verdict nobody uses.
      if (reviewing) {
        abort.abort();
        clearStatus();
      }
      failedRuns++;
      if (!policy) {
        failures++;
        repeats = sameFailure(signature, lastSignature) ? repeats + 1 : 1;
        lastSignature = signature;
      }
      const diagnoseFrom = diagnoseAt(failuresBeforeEscalation);
      const premise = !policy && failures >= diagnoseFrom && repeats >= 2;
      emit({ premise });
      // The model gets one chance to fix an agentlint finding; after that only the user can decide, so ask them instead of looping.
      if (policy && ctx.hasUI && policyRepeats++ >= 1) {
        const outcome = await resolvePolicyFailure(pi, ctx, manifest, report);
        if (outcome === "stop") {
          ctx.ui.notify(task?.status === "implementing" ? STAYS_OPEN : "Stopped: agentlint still blocks.", "info");
          return deescalate(ctx).then(() => undefined);
        }
        if (outcome === "approved") {
          const content = "The user approved the agentlint exception and it is recorded. Do not change the code: finish so verify runs again.";
          return { entries: [{ type: "custom_message", customType: "verify-gate", content, display: true }], continue: true };
        }
        if (outcome === "failed") ctx.ui.notify("Could not record the agentlint exception. The model continues.", "warning");
      }
      // The stronger model always gets its one attempt, even past the automatic retries: only then is the user asked.
      const escalating = failures >= failuresBeforeEscalation && !escalatedFrom ? await switchModel(pi, ctx, manifest.models?.escalate ?? manifest.models?.review ?? manifest.models?.setup) : undefined;
      const retried = retries < verifyRetries;
      if (retried) retries++;
      else if (!escalating) {
        // The count and the model that tried last: with the escalation past the retries, more ran than verifyRetries says.
        const last = idOf(ctx.model);
        const failed = `Verify failed ${failedRuns} time${failedRuns === 1 ? "" : "s"}${last ? `, last with ${last}` : ""}.`;
        if (!ctx.hasUI) {
          // Headless, nobody can answer: say why the run ended red, with the end of the last report.
          ctx.ui.notify(`${failed}${open}\n\n${tail(report)}`, "error");
          endRed(ctx, `${failed}${open}`);
          return deescalate(ctx).then(() => undefined);
        }
        // The last report goes to nobody else: show it before asking, unless the same failure is already on screen in the last gate message.
        if (!sameFailure(signature, shownSignature)) ctx.ui.notify(tail(report), "error");
        const choice = await ctx.ui.select(`${failed} What now?`, ["Keep trying", "Leave it as is"]);
        if (choice !== "Keep trying") {
          ctx.ui.notify(task?.status === "implementing" ? "The task stays open: after your fix, /verify checks it and /task done closes it." : "Stopped: verify still fails.", "info");
          return deescalate(ctx).then(() => undefined);
        }
      }
      if (escalating) {
        escalatedFrom = escalating.previous;
        escalatedTo = escalating.model;
        const more = verifyRetries - retries;
        const then = ctx.hasUI ? "then you decide" : "then the run stops";
        ctx.ui.notify(`Verify failed ${failures} time${failures === 1 ? "" : "s"}: ${escalating.model} takes this attempt${more > 0 ? ` and ${more} more` : ""}, ${then}.`, "warning");
        pi.events.emit(ESCALATE_EVENT, { root: ctx.cwd, model: escalating.model } satisfies EscalatePayload);
      }
      const diagnose = !policy && failures === diagnoseFrom;
      // The person sees the attempt and the next step in the gate message itself; the escalation has its own notice.
      const step = retried && !policy && !escalating ? `Verify failed (${retries} of ${verifyRetries}): ${diagnose ? "diagnosing, then retrying" : "retrying"}.\n\n` : "";
      const content = (restore && `${restore}\n\n`) + step + (await advice(ctx.cwd, report, policy ? "policy" : diagnose ? "diagnose" : "fix", premise, manifest.agentlint));
      const customType = diagnose ? "verify-diagnose" : "verify-gate";
      shownSignature = signature;
      return { entries: [{ type: "custom_message", customType, content, display: true }], continue: true };
    }
    emit();
    // A later prompt of the same headless run passed: the red end this gate reported no longer holds.
    if (exitBefore !== null) {
      process.exitCode = exitBefore;
      exitBefore = null;
    }

    // The old steps passed, but the file still holds the new ones: the task closes once they are back.
    if (restore) {
      if (reviewing) {
        abort.abort();
        clearStatus();
      }
      return { entries: [{ type: "custom_message", customType: "verify-gate", content: `${restore} Then finish.`, display: true }], continue: true };
    }
    verified = remembered;
    await deescalate(ctx);
    // What happened to the review, in the one risk line said at the end (in the done dialog when there is one).
    let reviewNote: string | undefined;
    let warn = false;
    if (reviewing) {
      const review = await reviewing.finally(clearStatus);
      warn = review.status !== "approved";
      reviewNote = review.status === "approved" ? "Review: approved." : review.status === "changes" ? "Review: changes requested; the agent fixes them." : `Review did not run: ${oneLine(review.report, 200)}`;
      reviews++;
      // A review that did not run (no tmux, a failed child) is tried again on the same diff, and still counts as one for the low-risk skip.
      if (task) reviewed.set(task.id, review.status === "skipped" ? "" : now);
      if (review.status === "skipped") verified = undefined;
      // One round: the fixes are checked by verify, not by another paid review.
      if (review.status === "changes") {
        verified = undefined;
        const line = riskLine(risk, reviewNote);
        if (line) ctx.ui.notify(line, "warning");
        const content = `${review.report}\n\nFix these, then finish.`;
        return { entries: [{ type: "custom_message", customType: "diff-review", content, display: true }], continue: true };
      }
    } else if (risk) {
      // Name the key that turned it off: `never` wins over `minLevel`.
      if (!risk.review) reviewNote = off ? `Review: off (${manifest.review?.never ? "review.never" : "review.minLevel"}).` : risk.level === "none" ? undefined : "Review: not needed at this risk.";
      else if (!reviewModel) [reviewNote, warn] = ["Review: not run, no review model is set.", true];
      // Only a review of this very tree counts; after the one round per turn, the fixes were checked by verify only.
      else reviewNote = task && now !== UNREADABLE && reviewed.get(task.id) === now ? "Review: already ran on this diff." : "Review: not run on this diff (one review round per turn).";
    }
    const line = riskLine(risk, reviewNote);
    const checking = task?.understanding;
    // The done dialog carries the line; without one it is a notice.
    const dialog = ctx.hasUI && task?.status === "implementing" && checking?.tree !== now;
    if (line && !dialog) ctx.ui.notify(line, warn ? "warning" : "info");
    if (task?.status !== "implementing") return;
    // The understanding check was sent for this tree: understanding_done (or /task done) closes the task.
    if (checking?.tree === now) return;
    // Only a person confirms changed code during the check: a session resumed headless leaves it to /task done.
    if (checking && !ctx.hasUI) return void ctx.ui.notify("The code changed during the understanding check and nobody can confirm it here. /task done closes the task.", "info");
    // Headless, a pass is the answer; with no verify steps nothing passed, so only a person can call it done.
    const title = unverified ? "No verify steps: nothing checked this change" : "Verification OK";
    const exec = pi.exec.bind(pi);
    const changes = ctx.hasUI ? await fileChanges(exec, ctx.cwd, await diffBase(exec, ctx.cwd, task)) : [];
    const done = ctx.hasUI ? await ctx.ui.confirm(title, `Is the task "${oneLine(task.title, 80)}" done?${line ? `\n\n${line}` : ""}${filesNote(changes)}${dialogNotes(risk)}`) : !unverified;
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
    await recordUnderstanding(ctx.cwd, understanding === "off" ? "off" : "no-ui", 0);
    const closed = await completeTask(pi, ctx);
    ctx.ui.notify(`Task done: ${oneLine(closed.title)}.`, "info");
  });

  pi.registerCommand("verify", {
    description: "Run the project's verification steps",
    handler: async (_args, ctx) => {
      const manifest = await readManifest(ctx.cwd).catch((e: Error) => void ctx.ui.notify(`Verify did not run: ${e.message}`, "error"));
      if (!manifest) return;
      if (!manifest.verify.length) return ctx.ui.notify("No verification steps configured. Run /setup to add them.", "warning");
      ctx.ui.setStatus("verify", "running verify…");
      const { ok, report, infra } = await verify(manifest, ctx.cwd).finally(() => ctx.ui.setStatus("verify", undefined));
      if (infra) return ctx.ui.notify(`Verify did not run. ${infra}`, "error");
      ctx.ui.notify(report, ok ? "info" : "error");
    },
  });
}
