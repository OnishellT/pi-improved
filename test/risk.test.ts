import assert from "node:assert/strict";
import { test } from "node:test";
import { assessRisk } from "../src/risk.ts";
import type { Manifest } from "../src/manifest.ts";
import { tempProject } from "./helpers.ts";

const base: Manifest = { version: 1, setup: "done", verify: [], connectors: [], review: { minLevel: "low" } };
const plan = { summary: "", steps: [], files: [], decisions: [] as any[], interface: [], seams: [] };
const task: any = { id: "t", title: "T", status: "implementing", allowedExtra: [], startedAt: "", plan };

const exec = (numstat: [string, number][], untracked: string[] = []): any => async (_cmd: string, args: string[]) => ({
  code: 0, stderr: "", killed: false,
  stdout: args.includes("--numstat") ? numstat.map(([f, n]) => `${n}\t0\t${f}`).join("\n") : args[0] === "ls-files" ? untracked.join("\n") : "",
});
const risk = async (e: any, t: any = task, m: Manifest = base) => assessRisk(e, await tempProject({}), t === null ? undefined : t, m);

test("a small ordinary diff with a plan is low risk", async () => {
  assert.deepEqual(await risk(exec([["src/a.ts", 10], ["src/b.ts", 5]])), { review: false, level: "none", reasons: [] });
});

test("size thresholds: > 200 lines or > 6 files", async () => {
  assert.match((await risk(exec([["src/a.ts", 201]]))).reasons[0], /201 lines/);
  assert.equal((await risk(exec([["src/a.ts", 200]]))).review, false);
  const seven = Array.from({ length: 7 }, (_, i) => [`src/f${i}.ts`, 1] as [string, number]);
  assert.match((await risk(exec(seven))).reasons[0], /7 files/);
  assert.equal((await risk(exec(seven.slice(0, 6)))).review, false);
});

test("untracked files count towards the diff", async () => {
  assert.match((await risk(exec([], ["a", "b", "c", "d", "e", "f", "g"]))).reasons[0], /7 files/);
});

test("dependency manifests, lockfiles and migrations", async () => {
  for (const f of ["package.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "requirements-dev.txt", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile"]) {
    assert.match((await risk(exec([[f, 1]]))).reasons.join(), /dependencies/, f);
  }
  assert.match((await risk(exec([["db/migrate/001_x.rb", 1]]))).reasons.join(), /migration/);
});

test("sensitive directories", async () => {
  for (const f of ["src/auth/login.ts", "app/payments/charge.ts", "billing/x.py", "lib/crypto/aes.ts", "infra/main.tf", "security/policy.ts"]) {
    assert.match((await risk(exec([[f, 1]]))).reasons.join(), /sensitive zone/, f);
  }
  assert.equal((await risk(exec([["src/author.ts", 1]]))).review, false);
});

test("review.paths globs", async () => {
  const m = { ...base, review: { paths: ["src/core/**", "*.sql"] } };
  assert.match((await risk(exec([["src/core/deep/x.ts", 1]]), task, m)).reasons.join(), /review\.paths/);
  assert.equal((await risk(exec([["src/other/x.ts", 1]]), task, m)).review, false);
});

test("plan: missing plan or decisions answered by the user", async () => {
  assert.deepEqual((await risk(exec([["a.ts", 1]]), { ...task, plan: undefined })).reasons, ["no plan"]);
  assert.deepEqual((await risk(exec([["a.ts", 1]]), null)).reasons, ["no plan"]);
  const decided = { ...task, plan: { ...plan, decisions: [{ id: "d", question: "?", options: [], status: "decided", answer: "x" }] } };
  assert.equal((await risk(exec([["a.ts", 1]]), decided)).review, true);
  const documented = { ...task, plan: { ...plan, decisions: [{ id: "d", question: "?", options: [], status: "documented" }] } };
  assert.equal((await risk(exec([["a.ts", 1]]), documented)).review, false);
});

test("always forces and never disables", async () => {
  assert.equal((await risk(exec([]), task, { ...base, review: { always: true } })).review, true);
  assert.equal((await risk(exec([["package.json", 900]]), task, { ...base, review: { never: true } })).review, false);
});

