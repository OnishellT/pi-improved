import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePiStream, runFailure } from "../scripts/review/pi-stream.ts";

const event = (value: unknown) => JSON.stringify(value);
const assistant = (text: string, tokens: number, cost: number) =>
  event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hm" },
        { type: "text", text },
      ],
      usage: { totalTokens: tokens, cost: { total: cost } },
    },
  });

test("takes the text of the last assistant message and sums usage", () => {
  const stream = [
    event({ type: "agent_start" }),
    assistant("looking", 100, 0.001),
    event({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "x" }] },
    }),
    "not json",
    assistant("final answer", 50, 0.002),
    event({ type: "agent_settled" }),
  ].join("\n");
  assert.deepEqual(parsePiStream(stream), {
    text: "final answer",
    usage: { tokens: 150, costUsd: 0.003 },
  });
});

test("an empty stream yields empty text", () => {
  assert.equal(parsePiStream("").text, "");
});

const providerError = (message: string) =>
  event({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: message, usage: { totalTokens: 0 } },
  });
const limits = { timeoutMs: 3_600_000, idleMs: 120_000 };
const sharingLimit =
  "The ChatGPT user has reached their Subscription Sharing usage limit.\n  Try again in 4 hours.";

test("a provider error is reported with its text, and a usage limit is not retried", () => {
  const answer = parsePiStream([assistant("looking", 10, 0), providerError(sharingLimit)].join("\n"));
  assert.equal(answer.error, sharingLimit);
  const failure = runFailure({ code: 0, err: "" }, answer, limits);
  assert.equal(failure?.retry, false);
  assert.match(failure?.problem ?? "", /^provider usage limit: The ChatGPT user has reached their Subscription Sharing usage limit\. Try again in 4 hours\.\n/);
  assert.match(failure?.problem ?? "", /REVIEW_PROVIDER and REVIEW_MODEL/);
  const other = runFailure({ code: 0, err: "" }, parsePiStream(providerError("  502 bad gateway ")), limits);
  assert.deepEqual(other, { problem: "provider error: 502 bad gateway", retry: true });
});

test("an error that pi recovered from is not reported", () => {
  const answer = parsePiStream([providerError("overloaded"), assistant("final", 1, 0)].join("\n"));
  assert.equal(answer.error, undefined);
  assert.equal(runFailure({ code: 0, err: "" }, answer, limits), undefined);
});

test("a timeout names both limits; only the idle one is retried", () => {
  const empty = parsePiStream("");
  const total = runFailure({ code: -1, err: "", killed: "total" }, empty, limits);
  assert.equal(total?.retry, false);
  assert.match(total?.problem ?? "", /3600s in total.*REVIEW_TIMEOUT_MS \(now 3600000\).*REVIEW_IDLE_MS \(now 120000\)/);
  const idle = runFailure({ code: -1, err: "", killed: "idle" }, empty, limits);
  assert.equal(idle?.retry, true);
  assert.match(idle?.problem ?? "", /120s.*REVIEW_TIMEOUT_MS.*REVIEW_IDLE_MS/);
  assert.deepEqual(runFailure({ code: 0, err: "" }, empty, limits), { problem: "empty answer", retry: true });
  assert.deepEqual(runFailure({ code: 2, err: "boom\n" }, empty, limits), { problem: "exit 2: boom", retry: true });
});

test("a usage limit is found past the shown text; a transient error that mentions quota or billing is retried", () => {
  const late = `${"x ".repeat(200)}You exceeded your current quota.`;
  assert.equal(runFailure({ code: 0, err: "" }, parsePiStream(providerError(late)), limits)?.retry, false);
  for (const code of ["insufficient_quota", "quota_exceeded", "billing_hard_limit_reached"]) {
    assert.equal(runFailure({ code: 0, err: "" }, parsePiStream(providerError(`error: ${code}`)), limits)?.retry, false, code);
  }
  for (const transient of ["503 billing service unavailable", "quota service timed out, try again"]) {
    assert.equal(runFailure({ code: 0, err: "" }, parsePiStream(providerError(transient)), limits)?.retry, true, transient);
  }
});
