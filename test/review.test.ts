import * as fs from "node:fs/promises";
import * as path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBrief, parseVerdict, reviewDiff, subagentCost } from "../src/review.ts";
import { ownRuns } from "../src/subagent-view.ts";
import type { Task } from "../src/task-state.ts";
import { fakeSubagentExec, fifo, isSubagent, ok, tempDir, withEnv } from "./helpers.ts";

const task: Task = {
  id: "t1",
  title: "Add login",
  status: "implementing",
  allowedExtra: [],
  startedAt: "now",
  plan: { summary: "Login form summary", steps: ["step one"], files: ["src/login.ts"], decisions: [{ id: "d1", question: "Which hash?", options: [], status: "decided", answer: "argon2" }], interface: [], seams: [] },
};

const fakeExec = (opts: { spawn?: any; wait?: any; stop?: any } = {}) =>
  fakeSubagentExec({ ...opts, git: (args) => (args[0] === "diff" ? "+const x = 1;" : "new.ts\0.pi/task.json\0.pi/skills/x/SKILL.md\0") });

test("approved verdict; brief has plan and diff; read-only spawn; run is stopped", async () => {
  const f = fakeExec({ wait: ok("a1b2c3 finished\n\nLooks fine.\nVERDICT: APPROVED\n") });
  const r = await reviewDiff(f.exec, "/repo", task, "anthropic/claude-opus-4");
  assert.equal(r.status, "approved");
  const spawn = f.calls.find((c) => c.args[0] === "spawn")!;
  assert.ok(isSubagent(spawn.cmd));
  assert.deepEqual(spawn.args.slice(spawn.args.indexOf("--provider"), spawn.args.indexOf("--provider") + 4), ["--provider", "anthropic", "--model", "claude-opus-4"]);
  assert.equal(spawn.args[spawn.args.indexOf("--tools") + 1], "read,grep,find,ls,codemode,mcp__none");
  assert.match(f.brief(), /Add login[\s\S]*Login form summary[\s\S]*step one[\s\S]*src\/login\.ts[\s\S]*argon2[\s\S]*new\.ts[\s\S]*\+const x = 1;/);
  assert.doesNotMatch(f.brief(), /task\.json|SKILL\.md/);
  assert.ok(f.calls.some((c) => c.args[0] === "stop" && c.args[1] === "a1b2c3"));
  assert.ok(!ownRuns.has("a1b2c3"));
});

test("a run that would not stop stays listed as this session's", async () => {
  const f = fakeExec({ wait: ok("VERDICT: APPROVED\n"), stop: { ...ok(), code: 1 } });
  await reviewDiff(f.exec, "/repo", task, "anthropic/claude-opus-4");
  try {
    assert.ok(ownRuns.has("a1b2c3"));
  } finally {
    ownRuns.delete("a1b2c3");
  }
});

