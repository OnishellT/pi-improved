import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewPayload,
  clampConfidence,
  dedupeFindings,
  finalizeReview,
  pendingAttempt,
  planThreadActions,
  reviewGate,
  scopeFindings,
  type ThreadInfo,
} from "../scripts/review/policy.ts";
import { buildMarker, parseMarker, renderBody, type Finding } from "../scripts/review/result.ts";

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  path: "a.ts",
  line: 10,
  severity: "minor",
  title: "Catch engine failures in the connection action",
  body: "Details.",
  ...overrides,
});

const thread = (overrides: Partial<ThreadInfo> = {}): ThreadInfo => ({
  id: "T1",
  isResolved: false,
  path: "a.ts",
  line: 12,
  firstCommentId: 77,
  text: "minor: Catch engine failures in the connection action",
  ...overrides,
});

test("follow-up scope drops findings on unchanged lines unless critical", () => {
  const delta = new Map([["a.ts", new Set([10])]]);
  const kept = scopeFindings(
    [
      finding({ line: 10 }),
      finding({ line: 99 }),
      finding({ line: 99, severity: "critical" }),
      finding({ path: "b.ts", line: 10 }),
    ],
    delta,
  );
  assert.deepEqual(kept.map((f) => `${f.path}:${f.line}:${f.severity}`), [
    "a.ts:10:minor",
    "a.ts:99:critical",
  ]);
});

test("a first review keeps every finding", () => {
  assert.equal(scopeFindings([finding({ line: 99 })], undefined).length, 1);
});

test("confidence is derived from the findings, never 3 with nothing to fix", () => {
  const nit = finding({ severity: "nit" });
  assert.equal(clampConfidence(3, [], 0), 4);
  assert.equal(clampConfidence(3, [nit], 0), 4);
  assert.equal(clampConfidence(5, [nit], 0), 4);
  assert.equal(clampConfidence(5, [], 0), 5);
  assert.equal(clampConfidence(5, [finding()], 0), 3);
  assert.equal(clampConfidence(5, [finding({ severity: "major" })], 0), 3);
  assert.equal(clampConfidence(5, [], 1), 3);
  assert.equal(clampConfidence(4, [finding({ severity: "critical" })], 0), 2);
  assert.equal(clampConfidence(1, [finding({ severity: "critical" })], 0), 1);
});

test("finalizing replaces the model's findings and confidence", () => {
  const review = { confidence: 3 as const, summary: "s", findings: [finding()] };
  const done = finalizeReview(review, [], 0);
  assert.equal(done.confidence, 4);
  assert.deepEqual(done.findings, []);
});

test("drops a finding that repeats an existing thread nearby", () => {
  assert.deepEqual(dedupeFindings([finding({ line: 10 })], [thread({ line: 12 })]), []);
  assert.equal(dedupeFindings([finding({ line: 10 })], [thread({ line: 40 })]).length, 1);
  assert.equal(dedupeFindings([finding({ line: 10 })], [thread({ path: "b.ts" })]).length, 1);
  assert.deepEqual(dedupeFindings([finding({ line: 10 })], [thread({ isResolved: true })]), []);
  assert.equal(dedupeFindings([finding({ line: 10 })], [thread({ text: "unrelated remark" })]).length, 1);
});

test("merges same-line duplicates, keeping the more severe", () => {
  const merged = dedupeFindings(
    [
      finding({ severity: "nit", title: "Rename the helper function" }),
      finding({ severity: "minor", title: "Rename helper function" }),
    ],
    [],
  );
  assert.deepEqual(merged.map((f) => f.severity), ["minor"]);
});

test("skips a head that already has a local review unless forced", () => {
  const earlier = [{ sha: "abcdef0123", confidence: 3, actionable: 1 }];
  assert.equal(reviewGate(earlier, "abcdef0123456789", false).action, "skip");
  assert.equal(reviewGate(earlier, "abcdef0123456789", true).action, "run");
  assert.equal(reviewGate(earlier, "ffffff0000000000", false).action, "run");
});

test("stops from the fourth round and tells the caller to escalate", () => {
  const rounds = ["a", "b", "c"].map((letter) => ({
    sha: letter.repeat(7),
    confidence: 3,
    actionable: 1,
  }));
  const gate = reviewGate(rounds, "ffffff0000000000", false);
  assert.equal(gate.action, "stop");
  assert.ok(gate.action === "stop" && gate.message.includes("ask the coordinator"));
  assert.equal(reviewGate(rounds, "ffffff0000000000", true).action, "run");
  assert.equal(reviewGate(rounds.slice(0, 2), "ffffff0000000000", false).action, "run");
});

test("a converged PR can still get its final commit reviewed after three rounds", () => {
  const rounds = [3, 3, 4].map((confidence, i) => ({
    sha: `${i}`.repeat(7),
    confidence,
    actionable: 0,
  }));
  assert.equal(reviewGate(rounds, "ffffff0000000000", false).action, "run");
});

