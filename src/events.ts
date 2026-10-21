/** Events modules use to talk through `pi.events`, so none imports another's internals. */
export const VERIFY_EVENT = "pi-improved:verify";
export interface VerifyPayload {
  root: string;
  ok: boolean;
  /** Seconds verify took. */
  seconds: number;
}

export const REVIEW_EVENT = "pi-improved:review";
export interface ReviewPayload {
  root: string;
  status: "approved" | "changes" | "skipped" | "skipped-low-risk";
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