test("the diff is taken against the task's baseCommit, the empty tree without any base", async () => {
  const hash = "c".repeat(40);
  const diffArgs = (calls: { cmd: string; args: string[] }[]) => calls.find((c) => c.cmd === "git" && c.args[0] === "diff")!.args[1];
  const withBase = fakeExec();
  await reviewDiff(withBase.exec, "/repo", { ...task, baseCommit: hash } as any, "p/m");
  assert.equal(diffArgs(withBase.calls), hash);
  assert.match(withBase.brief(), new RegExp(`## Diff \\(git diff ${hash}\\)`));
  const without = fakeExec();
  await reviewDiff(without.exec, "/repo", task as any, "p/m");
  assert.equal(diffArgs(without.calls), "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
});

test("changes verdict keeps the findings", async () => {
  const f = fakeExec({ wait: ok("h finished\n\nthinking\nVERDICT: CHANGES\n1. src/a.ts: null deref\n") });
  const r = await reviewDiff(f.exec, "/repo", task, "p/m");
  assert.equal(r.status, "changes");
  assert.match(r.report, /VERDICT: CHANGES\n1\. src\/a\.ts: null deref/);
});

test("skipped on spawn failure, missing verdict, wait failure, bad model", async () => {
  const bad = { stdout: "", stderr: "tmux not found", code: 1, killed: false };
  assert.match((await reviewDiff(fakeExec({ spawn: bad }).exec, "/r", task, "p/m")).report, /tmux not found/);
  const noVerdict = ok("h finished\n\nhmm");
  assert.equal((await reviewDiff(fakeExec({ wait: noVerdict }).exec, "/r", task, "p/m")).status, "skipped");
  const timeout = { stdout: "", stderr: "Timed out after 600s", code: 1, killed: false };
  assert.equal((await reviewDiff(fakeExec({ wait: timeout }).exec, "/r", task, "p/m")).status, "skipped");
  assert.equal((await reviewDiff(fakeExec().exec, "/r", task, "nomodel")).status, "skipped");
  const throwing: any = async () => { throw new Error("ENOENT subagent"); };
  assert.match((await reviewDiff(throwing, "/r", task, "p/m")).report, /git diff failed/);
});

test("truncates a huge diff and says so", async () => {
  const f = fakeExec({ wait: ok("VERDICT: APPROVED") });
  const exec: any = (cmd: string, args: string[], o: any) => (cmd === "git" && args[0] === "diff" ? Promise.resolve(ok("x".repeat(70_000))) : f.exec(cmd, args, o));
  await reviewDiff(exec, "/r", task, "p/m");
  assert.match(f.brief(), /TRUNCATED/);
});

test("parseVerdict uses the last verdict", () => {
  assert.equal(parseVerdict("VERDICT: CHANGES\nx\nVERDICT: APPROVED")?.status, "approved");
  assert.equal(parseVerdict("**VERDICT: APPROVED**")?.status, "approved");
});

test("an aborted review stops its subagent and reports itself as cancelled", async () => {
  const root = await tempRepoForAbort();
  const calls: string[] = [];
  const controller = new AbortController();
  const exec = async (cmd: string, args: string[], opts: any) => {
    if (cmd === "git") return { stdout: args[0] === "diff" ? "diff --git a/x b/x\n+1" : "", stderr: "", code: 0, killed: false };
    if (cmd === "tmux") return ok("");
    calls.push(args[0]);
    if (args[0] === "spawn") return ok("Spawned review (abc123)");
    if (args[0] === "wait") {
      // Like pi.exec: an abort kills the waiting process.
      const killed = new Promise<any>((resolve) => opts.signal.addEventListener("abort", () => resolve({ stdout: "", stderr: "", code: 1, killed: true })));
      controller.abort();
      return killed;
    }
    return ok("");
  };
  const result = await reviewDiff(exec as any, root, { id: "t", title: "x", status: "implementing", allowedExtra: [], startedAt: "" } as any, "p/m", controller.signal);
  assert.equal(result.cancelled, true);
  assert.deepEqual(calls, ["spawn", "wait", "stop"]);
});

test("subagentCost sums the child's assistant costs", async () => {
  const dir = await tempDir("runs-");
  const run = path.join(dir, "r1");
  await fs.mkdir(run);
  const session = path.join(run, "session.jsonl");
  await fs.writeFile(session, [{ message: { role: "user" } }, { message: { role: "assistant", usage: { cost: { total: 0.01 } } } }, { message: { role: "assistant", usage: { cost: { total: 0.02 } } } }].map((e) => JSON.stringify(e)).join("\n"));
  await fs.writeFile(path.join(run, "metadata.json"), JSON.stringify({ handle: "abc123", sessionFile: session }));
  assert.equal(Math.round((await subagentCost("abc123", dir))! * 100) / 100, 0.03);
  assert.equal(await subagentCost("other", dir), undefined);
});

test("subagentCost skips a corrupt run of another subagent", async () => {
  const dir = await tempDir("runs-");
  await fs.mkdir(path.join(dir, "a-bad"));
  await fs.writeFile(path.join(dir, "a-bad", "metadata.json"), "{bad");
  const run = path.join(dir, "r1");
  await fs.mkdir(run);
  await fs.writeFile(path.join(run, "session.jsonl"), JSON.stringify({ message: { role: "assistant", usage: { cost: { total: 0.5 } } } }));
  await fs.writeFile(path.join(run, "metadata.json"), JSON.stringify({ handle: "abc123", sessionFile: path.join(run, "session.jsonl") }));
  assert.equal(await subagentCost("abc123", dir), 0.5);
});

test("a spawn without a real handle is not guessed from stray parentheses", async () => {
  const f = fakeExec({ spawn: ok("warning: fade (add) failed\nState: busy\n") });
  const r = await reviewDiff(f.exec, "/repo", task, "p/m");
  assert.equal(r.status, "skipped");
  assert.match(r.report, /Could not start the review/);
  assert.ok(!f.calls.some((c) => c.args[0] === "wait"));
});

async function tempRepoForAbort() {
  return tempDir("review-abort-");
}

test("brief inlines new files and keeps blocking-only rules", () => {
  const brief = buildBrief({ id: "t", title: "T", status: "implementing", allowedExtra: [], startedAt: "now" } as any, { diff: "", truncated: false, untracked: ["a.ts", "big.ts"], contents: { "a.ts": "export const a = 1;" } });
  assert.match(brief, /### a\.ts\n```\nexport const a = 1;/);
  assert.match(brief, /- big\.ts \(read it directly\)/);
  assert.match(brief, /CHANGES is only for blocking problems/);
});

test("brief shows interface, seams and the optional skills block", () => {
  const task = { id: "t", title: "T", status: "implementing", allowedExtra: [], startedAt: "now", plan: { summary: "s", steps: [], files: [], decisions: [], interface: [{ file: "src/a.ts", exports: ["a"], signatures: ["a(): number"], source: "ticket" }], seams: [{ name: "a", testFile: "test/a.test.ts", catches: "wrong value", misses: "io" }] } } as any;
  const d = { diff: "", truncated: false, untracked: [] };
  const brief = buildBrief(task, d, "## Skill: tdd");
  assert.match(brief, /^# Diff review: T\n## Skill: tdd/);
  assert.match(brief, /## Interface\n- src\/a\.ts → a; a\(\): number \(source: ticket\)[\s\S]*BLOCKING/);
  assert.match(brief, /## Seams\n- a → test\/a\.test\.ts: catches wrong value; misses io/);
  assert.doesNotMatch(buildBrief(task, d), /Skill: tdd/);
});

test("an untracked file over the budget is skipped without being read; small ones are inlined", async () => {
  const root = await tempDir("pi-review-");
  await fs.writeFile(path.join(root, "big.bin"), "x".repeat(70_000));
  await fs.writeFile(path.join(root, "small.ts"), "export const a = 1;");
  const f = fakeExec({ wait: ok("VERDICT: APPROVED") });
  const exec: any = (cmd: string, args: string[], o: any) => (cmd === "git" && args[0] === "ls-files" ? Promise.resolve(ok("big.bin\0small.ts\0")) : f.exec(cmd, args, o));
  await reviewDiff(exec, root, task, "p/m");
  assert.match(f.brief(), /- big\.bin \(read it directly\)/);
  assert.match(f.brief(), /### small\.ts\n```\nexport const a = 1;/);
});

test("a new link or FIFO is named for what it is, never read into the brief or sent to be read", { timeout: 10_000 }, async (t) => {
  const root = await tempDir("pi-review-");
  await fs.writeFile(path.join(root, "secret.txt"), "token = 1");
  fifo(t, path.join(root, "pipe"));
  await fs.symlink("pipe", path.join(root, "to-pipe"));
  await fs.symlink("secret.txt", path.join(root, "to-secret"));
  const f = fakeExec({ wait: ok("VERDICT: APPROVED") });
  const exec: any = (cmd: string, args: string[], o: any) => (cmd === "git" && args[0] === "ls-files" ? Promise.resolve(ok("pipe\0to-pipe\0to-secret\0")) : f.exec(cmd, args, o));
  await reviewDiff(exec, root, task, "p/m");
  assert.match(f.brief(), /- pipe \(not a regular file; do not read it\)\n- to-pipe \(a symlink to "pipe"; do not read it\)\n- to-secret \(a symlink to "secret\.txt"; do not read it\)/);
  assert.doesNotMatch(f.brief(), /token = 1/);
});

test("a new file named like an object property is inlined, not mistaken for a note", () => {
  const brief = buildBrief(task, { diff: "", truncated: false, untracked: ["constructor", "toString"], contents: { constructor: "x = 1" }, notes: {} });
  assert.match(brief, /### constructor\n```\nx = 1\n```\n- toString \(read it directly\)/);
});

test("the review brief carries the plan's intent when there is one, and nothing when an old plan has none", () => {
  const diff = { diff: "", truncated: false, untracked: [] };
  assert.match(buildBrief({ ...task, plan: { ...task.plan, intent: "Let people log in" } } as any, diff), /Login form summary\nIntent \(the ticket, restated\): Let people log in\n### Steps/);
  assert.doesNotMatch(buildBrief(task as any, diff), /Intent/);
});

test("the review brief shows each interface entry's usage line", () => {
  const plan = { ...task.plan, interface: [{ file: "src/fee.ts", exports: ["fee"], usage: "fee(100)", source: "ticket" }, { file: "src/m.ts", exports: ["m"] }] };
  const brief = buildBrief({ ...task, plan } as any, { diff: "", truncated: false, untracked: [] });
  assert.match(brief, /- src\/fee\.ts → fee \(source: ticket\) \(usage: fee\(100\)\)\n- src\/m\.ts → m\n/);
});

test("the brief lists the verify commands and the automated warnings, and leaves both out when empty", () => {
  const d = { diff: "d", truncated: false, untracked: [] };
  const brief = buildBrief(task, { ...d, verify: ["pytest -q", "ruff check"], warnings: ["Commented-out code in added lines (remove it instead):", "- a.py: # x = 1"] });
  assert.match(brief, /## Verify\n.*do not claim you did\.\n- `pytest -q`\n- `ruff check`\n## Automated warnings\n.*\nCommented-out code[\s\S]*- a\.py: # x = 1\n## Diff/);
  assert.doesNotMatch(buildBrief(task, d), /## Verify|## Automated warnings/);
});
