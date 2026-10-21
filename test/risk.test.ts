import assert from "node:assert/strict";
import { test } from "node:test";
import { assessRisk } from "../src/risk.ts";
import type { Manifest } from "../src/manifest.ts";
import { tempProject } from "./helpers.ts";

const base: Manifest = { version: 1, setup: "done", verify: [], connectors: [] };
const plan = { summary: "", steps: [], files: [], decisions: [] as any[], interface: [], seams: [] };
const task: any = { id: "t", title: "T", status: "implementing", allowedExtra: [], startedAt: "", plan };

const exec = (numstat: [string, number][], untracked: string[] = []): any => async (_cmd: string, args: string[]) => ({
  code: 0, stderr: "", killed: false,
  stdout: args.includes("--numstat") ? numstat.map(([f, n]) => `${n}\t0\t${f}`).join("\n") : args[0] === "ls-files" ? untracked.join("\n") : "",
});
const risk = async (e: any, t: any = task, m: Manifest = base) => assessRisk(e, await tempProject({}), t === null ? undefined : t, m);

test("a small ordinary diff with a plan is low risk", async () => {
  assert.deepEqual(await risk(exec([["src/a.ts", 10], ["src/b.ts", 5]])), { review: false, reasons: [] });
});

test("size thresholds: > 200 lines or > 6 files", async () => {
  assert.match((await risk(exec([["src/a.ts", 201]]))).reasons[0], /201 líneas/);
  assert.equal((await risk(exec([["src/a.ts", 200]]))).review, false);
  const seven = Array.from({ length: 7 }, (_, i) => [`src/f${i}.ts`, 1] as [string, number]);
  assert.match((await risk(exec(seven))).reasons[0], /7 archivos/);
  assert.equal((await risk(exec(seven.slice(0, 6)))).review, false);
});

test("untracked files count towards the diff", async () => {
  assert.match((await risk(exec([], ["a", "b", "c", "d", "e", "f", "g"]))).reasons[0], /7 archivos/);
});

test("dependency manifests, lockfiles and migrations", async () => {
  for (const f of ["package.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "requirements-dev.txt", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile"]) {
    assert.match((await risk(exec([[f, 1]]))).reasons.join(), /dependencias/, f);
  }
  assert.match((await risk(exec([["db/migrate/001_x.rb", 1]]))).reasons.join(), /migración/);
});

test("sensitive directories", async () => {
  for (const f of ["src/auth/login.ts", "app/payments/charge.ts", "billing/x.py", "lib/crypto/aes.ts", "infra/main.tf", "security/policy.ts"]) {
    assert.match((await risk(exec([[f, 1]]))).reasons.join(), /zona sensible/, f);
  }
  assert.equal((await risk(exec([["src/author.ts", 1]]))).review, false);
});

test("review.paths globs", async () => {
  const m = { ...base, review: { paths: ["src/core/**", "*.sql"] } };
  assert.match((await risk(exec([["src/core/deep/x.ts", 1]]), task, m)).reasons.join(), /review\.paths/);
  assert.equal((await risk(exec([["src/other/x.ts", 1]]), task, m)).review, false);
});

test("plan: missing plan or decisions answered by the user", async () => {
  assert.deepEqual((await risk(exec([["a.ts", 1]]), { ...task, plan: undefined })).reasons, ["sin plan"]);
  assert.deepEqual((await risk(exec([["a.ts", 1]]), null)).reasons, ["sin plan"]);
  const decided = { ...task, plan: { ...plan, decisions: [{ id: "d", question: "?", options: [], status: "decided", answer: "x" }] } };
  assert.equal((await risk(exec([["a.ts", 1]]), decided)).review, true);
  const documented = { ...task, plan: { ...plan, decisions: [{ id: "d", question: "?", options: [], status: "documented" }] } };
  assert.equal((await risk(exec([["a.ts", 1]]), documented)).review, false);
});

test("always forces and never disables", async () => {
  assert.equal((await risk(exec([]), task, { ...base, review: { always: true } })).review, true);
  assert.equal((await risk(exec([["package.json", 900]]), task, { ...base, review: { never: true } })).review, false);
});

test("git failures degrade to no diff", async () => {
  const boom: any = async () => { throw new Error("no git"); };
  assert.equal((await risk(boom)).review, false);
});
