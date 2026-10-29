import assert from "node:assert/strict";
import { test } from "node:test";
import { checkVerifyApp, coverageChanges, readCoverage } from "../src/verify-app.ts";
import { tempProject } from "./helpers.ts";

const A = ".pi/skills/verify-app";
const FEATURE = "# F\n\n## Sub-features\n\n## How to get to it (user POV)\n\n## Driving it with playwright\n\n## Gotchas\n";
const SYNC = "b".repeat(40);
const COVERAGE = `${A}/features/coverage.json`;
const skill = { [`${A}/SKILL.md`]: "x", [`${A}/features/README.md`]: "x", [`${A}/features/a.md`]: FEATURE };
/** git double: `cat-file` answers `known`, everything else is `log`. */
const gitDouble = (known: boolean, log = "", calls: string[][] = []) => (async (_cmd: string, args: string[]) => (calls.push(args), args[0] === "cat-file" && !known ? { stdout: "", stderr: "fatal", code: 128, killed: false } : { stdout: args[0] === "log" ? log : "", stderr: "", code: 0, killed: false })) as any;

test("checkVerifyApp: a complete skill has no problems", async () => {
  const root = await tempProject({ ...skill, [COVERAGE]: JSON.stringify({ sync: SYNC, paths: ["src/", "lib/x.ts"] }), "src/a.ts": "x", "lib/x.ts": "x" });
  const calls: string[][] = [];
  assert.deepEqual(await checkVerifyApp(root, gitDouble(true, "", calls)), []);
  assert.deepEqual(calls, [["cat-file", "-e", `${SYNC}^{commit}`]]);
});