test("levels: none, low, high with the default thresholds", async () => {
  assert.equal((await risk(exec([["src/a.ts", 10]]))).level, "none");
  assert.equal((await risk(exec([["src/a.ts", 201]]))).level, "low");
  assert.equal((await risk(exec([["src/a.ts", 600]]))).level, "low");
  assert.equal((await risk(exec([["src/a.ts", 601]]))).level, "high");
  const sixteen = Array.from({ length: 16 }, (_, i) => [`src/f${i}.ts`, 1] as [string, number]);
  assert.equal((await risk(exec(sixteen.slice(0, 15)))).level, "low");
  assert.equal((await risk(exec(sixteen))).level, "high");
  assert.equal((await risk(exec([["package.json", 1]]))).level, "high");
  assert.equal((await risk(exec([["a.ts", 1]]), null)).level, "low");
});

test("thresholds are configurable and high never sits below low", async () => {
  const m = { ...base, review: { minLevel: "low" as const, maxLines: 10, highLines: 50, maxFiles: 2, highFiles: 3 } };
  assert.equal((await risk(exec([["a.ts", 11]]), task, m)).level, "low");
  assert.equal((await risk(exec([["a.ts", 51]]), task, m)).level, "high");
  assert.equal((await risk(exec([["a.ts", 1], ["b.ts", 1], ["c.ts", 1]]), task, m)).level, "low");
  assert.equal((await risk(exec([["a.ts", 1], ["b.ts", 1], ["c.ts", 1], ["d.ts", 1]]), task, m)).level, "high");
  const inverted = { ...base, review: { minLevel: "low" as const, maxLines: 100, highLines: 10 } };
  assert.equal((await risk(exec([["a.ts", 100]]), task, inverted)).level, "none");
  assert.equal((await risk(exec([["a.ts", 101]]), task, inverted)).level, "high");
});

test("minLevel decides when a review is requested; default is off; always beats never", async () => {
  const med = exec([["src/a.ts", 300]]);
  const high = exec([["package.json", 1]]);
  const withLevel = (minLevel?: any) => ({ ...base, review: { minLevel } });
  assert.deepEqual([(await risk(med, task, withLevel())).review, (await risk(high, task, withLevel())).review], [false, false]);
  assert.deepEqual([(await risk(med, task, withLevel("off"))).review, (await risk(high, task, withLevel("off"))).review], [false, false]);
  assert.deepEqual([(await risk(med, task, withLevel("low"))).review, (await risk(high, task, withLevel("low"))).review], [true, true]);
  assert.deepEqual([(await risk(med, task, withLevel("high"))).review, (await risk(high, task, withLevel("high"))).review], [false, true]);
  assert.equal((await risk(high, task, withLevel())).level, "high");
  const both = await risk(med, task, { ...base, review: { always: true, never: true } });
  assert.deepEqual([both.review, both.level], [true, "high"]);
});

test("the diff is measured against the task's baseCommit when it resolves, else HEAD", async () => {
  const hash = "b".repeat(40);
  const seen: string[] = [];
  const e: any = async (_cmd: string, args: string[]) => {
    if (args[0] === "diff") seen.push(args[1]);
    return { code: 0, stderr: "", killed: false, stdout: args[0] === "rev-parse" ? `${hash}\n` : args[0] === "diff" ? "700\t0\tsrc/a.ts" : "" };
  };
  assert.equal((await risk(e, { ...task, baseCommit: hash })).level, "high");
  await risk(e, { ...task, baseCommit: "not a hash; rm" });
  await risk(e);
  const gone: any = async (_cmd: string, args: string[]) => ({ code: 0, stderr: "", killed: false, stdout: args[0] === "diff" ? (seen.push(args[1]), "") : "" });
  await risk(gone, { ...task, baseCommit: hash });
  assert.deepEqual(seen, [hash, "HEAD", "HEAD", "HEAD"]);
});

test("git failures degrade to no diff", async () => {
  const boom: any = async () => { throw new Error("no git"); };
  assert.equal((await risk(boom)).review, false);
});
