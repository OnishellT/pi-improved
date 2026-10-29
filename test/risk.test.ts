import assert from "node:assert/strict";
import { test } from "node:test";
import { assessRisk, isTestFile, verifyFiles } from "../src/risk.ts";
import type { Manifest } from "../src/manifest.ts";
import { tempProject } from "./helpers.ts";

const base: Manifest = { version: 1, setup: "done", verify: [], connectors: [], review: { minLevel: "low" } };
const plan = { summary: "", steps: [], files: [], decisions: [] as any[], interface: [], seams: [] };
const task: any = { id: "t", title: "T", status: "implementing", allowedExtra: [], startedAt: "2026-10-01T00:00:00.000Z", plan };
/** The commit before the task started, which `git rev-list --before` finds when the task has no baseCommit. */
const START = "c".repeat(40);

const exec = (numstat: [string, number][], untracked: string[] = []): any => async (_cmd: string, args: string[]) => ({
  code: 0, stderr: "", killed: false,
  stdout: args.includes("--numstat") ? numstat.map(([f, n]) => `${n}\t0\t${f}\0`).join("") : args[0] === "ls-files" ? untracked.map((f) => `${f}\0`).join("") : args[0] === "rev-list" ? START : "",
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
  assert.equal((await risk(exec([["src/a.ts", 500]]))).level, "low");
  assert.equal((await risk(exec([["src/a.ts", 501]]))).level, "high", "limits.changeCap");
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

test("minLevel decides when a review is requested; default is high; always beats never", async () => {
  const med = exec([["src/a.ts", 300]]);
  const high = exec([["package.json", 1]]);
  const withLevel = (minLevel?: any) => ({ ...base, review: { minLevel } });
  assert.deepEqual([(await risk(med, task, withLevel())).review, (await risk(high, task, withLevel())).review], [false, true]);
  assert.deepEqual([(await risk(med, task, withLevel("off"))).review, (await risk(high, task, withLevel("off"))).review], [false, false]);
  assert.deepEqual([(await risk(med, task, withLevel("low"))).review, (await risk(high, task, withLevel("low"))).review], [true, true]);
  assert.deepEqual([(await risk(med, task, withLevel("high"))).review, (await risk(high, task, withLevel("high"))).review], [false, true]);
  assert.equal((await risk(high, task, withLevel())).level, "high");
  const both = await risk(med, task, { ...base, review: { always: true, never: true } });
  assert.deepEqual([both.review, both.level], [true, "high"]);
});

test("the diff is measured against the task's baseCommit when it resolves, else the commit before the task started, else no base", async () => {
  const hash = "b".repeat(40);
  const empty = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const seen: string[] = [];
  const e: any = async (_cmd: string, args: string[]) => {
    if (args.includes("--numstat")) seen.push(args[1]);
    return { code: 0, stderr: "", killed: false, stdout: args[0] === "rev-parse" ? `${hash}\n` : args[0] === "rev-list" ? START : args[0] === "diff" ? "700\t0\tsrc/a.ts" : "" };
  };
  assert.equal((await risk(e, { ...task, baseCommit: hash })).level, "high");
  await risk(e, { ...task, baseCommit: "not a hash; rm" });
  await risk(e);
  const gone: any = async (_cmd: string, args: string[]) => ({ code: 0, stderr: "", killed: false, stdout: args.includes("--numstat") ? (seen.push(args[1]), "") : args.includes("--name-status") ? "A\0test/a.test.ts\0" : "" });
  const none = await risk(gone, { ...task, baseCommit: hash });
  assert.deepEqual(seen, [hash, START, START, empty]);
  // Never HEAD: commits made during the task would drop out. Without a base every test file counts as touched.
  assert.equal(none.level, "high");
  assert.match(none.reasons.join(), /no base/);
  assert.deepEqual(none.touched, ["test/a.test.ts"]);
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

/** Rows of numstat (file, added, removed); `status` is what name-status says about them (M by default, A for a file that is new). */
const changing = (rows: [string, number, number][], status: Record<string, string> = {}): any => async (_cmd: string, args: string[]) => ({
  code: 0, stderr: "", killed: false,
  stdout: args.includes("--numstat") ? rows.map(([f, a, d]) => `${a}\t${d}\t${f}\0`).join("") : args.includes("--name-status") ? rows.map(([f]) => `${status[f] ?? "M"}\0${f}\0`).join("") : args[0] === "rev-list" ? START : "",
});

test("isTestFile: test directories", () => {
  for (const f of ["test/a.ts", "tests/unit/a.py", "src/__tests__/a.js", "spec/models/user.rb", "e2e/login.ts", "app/e2e/login.ts", "src/__mocks__/fs.ts", "Tests/App/Main.swift", "pkg/test/x.go"]) assert.ok(isTestFile(f), f);
  for (const f of ["src/testing/a.ts", "src/protest/a.ts", "src/contest/a.ts", "src/inspect/a.ts", "src/e2ee/a.ts", "src/specimen/a.ts", "src/latest/a.ts"]) assert.ok(!isTestFile(f), f);
});

test("isTestFile: test, tests or spec as a separated word in the file name, or a CamelCase suffix", () => {
  for (const f of ["src/foo.test.ts", "src/foo.spec.js", "src/foo.tests.js", "pkg/foo_test.go", "pkg/foo_tests.go", "pkg/test_foo.py", "src/foo-test.js", "src/FooTest.java", "src/FooTests.swift", "src/FooSpec.scala", "src/TestFoo.java", "src/tests.rs", "src/test.ts", "lib/foo_spec.rb", "spec_helper.rb", "src/foo.test"]) assert.ok(isTestFile(f), f);
  for (const f of ["src/latest.ts", "src/contest.ts", "src/Contest.java", "src/Latest.kt", "src/testing-utils.ts", "src/testify.ts", "docs/attest.md", "src/aspect.ts", "src/inspect.ts", "src/specimen.ts", "src/protest.go", "src/fee.ts", "README.md"]) assert.ok(!isTestFile(f), f);
});

test("changing or deleting an existing test file is high risk and listed; a new one or a source file is not", async () => {
  const edited = await risk(changing([["test/fee.test.ts", 3, 2], ["src/fee.ts", 5, 1]]));
  assert.equal(edited.level, "high");
  assert.match(edited.reasons.join(), /tests or verify setup changed \(test\/fee\.test\.ts\)/);
  assert.deepEqual(edited.touched, ["test/fee.test.ts"]);
  assert.equal((await risk(changing([["test/fee.test.ts", 0, 40]], { "test/fee.test.ts": "D" }))).level, "high");
  assert.deepEqual(await risk(changing([["test/fee.test.ts", 30, 0], ["src/fee.ts", 5, 5]], { "test/fee.test.ts": "A" })), { review: false, level: "none", reasons: [] });
  assert.deepEqual(await risk(changing([["src/fee.ts", 5, 5]])), { review: false, level: "none", reasons: [] });
  assert.equal((await risk(changing([["test/fee.test.ts", 3, 2]]), task, { ...base, review: { minLevel: "high" } })).review, true);
});

test("verifyFiles: paths and file names in the commands, package.json for a package-manager script", () => {
  assert.deepEqual(verifyFiles(["bash scripts/check.sh --fast", "node --test t.test.ts", "cd ./app && bash ci/test.sh", "pytest -q tests/ -k 'a.b'"]), ["scripts/check.sh", "t.test.ts", "app/ci/test.sh", "a.b"]);
  assert.deepEqual(verifyFiles(["pnpm run lint"]), ["package.json"]);
});

test("a file the verify commands name, or package.json under a package-manager script, is high risk when it changes", async () => {
  const withVerify = (verify: string[]): Manifest => ({ ...base, verify });
  const script = await risk(changing([["scripts/check.sh", 1, 1], ["src/a.ts", 1, 1]]), task, withVerify(["bash scripts/check.sh"]));
  assert.equal(script.level, "high");
  assert.deepEqual(script.touched, ["scripts/check.sh"]);
  assert.equal((await risk(changing([["scripts/other.sh", 1, 1]]), task, withVerify(["bash scripts/check.sh"]))).level, "none");
  assert.deepEqual((await risk(changing([["package.json", 1, 1]]), task, withVerify(["npm test"]))).touched, ["package.json"]);
  assert.equal((await risk(changing([["scripts/check.sh", 1, 1]], { "scripts/check.sh": "A" }), task, withVerify(["bash scripts/check.sh"]))).level, "none");
});

test("a verify file under .pi/ counts like any other; only pi-improved's own state files are left out", async () => {
  const verify = ["bash .pi/skills/verify-app/scripts/verify.sh"];
  const app = await risk(changing([[".pi/skills/verify-app/scripts/verify.sh", 1, 1]]), task, { ...base, verify });
  assert.equal(app.level, "high");
  assert.deepEqual(app.touched, [".pi/skills/verify-app/scripts/verify.sh"]);
  for (const own of [".pi/workflow.json", ".pi/task.json", ".pi/memory/tasks.jsonl", ".pi/metrics/a.jsonl"]) {
    assert.equal((await risk(changing([[own, 1, 1]]), task, { ...base, verify: [`bash ${own}`] })).touched, undefined, own);
  }
});

test("a new untracked test file is not an edited existing test; at most 3 paths are named in the reason", async () => {
  assert.deepEqual(await risk(exec([], ["test/new.test.ts"])), { review: false, level: "none", reasons: [] });
  const many = await risk(changing(["a", "b", "c", "d"].map((n) => [`test/${n}.test.ts`, 1, 1] as [string, number, number])));
  assert.match(many.reasons.join(), /\(test\/a\.test\.ts, test\/b\.test\.ts, test\/c\.test\.ts\)/);
  assert.equal(many.touched?.length, 4);
});

test("an existing test the approved plan lists in files, or names in a seam, is meant to change; others still raise", async () => {
  const rows: [string, number, number][] = [["test/fee.test.ts", 3, 2], ["tests/unit/a_test.go", 1, 1], ["spec/b_spec.rb", 1, 1], ["e2e/c.ts", 1, 1]];
  const planned = { ...task, plan: { ...plan, files: ["test/fee.test.ts", "e2e/"], seams: [{ name: "n", testFile: "tests/unit/a_test.go", catches: "x" }] } };
  const r = await risk(changing(rows), planned);
  assert.match(r.reasons.join(), /tests or verify setup changed \(spec\/b_spec\.rb\)/);
  assert.deepEqual(await risk(changing(rows.slice(0, 1)), planned), { review: false, level: "none", reasons: [] });
  assert.deepEqual(await risk(changing(rows.slice(1, 2)), planned), { review: false, level: "none", reasons: [] });
  assert.deepEqual(await risk(changing(rows.slice(3)), planned), { review: false, level: "none", reasons: [] });
  assert.match((await risk(changing(rows.slice(0, 1)))).reasons.join(), /tests or verify setup changed/);
});

test("verifyFiles resolves paths after a cd against that directory", async () => {
  assert.deepEqual(verifyFiles(["cd app && ./verify.sh"]), ["app/verify.sh"]);
  assert.deepEqual(verifyFiles(["cd app && npm test"]), ["app/package.json"]);
  assert.deepEqual(verifyFiles(["make lint && CI=1 pnpm test"]), ["package.json"]);
  assert.deepEqual((await risk(changing([["app/verify.sh", 1, 1]]), task, { ...base, verify: ["cd app && ./verify.sh"] })).touched, ["app/verify.sh"]);
});

test("review.always and review.never still list the tests or verify files that changed", async () => {
  const edited = changing([["test/fee.test.ts", 3, 2]]);
  assert.deepEqual((await risk(edited, task, { ...base, review: { always: true } })).touched, ["test/fee.test.ts"]);
  assert.deepEqual((await risk(edited, task, { ...base, review: { never: true } })).touched, ["test/fee.test.ts"]);
});

// Quality rules: a real repo, because they read the diff's lines.
async function repo(files: Record<string, string>) {
  const { execFileSync } = await import("node:child_process");
  const root = await tempProject(files);
  // Committed before `task.startedAt`, so it is the task's base.
  const env = { ...process.env, GIT_AUTHOR_DATE: "2026-09-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-01T00:00:00Z" };
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: root, stdio: "pipe", env });
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "init");
  const real: any = async (cmd: string, args: string[], o: any) => {
    try {
      return { stdout: execFileSync(cmd, args, { cwd: o.cwd, encoding: "utf8", maxBuffer: 1 << 26 }), stderr: "", code: 0, killed: false };
    } catch (e: any) {
      return { stdout: "", stderr: String(e), code: e.status ?? 1, killed: false };
    }
  };
  return { root, real, write: (f: string, c: string) => import("node:fs/promises").then((fs) => fs.mkdir(`${root}/${f}`.replace(/\/[^/]*$/, ""), { recursive: true }).then(() => fs.writeFile(`${root}/${f}`, c))) };
}
const fixTask: any = { ...task, title: "Fix the crash when the cart is empty" };

test("a bug fix that changes source but no test is high risk and listed", async () => {
  const r = await repo({ "src/cart.py": "def total(c):\n    return c[0]\n", "tests/test_cart.py": "assert True\n" });
  await r.write("src/cart.py", "def total(c):\n    return c[0] if c else 0\n");
  const out = await assessRisk(r.real, r.root, fixTask, base);
  assert.equal(out.level, "high");
  assert.match(out.reasons.join(), /bug fix changes source but no test/);
  assert.deepEqual(out.flagged, ["Bug fix changes source but no test"]);
  await r.write("tests/test_cart.py", "assert True\nassert total([]) == 0\n");
  const withTest = await assessRisk(r.real, r.root, fixTask, base);
  assert.doesNotMatch(withTest.reasons.join(), /no test/);
  assert.equal(withTest.flagged, undefined);
  await r.write("tests/test_cart.py", "");
  assert.match((await assessRisk(r.real, r.root, fixTask, base)).reasons.join(), /no test/, "a test that only lost lines does not count");
  const feature = await assessRisk(r.real, r.root, { ...task, title: "Add a discount line" }, base);
  assert.doesNotMatch(feature.reasons.join(), /no test/);
});

test("the dialog lists the quality notes whatever the review policy, the change cap included", async () => {
  const r = await repo({ "src/cart.py": "def total(c):\n    return c[0]\n" });
  await r.write("src/cart.py", "def total(c):\n    return c[0] if c else 0\n");
  for (const review of [{ always: true }, { never: true }]) assert.deepEqual((await assessRisk(r.real, r.root, fixTask, { ...base, review })).flagged, ["Bug fix changes source but no test"]);
  const capped = await assessRisk(r.real, r.root, task, { ...base, limits: { changeCap: 1 } });
  assert.match(capped.flagged?.join() ?? "", /changed lines in one change \(cap 1\)/);
});

test("tests that lose assertions or gain skip markers are high risk and listed, even when planned", async () => {
  const r = await repo({ "src/a.ts": "export const a = 1;\n", "src/a.test.ts": "test('a', () => {\n  expect(a).toBe(1);\n  expect(a).toBeGreaterThan(0);\n});\n" });
  const planned = { ...task, plan: { ...plan, files: ["src/a.ts", "src/a.test.ts"] } };
  await r.write("src/a.test.ts", "test('a', () => {\n  expect(a).toBe(1);\n});\n");
  const out = await assessRisk(r.real, r.root, planned, base);
  assert.equal(out.level, "high");
  assert.deepEqual(out.flagged, ["Existing tests weakened", "src/a.test.ts: 1 assertion removed or changed"]);
  assert.equal(out.touched, undefined);
  await r.write("src/a.test.ts", "test.skip('a', () => {\n  expect(a).toBe(1);\n  expect(a).toBeGreaterThan(0);\n});\n");
  assert.match((await assessRisk(r.real, r.root, planned, base)).flagged?.[1] ?? "", /marker/);
  await r.write("src/a.test.ts", "test('a', () => {\n  expect(a).toBe(2);\n  expect(a).toBeGreaterThan(0);\n});\n");
  assert.equal((await assessRisk(r.real, r.root, planned, base)).level, "high", "an edited expected value is the usual way to weaken a test");
});

test("one change over limits.changeCap is high risk; lockfiles and vendored paths do not count", async () => {
  const r = await repo({ "src/a.py": "x = 1\n" });
  const lines = (n: number) => `${Array.from({ length: n }, (_, i) => `v${i} = ${i}`).join("\n")}\n`;
  const big = { ...base, review: { minLevel: "low" as const, maxLines: 5000, highLines: 5000 } };
  await r.write("src/a.py", lines(500));
  const over = await assessRisk(r.real, r.root, task, big);
  assert.equal(over.level, "high");
  assert.match(over.reasons.join(), /501 changed lines in one change \(cap 500\)/);
  await r.write("src/a.py", lines(499));
  assert.equal((await assessRisk(r.real, r.root, task, big)).level, "none");
  await r.write("vendor/lib/x.py", lines(900));
  await r.write("poetry.lock", lines(900));
  assert.equal((await assessRisk(r.real, r.root, task, big)).level, "none", "vendored and lock files are not counted");
  assert.match((await assessRisk(r.real, r.root, task, { ...big, limits: { changeCap: 100 } } as any)).reasons.join(), /500 changed lines in one change \(cap 100\)/);
});
