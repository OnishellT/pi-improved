import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVerdict, reviewDiff, subagentCost } from "../src/review.ts";
import type { Task } from "../src/task-state.ts";

const task: Task = {
  id: "t1",
  title: "Add login",
  status: "implementing",
  allowedExtra: [],
  startedAt: "now",
  plan: { summary: "Login form summary", steps: ["step one"], files: ["src/login.ts"], decisions: [{ id: "d1", question: "Which hash?", options: [], status: "decided", answer: "argon2" }] },
};

function fakeExec(opts: { spawn?: any; wait?: any } = {}) {
  const calls: { cmd: string; args: string[] }[] = [];
  let brief = "";
  const exec: any = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const ok = { stdout: "", stderr: "", code: 0, killed: false };
    if (cmd === "git") return { ...ok, stdout: args[0] === "diff" ? "+const x = 1;" : "new.ts\n.pi/task.json\n" };
    if (args[0] === "spawn") {
      brief = readFileSync(args[args.indexOf("--file") + 1], "utf8");
      return opts.spawn ?? { ...ok, stdout: "Spawned review (a1b2c3)\nState: busy\n" };
    }
    if (args[0] === "wait") return opts.wait ?? ok;
    return ok;
  };
  return { exec, calls, brief: () => brief };
}

test("approved verdict; brief has plan and diff; read-only spawn; run is stopped", async () => {
  const f = fakeExec({ wait: { stdout: "a1b2c3 finished\n\nLooks fine.\nVERDICT: APPROVED\n", stderr: "", code: 0, killed: false } });
  const r = await reviewDiff(f.exec, "/repo", task, "anthropic/claude-opus-4");
  assert.equal(r.status, "approved");
  const spawn = f.calls.find((c) => c.args[0] === "spawn")!;
  assert.equal(spawn.cmd, "subagent");
  assert.deepEqual(spawn.args.slice(spawn.args.indexOf("--provider"), spawn.args.indexOf("--provider") + 4), ["--provider", "anthropic", "--model", "claude-opus-4"]);
  assert.equal(spawn.args[spawn.args.indexOf("--tools") + 1], "read,grep,find,ls");
  assert.match(f.brief(), /Add login[\s\S]*Login form summary[\s\S]*step one[\s\S]*src\/login\.ts[\s\S]*argon2[\s\S]*new\.ts[\s\S]*\+const x = 1;/);
  assert.doesNotMatch(f.brief(), /task\.json/);
  assert.ok(f.calls.some((c) => c.args[0] === "stop" && c.args[1] === "a1b2c3"));
});

test("changes verdict keeps the findings", async () => {
  const f = fakeExec({ wait: { stdout: "h finished\n\nthinking\nVERDICT: CHANGES\n1. src/a.ts: null deref\n", stderr: "", code: 0, killed: false } });
  const r = await reviewDiff(f.exec, "/repo", task, "p/m");
  assert.equal(r.status, "changes");
  assert.match(r.report, /VERDICT: CHANGES\n1\. src\/a\.ts: null deref/);
});

test("skipped on spawn failure, missing verdict, wait failure, bad model", async () => {
  const bad = { stdout: "", stderr: "tmux not found", code: 1, killed: false };
  assert.match((await reviewDiff(fakeExec({ spawn: bad }).exec, "/r", task, "p/m")).report, /tmux not found/);
  const noVerdict = { stdout: "h finished\n\nhmm", stderr: "", code: 0, killed: false };
  assert.equal((await reviewDiff(fakeExec({ wait: noVerdict }).exec, "/r", task, "p/m")).status, "skipped");
  const timeout = { stdout: "", stderr: "Timed out after 600s", code: 1, killed: false };
  assert.equal((await reviewDiff(fakeExec({ wait: timeout }).exec, "/r", task, "p/m")).status, "skipped");
  assert.equal((await reviewDiff(fakeExec().exec, "/r", task, "nomodel")).status, "skipped");
  const throwing: any = async () => { throw new Error("ENOENT subagent"); };
  assert.match((await reviewDiff(throwing, "/r", task, "p/m")).report, /ENOENT/);
});

test("truncates a huge diff and says so", async () => {
  const f = fakeExec({ wait: { stdout: "VERDICT: APPROVED", stderr: "", code: 0, killed: false } });
  const exec: any = (cmd: string, args: string[], o: any) => (cmd === "git" && args[0] === "diff" ? Promise.resolve({ stdout: "x".repeat(70_000), stderr: "", code: 0, killed: false }) : f.exec(cmd, args, o));
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
    calls.push(args[0]);
    if (args[0] === "spawn") return { stdout: "Spawned review (abc123)", stderr: "", code: 0, killed: false };
    if (args[0] === "wait") {
      // Like pi.exec: an abort kills the waiting process.
      const killed = new Promise<any>((resolve) => opts.signal.addEventListener("abort", () => resolve({ stdout: "", stderr: "", code: 1, killed: true })));
      controller.abort();
      return killed;
    }
    return { stdout: "", stderr: "", code: 0, killed: false };
  };
  const result = await reviewDiff(exec as any, root, { id: "t", title: "x", status: "implementing", allowedExtra: [], startedAt: "" } as any, "p/m", controller.signal);
  assert.equal(result.cancelled, true);
  assert.deepEqual(calls, ["spawn", "wait", "stop"]);
});

test("subagentCost sums the child's assistant costs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runs-"));
  const run = path.join(dir, "r1");
  await fs.mkdir(run);
  const session = path.join(run, "session.jsonl");
  await fs.writeFile(session, [{ message: { role: "user" } }, { message: { role: "assistant", usage: { cost: { total: 0.01 } } } }, { message: { role: "assistant", usage: { cost: { total: 0.02 } } } }].map((e) => JSON.stringify(e)).join("\n"));
  await fs.writeFile(path.join(run, "metadata.json"), JSON.stringify({ handle: "abc123", sessionFile: session }));
  assert.equal(Math.round((await subagentCost("abc123", dir))! * 100) / 100, 0.03);
  assert.equal(await subagentCost("other", dir), undefined);
});

async function tempRepoForAbort() {
  return fs.mkdtemp(path.join(os.tmpdir(), "review-abort-"));
}
