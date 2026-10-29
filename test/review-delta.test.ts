import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { planDelta, type GitRun } from "../scripts/review/delta.ts";
import { renderBody } from "../scripts/review/result.ts";
import { tempDir } from "./helpers.ts";

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

async function repo() {
  const dir = await tempDir("review-delta-");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = (file: string, text: string) => {
    writeFileSync(join(dir, file), text);
    git("add", file);
    git("commit", "-q", "-m", `${file}: ${text}`);
    return git("rev-parse", "HEAD");
  };
  const run: GitRun = async (args) => {
    const result = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    return { code: result.status ?? -1, out: result.stdout };
  };
  git("init", "-q", "-b", "main");
  commit("base.txt", "1");
  git("checkout", "-q", "-b", "pr");
  const reviewed = commit("pr.txt", "1");
  return { git, commit, run, reviewed };
}

test("a normal follow-up reviews the delta since the last reviewed commit", async () => {
  const { git, commit, run, reviewed } = await repo();
  const head = commit("pr.txt", "2");
  // The base moving on without the PR following it does not matter.
  git("checkout", "-q", "main");
  commit("base.txt", "2");
  assert.deepEqual(await planDelta(run, reviewed, head, "main"), {
    mode: "delta",
    range: `${reviewed}..${head}`,
  });
});

test("a rebase onto a moved base falls back to a full review", async () => {
  const { git, commit, run, reviewed } = await repo();
  git("checkout", "-q", "main");
  commit("base.txt", "2");
  git("checkout", "-q", "pr");
  commit("pr.txt", "2");
  git("rebase", "-q", "main");
  const plan = await planDelta(run, reviewed, git("rev-parse", "HEAD"), "main");
  assert.equal(plan.mode, "full");
  assert.match(plan.mode === "full" ? (plan.reason ?? "") : "", /newer main/);
});

test("merging a moved base into the branch falls back to a full review", async () => {
  const { git, commit, run, reviewed } = await repo();
  git("checkout", "-q", "main");
  commit("base.txt", "2");
  git("checkout", "-q", "pr");
  git("merge", "-q", "--no-edit", "main");
  const plan = await planDelta(run, reviewed, git("rev-parse", "HEAD"), "main");
  assert.equal(plan.mode, "full");
  assert.match(plan.mode === "full" ? (plan.reason ?? "") : "", /newer main/);
});

test("a force-push that rewrites history falls back to a full review", async () => {
  const { git, commit, run, reviewed } = await repo();
  git("reset", "-q", "--hard", "main");
  const head = commit("pr.txt", "rewritten");
  const plan = await planDelta(run, reviewed, head, "main");
  assert.equal(plan.mode, "full");
  assert.match(plan.mode === "full" ? (plan.reason ?? "") : "", /history was rewritten/);
});

test("a last reviewed commit that is gone falls back to a full review", async () => {
  const { run, reviewed } = await repo();
  const plan = await planDelta(run, "f".repeat(40), reviewed, "main");
  assert.equal(plan.mode, "full");
  assert.match(plan.mode === "full" ? (plan.reason ?? "") : "", /no longer available/);
});

test("a first review, or a rerun on the reviewed head, is a plain full review", async () => {
  const { run, reviewed } = await repo();
  assert.deepEqual(await planDelta(run, undefined, reviewed, "main"), { mode: "full" });
  assert.deepEqual(await planDelta(run, reviewed.slice(0, 7), reviewed, "main"), { mode: "full" });
});

test("the review summary says when a follow-up round became a full review", () => {
  const input = {
    review: { summary: "Looks fine.", confidence: 5, findings: [] },
    sha: "a".repeat(40),
    outside: [],
    threadNotes: [],
  };
  const note = "Full review instead of a follow-up: history was rewritten since the last reviewed commit abc1234.";
  const body = renderBody({ ...input, note });
  assert.ok(body.includes(`_${note}_`));
  assert.ok(body.indexOf(note) < body.indexOf("Looks fine."));
  assert.ok(!renderBody(input).includes("Full review"));
});