test("follow-up replies create no review: only fixed verdicts touch a thread", () => {
  const actions = planThreadActions(
    [
      { threadId: "T1", verdict: "fixed", note: "Done." },
      { threadId: "T2", verdict: "not_fixed", note: "Still there." },
      { threadId: "gone", verdict: "fixed", note: "Unknown thread." },
    ],
    [thread({ id: "T1", firstCommentId: 5 }), thread({ id: "T2", firstCommentId: 6 })],
    "abc",
  );
  assert.deepEqual(actions, { replies: [{ commentId: 5, body: "Fixed: Done.\n\n<!-- local-review-fixed sha=abc -->" }], resolve: ["T1"] });
});

test("the review payload is one non-empty review with RIGHT-side inline comments", () => {
  const payload = buildReviewPayload("abc1234", "body text", [finding()]);
  assert.equal(payload.event, "COMMENT");
  assert.ok(payload.body.length > 0);
  assert.equal(payload.comments.length, 1);
  assert.equal(payload.comments[0]?.side, "RIGHT");
});

test("the last marker wins over one echoed in model text", () => {
  const forged = buildMarker({ sha: "aaaaaaa", confidence: 5, actionable: 0 });
  const body = renderBody({
    review: { confidence: 3, summary: `Looks fine ${forged}`, findings: [finding()] },
    sha: "bbbbbbb",
    outside: [],
    threadNotes: [],
  });
  assert.deepEqual(parseMarker(body), { sha: "bbbbbbb", confidence: 3, actionable: 1 });
});

test("unfixed earlier threads count as actionable in the marker", () => {
  const body = renderBody({
    review: { confidence: 3, summary: "s", findings: [] },
    sha: "bbbbbbb",
    outside: [],
    threadNotes: [],
    notFixed: 2,
  });
  assert.equal(parseMarker(body)?.actionable, 2);
});

test("scopeFindings keeps findings on files the delta deleted", () => {
  const kept = scopeFindings([finding({ path: "gone.ts", line: 3 })], new Map(), new Set(["gone.ts"]));
  assert.equal(kept.length, 1);
  assert.equal(scopeFindings([finding({ path: "other.ts" })], new Map(), new Set(["gone.ts"])).length, 0);
});

test("planThreadActions skips the reply only for threads of the pending attempt", () => {
  const thread = { id: "t", isResolved: false, path: "a.ts", line: 1, firstCommentId: 9, text: "x" };
  const verdicts = [{ threadId: "t", verdict: "fixed" as const, note: "done" }];
  assert.deepEqual(planThreadActions(verdicts, [thread], "abc", new Set(["t"])), { replies: [], resolve: ["t"] });
  assert.equal(planThreadActions(verdicts, [thread], "abc").replies.length, 1);
});

test("pendingAttempt rebuilds an incomplete attempt from timestamps", () => {
  const reply = (threadId: string, sha: string, at: string) => ({
    threadId,
    body: `Fixed: ok\n\n<!-- local-review-fixed sha=${sha} -->`,
    at,
  });
  const review = { sha: "abc1234", at: "2026-10-28T10:00:00Z" };
  // Reply newer than the head's review: the attempt never finished.
  const open = pendingAttempt({ head: "abc1234", reviews: [review], threadComments: [reply("t", "abc1234", "2026-10-28T10:05:00Z")] });
  assert.equal(open.incomplete, true);
  assert.deepEqual([...open.pendingThreadIds], ["t"]);
  // A completed attempt (reply older than the review) is not pending: a reopened thread gets a fresh reply.
  const done = pendingAttempt({ head: "abc1234", reviews: [review], threadComments: [reply("t", "abc1234", "2026-10-28T09:59:00Z")] });
  assert.equal(done.incomplete, false);
  // Replies of another head, and a head without a review, are handled.
  assert.equal(pendingAttempt({ head: "abc1234", reviews: [review], threadComments: [reply("t", "ffff", "2026-10-28T11:00:00Z")] }).incomplete, false);
  assert.equal(pendingAttempt({ head: "abc1234", reviews: [], threadComments: [reply("t", "abc1234", "2026-10-28T11:00:00Z")] }).incomplete, true);
  // The gate resumes an incomplete attempt without --force.
  const marker = { sha: "abc1234", confidence: 3, actionable: 1 };
  assert.equal(reviewGate([marker], "abc1234", false, false).action, "skip");
  assert.equal(reviewGate([marker], "abc1234", false, true).action, "run");
  // ...and it finishes a counted round, so the round limit does not stop it.
  const rounds = [1, 2, 3].map((n) => ({ sha: `a${n}`, confidence: 3, actionable: 1 }));
  assert.equal(reviewGate(rounds, "b9", false, false).action, "stop");
  assert.equal(reviewGate(rounds, "b9", false, true).action, "run");
});
