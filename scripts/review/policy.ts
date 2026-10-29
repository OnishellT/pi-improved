// Pure review policy: what gets posted, how confidence is derived, what is a duplicate,
// when a run is skipped or stopped, and which thread actions follow the verdicts.
import {
  inlineCommentBody,
  type Finding,
  type Marker,
  type Resolution,
  type Review,
  type Severity,
} from "./result.ts";

export interface ThreadInfo {
  id: string;
  isResolved: boolean;
  path: string;
  line: number | null;
  firstCommentId: number;
  text: string;
}

const severityRank: Record<Severity, number> = { critical: 3, major: 2, minor: 1, nit: 0 };

// Follow-up rounds judge the delta: a finding on code that did not change since the last
// reviewed commit survives only when it is critical.
export function scopeFindings(
  findings: readonly Finding[],
  deltaLines: Map<string, Set<number>> | undefined,
  deltaPaths: ReadonlySet<string> = new Set(),
): Finding[] {
  if (deltaLines === undefined) return [...findings];
  // A file the delta deleted has no lines to match; any finding on it is in scope.
  return findings.filter((finding) => {
    const lines = deltaLines.get(finding.path);
    return finding.severity === "critical" || (lines ? lines.has(finding.line) : deltaPaths.has(finding.path));
  });
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  return [...a].filter((word) => b.has(word)).length / a.size;
}

const lineWindow = 3;

// Drops findings already raised in an earlier thread (same place, similar title) and merges
// same-line duplicates within the run, keeping the more severe one.
export function dedupeFindings(
  findings: readonly Finding[],
  threads: readonly ThreadInfo[],
): Finding[] {
  const kept: Finding[] = [];
  for (const finding of findings) {
    const title = words(finding.title);
    const known = threads.some(
      (thread) =>
        thread.path === finding.path &&
        (thread.line === null || Math.abs(thread.line - finding.line) <= lineWindow) &&
        overlap(title, words(thread.text)) >= 0.6,
    );
    if (known) continue;
    const twin = kept.findIndex(
      (other) =>
        other.path === finding.path &&
        other.line === finding.line &&
        overlap(title, words(other.title)) >= 0.5,
    );
    if (twin === -1) kept.push(finding);
    else if (severityRank[finding.severity] > severityRank[kept[twin]?.severity ?? "nit"]) {
      kept[twin] = finding;
    }
  }
  return kept;
}

// Confidence follows from the findings, not from the model's mood: any critical caps it at 2,
// any major, minor or unfixed earlier thread at 3, a clean review is at least 4, and 5 needs no nits.
export function clampConfidence(
  confidence: number,
  findings: readonly Finding[],
  notFixed: number,
): number {
  const count = (severity: Severity) => findings.filter((f) => f.severity === severity).length;
  const clamp = (low: number, high: number) => Math.min(high, Math.max(low, confidence));
  if (count("critical") > 0) return clamp(1, 2);
  if (count("major") + count("minor") + notFixed > 0) return clamp(1, 3);
  return count("nit") > 0 ? 4 : clamp(4, 5);
}

export function finalizeReview(
  review: Review,
  findings: readonly Finding[],
  notFixed: number,
): Review {
  return {
    ...review,
    findings: [...findings],
    confidence: clampConfidence(review.confidence, findings, notFixed),
  };
}

export const maxLocalRounds = 3;

export type Gate = { action: "run" } | { action: "skip" | "stop"; message: string };

export function reviewGate(
  earlier: readonly Marker[],
  headSha: string,
  force: boolean,
  incomplete = false,
): Gate {
  if (force) return { action: "run" };
  if (
    !incomplete &&
    earlier.some((marker) => headSha.startsWith(marker.sha) || marker.sha.startsWith(headSha))
  ) {
    return {
      action: "skip",
      message: `A local review of ${headSha.slice(0, 7)} already exists; nothing to do (use --force to review again).`,
    };
  }
  // A PR that converged (last confidence 4 or more) can still get its final commit reviewed.
  // An incomplete attempt finishes a round that was already counted, so the limit does not apply.
  if (!incomplete && earlier.length >= maxLocalRounds && (earlier.at(-1)?.confidence ?? 0) < 4) {
    return {
      action: "stop",
      message: `${earlier.length} local reviews have not converged: stop and ask the coordinator before another round (use --force to override).`,
    };
  }
  return { action: "run" };
}

export interface ThreadActions {
  replies: { commentId: number; body: string }[];
  resolve: string[];
}

export const fixedMarker = (sha: string) => `<!-- local-review-fixed sha=${sha} -->`;

const sameHead = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

// An attempt at this head is incomplete when a "fixed" reply of it is newer than the latest
// posted review of the head (the review is posted last). Rebuilt from GitHub timestamps, so
// a normal run resumes it, and only those threads still hold a reply to suppress.
export function pendingAttempt(input: {
  reviews: readonly { sha: string; at: string }[];
  threadComments: readonly { threadId: string; body: string; at: string }[];
  head: string;
}): { incomplete: boolean; pendingThreadIds: Set<string> } {
  const done = Math.max(
    -Infinity,
    ...input.reviews.filter((r) => sameHead(r.sha, input.head)).map((r) => Date.parse(r.at)),
  );
  const pendingThreadIds = new Set<string>();
  for (const comment of input.threadComments) {
    const sha = /<!-- local-review-fixed sha=(\w+) -->/.exec(comment.body)?.[1];
    if (sha !== undefined && sameHead(sha, input.head) && Date.parse(comment.at) > done) {
      pendingThreadIds.add(comment.threadId);
    }
  }
  return { incomplete: pendingThreadIds.size > 0, pendingThreadIds };
}

// Only a fixed verdict touches a thread (a short reply and a resolve, always in that order,
// and the reply always carries the head marker, so any partial attempt is detectable); not-fixed verdicts
// live in the review body, so follow-up rounds create no extra reviews or comments.
export function planThreadActions(
  verdicts: readonly Resolution[],
  threads: readonly ThreadInfo[],
  sha: string,
  pending: ReadonlySet<string> = new Set(),
): ThreadActions {
  const open = new Map(threads.filter((t) => !t.isResolved).map((t) => [t.id, t]));
  const actions: ThreadActions = { replies: [], resolve: [] };
  for (const verdict of verdicts) {
    const thread = open.get(verdict.threadId);
    if (!thread || verdict.verdict !== "fixed") continue;
    // A reply of the current incomplete attempt is already there; older ones belong to a past round.
    const body = `Fixed: ${verdict.note}\n\n${fixedMarker(sha)}`;
    if (!pending.has(thread.id)) actions.replies.push({ commentId: thread.firstCommentId, body });
    actions.resolve.push(thread.id);
  }
  return actions;
}

export interface ReviewPayload {
  commit_id: string;
  event: "COMMENT";
  body: string;
  comments: { path: string; line: number; side: "RIGHT"; body: string }[];
}

export function buildReviewPayload(
  sha: string,
  body: string,
  inline: readonly Finding[],
): ReviewPayload {
  return {
    commit_id: sha,
    event: "COMMENT",
    body,
    comments: inline.map((finding) => ({
      path: finding.path,
      line: finding.line,
      side: "RIGHT",
      body: inlineCommentBody(finding),
    })),
  };
}
