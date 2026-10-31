import type { Task } from "./task-state.ts";

/** Events modules use to talk through `pi.events`, so none imports another's internals. */
export const VERIFY_EVENT = "pi-improved:verify";
export interface VerifyPayload {
  root: string;
  /** progress: the check every few writes; gate: the final verify. */
  kind: "progress" | "gate";
  ok: boolean;
  /** Seconds verify took. */
  seconds: number;
  /** gate: the failure came back and the prompt carried the premise lines. */
  premise?: boolean;
}

export const REVIEW_EVENT = "pi-improved:review";
export interface ReviewPayload {
  root: string;
  /** plan-ok / plan-fix: the strong-model spot check of the plan (before any code). */
  status: "approved" | "changes" | "skipped" | "skipped-low-risk" | "not-requested" | "plan-ok" | "plan-fix";
  model: string;
  seconds: number;
  /** Cost of the review subagent's own model calls, when its session could be read. */
  cost?: number;
  /** The diff changed (verify failed) before the review finished, so its verdict was not used. */
  discarded?: boolean;
}

export const ESCALATE_EVENT = "pi-improved:escalate";
export interface EscalatePayload {
  root: string;
  model: string;
}

/** Emitted by the gate when the user confirms a task is finished. */
export const TASK_DONE_EVENT = "pi-improved:task-done";
export interface TaskDonePayload {
  root: string;
  task: Task;
  /** The retro prompt is only sent to an interactive session. */
  hasUI?: boolean;
}

/** Emitted by self-compact when it schedules a compaction for the end of the run, and when that compaction is over. */
export const SELF_COMPACT_EVENT = "pi-improved:self-compact";
export interface SelfCompactPayload {
  /** A compaction waits for the run to end, so nothing should continue the run. */
  scheduled: boolean;
  /** pi resumes the agent after the compaction (while scheduled), or has just sent the resume (once it is over). */
  resume: boolean;
}

/** Sent to self-compact to have the agent resumed after the scheduled compaction, with `message` added to the resume. */
export const SELF_COMPACT_RESUME_EVENT = "pi-improved:self-compact-resume";
export interface SelfCompactResumePayload {
  message: string;
}