test("checkVerifyApp: coverage.json is required, its sync must be a commit and each path must exist", async () => {
  const root = (record?: unknown, extra: Record<string, string> = {}) => tempProject({ ...skill, ...extra, ...(record === undefined ? {} : { [COVERAGE]: JSON.stringify(record) }) });
  assert.match((await checkVerifyApp(await root(), gitDouble(true)))[0], /coverage\.json must be \{"sync"/);
  assert.match((await checkVerifyApp(await root({ sync: "nope", paths: ["src/"] }, { "src/a.ts": "x" }), gitDouble(true)))[0], /coverage\.json must be/);
  const gone = await checkVerifyApp(await root({ sync: SYNC, paths: ["src/"] }, { "src/a.ts": "x" }), gitDouble(false));
  assert.equal(gone.length, 1);
  assert.match(gone[0], new RegExp(`sync ${SYNC} is not a commit of this repo\\. Set it to the output of \`git rev-parse HEAD\``));
  const missing = await checkVerifyApp(await root({ sync: SYNC, paths: ["src/", "lib/x.ts", "../out", "/etc"] }, { "src/a.ts": "x" }), gitDouble(true));
  assert.equal(missing.length, 1);
  assert.match(missing[0], /these paths do not exist: lib\/x\.ts, \.\.\/out, \/etc\./);
});

test("checkVerifyApp: an empty sync is fine while the repo has no commit, and a problem once it has one", async () => {
  const root = await tempProject({ ...skill, [COVERAGE]: JSON.stringify({ sync: "", paths: ["src/"] }), "src/a.ts": "x" });
  const exec = (head: string) => (async () => (head ? { stdout: head, stderr: "", code: 0, killed: false } : { stdout: "", stderr: "fatal", code: 128, killed: false })) as any;
  assert.deepEqual(await checkVerifyApp(root, exec("")), []);
  assert.match((await checkVerifyApp(root, exec(SYNC)))[0], /sync is empty but the repo has a commit now/);
  assert.equal(await coverageChanges(exec(""), root), undefined);
});

test("checkVerifyApp: names the missing files and the missing headings of each feature", async () => {
  const empty = await checkVerifyApp(await tempProject({}), gitDouble(true));
  assert.equal(empty.length, 3);
  assert.match(empty.join("\n"), /SKILL\.md is missing[\s\S]*README\.md is missing[\s\S]*coverage\.json must be/);
  const root = await tempProject({
    [`${A}/SKILL.md`]: "x", [`${A}/features/README.md`]: "x",
    [`${A}/features/a.md`]: FEATURE.replace("## Gotchas", "### Gotchas"),
    [`${A}/features/b.md`]: "# B\n",
    [`${A}/features/ok.md`]: FEATURE,
    [`${A}/features/notes.txt`]: "ignored",
    [COVERAGE]: JSON.stringify({ sync: SYNC, paths: ["src/"] }), "src/a.ts": "x",
  });
  const problems = await checkVerifyApp(root, gitDouble(true));
  assert.equal(problems.length, 2);
  assert.match(problems[0], /a\.md needs these H2 headings: Gotchas\./);
  assert.match(problems[1], /b\.md needs these H2 headings: Sub-features; How to get to it \(user POV\); Driving it with <harness>; Gotchas\./);
});

test("readCoverage accepts a commit and paths, and rejects anything else", async () => {
  const at = (v: unknown) => tempProject({ [`${A}/features/coverage.json`]: typeof v === "string" ? v : JSON.stringify(v) });
  assert.deepEqual(await readCoverage(await at({ sync: SYNC, paths: ["src/"] })), { sync: SYNC, paths: ["src/"] });
  for (const bad of [{ sync: "HEAD", paths: ["src/"] }, { sync: SYNC, paths: [] }, { sync: SYNC, paths: [1] }, { sync: SYNC }, "not json", []]) {
    assert.equal(await readCoverage(await at(bad)), undefined, JSON.stringify(bad));
  }
  assert.equal(await readCoverage(await tempProject({})), undefined);
});

test("coverageChanges runs git log from the sync commit over the paths and caps the list", async () => {
  const root = await tempProject({ [`${A}/features/coverage.json`]: JSON.stringify({ sync: SYNC, paths: ["src/", "a b.ts"] }) });
  const calls: string[][] = [];
  const lines = Array.from({ length: 12 }, (_, i) => `c${i} ${"s".repeat(150)}`);
  const out = await coverageChanges(gitDouble(true, lines.join("\n"), calls), root);
  const log = calls.find((c) => c[0] === "log")!;
  assert.deepEqual(log.slice(log.indexOf(`${SYNC}..HEAD`)), [`${SYNC}..HEAD`, "--", "src/", "a b.ts"]);
  assert.equal(out?.sync, SYNC);
  assert.equal(out?.commits.length, 11);
  assert.ok(out!.commits[0].length <= 100);
  assert.match(out!.commits[10], /2 more/);
});

test("coverageChanges is undefined with no commits, a failing git or no record", async () => {
  const root = await tempProject({ [`${A}/features/coverage.json`]: JSON.stringify({ sync: SYNC, paths: ["src/"] }) });
  assert.equal(await coverageChanges(gitDouble(true, ""), root), undefined);
  assert.equal(await coverageChanges((async (_c: string, args: string[]) => (args[0] === "log" ? { stdout: "x y", stderr: "bad", code: 128, killed: false } : { stdout: "", stderr: "", code: 0, killed: false })) as any, root), undefined);
  let ran = false;
  assert.equal(await coverageChanges((async () => ((ran = true), { stdout: "x y", code: 0 })) as any, await tempProject({})), undefined);
  assert.equal(ran, false);
});

test("coverageChanges says the sync commit is gone, without listing anything, when it no longer resolves", async () => {
  const root = await tempProject({ [COVERAGE]: JSON.stringify({ sync: SYNC, paths: ["src/"] }) });
  const calls: string[][] = [];
  assert.deepEqual(await coverageChanges(gitDouble(false, "abc1234 x", calls), root), { sync: SYNC, commits: [], gone: true });
  assert.equal(calls.some((c) => c[0] === "log"), false);
});

test("coverageChanges lists covered files that are changed or new but not committed, limited to the covered paths", async () => {
  const root = await tempProject({ [COVERAGE]: JSON.stringify({ sync: SYNC, paths: ["src/", "lib/x.ts"] }) });
  const calls: string[][] = [];
  const exec: any = async (_c: string, args: string[]) => (calls.push(args), { stdout: args[0] === "diff" ? "src/a.ts\0" : args[0] === "ls-files" ? "src/a.ts\0src/b.ts\0" : "", stderr: "", code: 0, killed: false });
  assert.deepEqual(await coverageChanges(exec, root), { sync: SYNC, commits: [], dirty: ["src/a.ts", "src/b.ts"] });
  for (const cmd of ["diff", "ls-files"]) assert.deepEqual(calls.find((c) => c[0] === cmd)!.slice(-3), ["--", "src/", "lib/x.ts"]);
});

test("coverageChanges asks for a first sync once the repo has a commit, and stays quiet before", async () => {
  const root = await tempProject({ [`${A}/features/coverage.json`]: JSON.stringify({ sync: "", paths: ["src/"] }) });
  const exec = (stdout: string) => (async () => ({ stdout, stderr: "", code: stdout ? 0 : 128, killed: false })) as any;
  assert.equal(await coverageChanges(exec(""), root), undefined);
  assert.deepEqual(await coverageChanges(exec(SYNC), root), { sync: "", commits: [], unsynced: true });
});
