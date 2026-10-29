import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkContextSize,
  contextDocs,
  linkedIssueBodies,
  linkedIssues,
  maxContextChars,
  reviewablePaths,
  skipsMarkdownOnly,
} from "../scripts/review/context.ts";

test("context documents: root files first, then docs/*.md sorted", () => {
  assert.deepEqual(contextDocs(["WORKFLOW.md", "notes.txt", "COMPUTER.md"]), [
    "CLAUDE.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "README.md",
    "docs/COMPUTER.md",
    "docs/WORKFLOW.md",
  ]);
});

test("Markdown-only changes need no review", () => {
  assert.deepEqual(reviewablePaths(["README.md", "docs/x.md"]), []);
  assert.deepEqual(reviewablePaths(["src/a.ts", "docs/x.md"]), ["src/a.ts"]);
});

test("finds linked issues in the PR body", () => {
  assert.deepEqual(linkedIssues("Closes #97\n\nalso fixes #12 and Closes #97"), [97, 12]);
  assert.deepEqual(linkedIssues("no links"), []);
});

test("a Markdown-only diff is skipped unless an earlier review needs a follow-up", () => {
  assert.equal(skipsMarkdownOnly(["a.md"], false, undefined), true);
  assert.equal(skipsMarkdownOnly(["a.ts"], false, undefined), false);
  // Head B restored the code that head A changed: the delta still holds code.
  assert.equal(skipsMarkdownOnly(["a.md"], true, ["a.md", "src/x.ts"]), false);
  assert.equal(skipsMarkdownOnly(["a.md"], true, undefined), false);
  assert.equal(skipsMarkdownOnly(["a.md"], true, ["a.md"]), true);
});

test("an unreadable linked issue is skipped, not fatal", async () => {
  const issues = await linkedIssueBodies("Fixes #1. Fixes #99999.", async (number) => {
    if (number === 99999) throw new Error("Could not resolve to an issue");
    return `body ${number}`;
  });
  assert.deepEqual(issues, [{ number: 1, body: "body 1" }]);
  await assert.rejects(
    linkedIssueBodies("Fixes #2", async () => {
      throw new Error("HTTP 502");
    }),
    /HTTP 502/,
  );
});

test("an oversized review context fails before the reviewer runs", () => {
  checkContextSize("x".repeat(maxContextChars));
  assert.throws(() => checkContextSize("x".repeat(maxContextChars + 1)), /split the pull request/);
});
