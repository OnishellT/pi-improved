import assert from "node:assert/strict";
import { test } from "node:test";
import { assessRisk, isTestFile } from "../src/risk.ts";
import type { Manifest } from "../src/manifest.ts";
import { tempProject } from "./helpers.ts";

const base: Manifest = { version: 1, setup: "done", verify: [], connectors: [], review: { minLevel: "low" } };
const plan = { summary: "", steps: [], files: [], decisions: [] as any[], interface: [], seams: [] };
const task: any = { id: "t", title: "T", status: "implementing", allowedExtra: [], startedAt: "", plan };

const exec = (numstat: [string, number][], untracked: string[] = []): any => async (_cmd: string, args: string[]) => ({
  code: 0, stderr: "", killed: false,
  stdout: args.includes("--numstat") ? numstat.map(([f, n]) => `${n}\t0\t${f}\0`).join("") : args[0] === "ls-files" ? untracked.map((f) => `${f}\0`).join("") : "",
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

test("a failed git diff is low risk with a reason, not none", async () => {
  const boom: any = async () => { throw new Error("no git"); };
  assert.deepEqual(await risk(boom), { review: true, level: "low", reasons: ["git diff failed"] });
  const failed: any = async () => ({ code: 128, stderr: "fatal", killed: false, stdout: "" });
  assert.equal((await risk(failed)).level, "low");
});

test("the numstat asks for no renames, so a moved lockfile still counts as a dependency change", async () => {
  let args: string[] = [];
  const e: any = async (_c: string, a: string[]) => (a[0] === "diff" && (args = a), { code: 0, stderr: "", killed: false, stdout: a[0] === "diff" ? "1\t0\tpnpm-lock.yaml\0" : "" });
  assert.match((await risk(e)).reasons.join(), /dependencies/);
  assert.ok(args.includes("--no-renames") && args.includes("-z"));
});

const removing = (rows: [string, number, number][]): any => async (_cmd: string, args: string[]) => ({
  code: 0, stderr: "", killed: false, stdout: args.includes("--numstat") ? rows.map(([f, a, d]) => `${a}\t${d}\t${f}\0`).join("") : "",
});

test("isTestFile: test directories", () => {
  for (const f of ["test/a.ts", "tests/unit/a.py", "src/__tests__/a.js", "spec/models/user.rb", "e2e/login.ts", "app/e2e/login.ts", "src/__mocks__/fs.ts", "Tests/App/Main.swift", "pkg/test/x.go"]) assert.ok(isTestFile(f), f);
  for (const f of ["src/testing/a.ts", "src/protest/a.ts", "src/contest/a.ts", "src/inspect/a.ts", "src/e2ee/a.ts", "src/specimen/a.ts", "src/latest/a.ts"]) assert.ok(!isTestFile(f), f);
});

test("isTestFile: test, tests or spec as a separated word in the file name, or a CamelCase suffix", () => {
  for (const f of ["src/foo.test.ts", "src/foo.spec.js", "src/foo.tests.js", "pkg/foo_test.go", "pkg/foo_tests.go", "pkg/test_foo.py", "src/foo-test.js", "src/FooTest.java", "src/FooTests.swift", "src/FooSpec.scala", "src/TestFoo.java", "src/tests.rs", "src/test.ts", "lib/foo_spec.rb", "spec_helper.rb", "src/foo.test"]) assert.ok(isTestFile(f), f);
  for (const f of ["src/latest.ts", "src/contest.ts", "src/Contest.java", "src/Latest.kt", "src/testing-utils.ts", "src/testify.ts", "docs/attest.md", "src/aspect.ts", "src/inspect.ts", "src/specimen.ts", "src/protest.go", "src/fee.ts", "README.md"]) assert.ok(!isTestFile(f), f);
});

test("removing or changing lines in an existing test file is a risk reason; adding tests is not", async () => {
  const edited = await risk(removing([["test/fee.test.ts", 3, 2], ["src/fee.ts", 5, 1]]));
  assert.equal(edited.level, "low");
  assert.match(edited.reasons.join(), /existing tests changed \(test\/fee\.test\.ts\)/);
  assert.deepEqual(await risk(removing([["test/fee.test.ts", 30, 0], ["src/fee.ts", 5, 5]])), { review: false, level: "none", reasons: [] });
  assert.deepEqual(await risk(removing([["src/fee.ts", 5, 5]])), { review: false, level: "none", reasons: [] });
  assert.equal((await risk(removing([["test/fee.test.ts", 3, 2]]), task, { ...base, review: { minLevel: "low" } })).review, true);
});

test("a new untracked test file is not an edited existing test; at most 3 paths are named", async () => {
  assert.deepEqual(await risk(exec([], ["test/new.test.ts"])), { review: false, level: "none", reasons: [] });
  const many = await risk(removing(["a", "b", "c", "d"].map((n) => [`test/${n}.test.ts`, 1, 1] as [string, number, number])));
  assert.match(many.reasons.join(), /\(test\/a\.test\.ts, test\/b\.test\.ts, test\/c\.test\.ts\)/);
});

test("an existing test the approved plan lists in files, or names in a seam, is meant to change; others still raise", async () => {
  const rows: [string, number, number][] = [["test/fee.test.ts", 3, 2], ["tests/unit/a_test.go", 1, 1], ["spec/b_spec.rb", 1, 1], ["e2e/c.ts", 1, 1]];
  const planned = { ...task, plan: { ...plan, files: ["test/fee.test.ts", "e2e/"], seams: [{ name: "n", testFile: "tests/unit/a_test.go", catches: "x" }] } };
  const r = await risk(removing(rows), planned);
  assert.match(r.reasons.join(), /existing tests changed \(spec\/b_spec\.rb\)/);
  assert.deepEqual(await risk(removing(rows.slice(0, 1)), planned), { review: false, level: "none", reasons: [] });
  assert.deepEqual(await risk(removing(rows.slice(1, 2)), planned), { review: false, level: "none", reasons: [] });
  assert.deepEqual(await risk(removing(rows.slice(3)), planned), { review: false, level: "none", reasons: [] });
  assert.match((await risk(removing(rows.slice(0, 1)))).reasons.join(), /existing tests changed/);
});
