import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { check, contractProblems, hasName } from "../scripts/contract-check.mjs";
import { phaseSkills, skillsBlock } from "../src/skills.ts";
import { tempProject } from "./helpers.ts";

const contract = (c: unknown) => ({ ".pi/contract.json": JSON.stringify(c) });

test("hasName matches whole words only", () => {
  assert.ok(hasName("export function slugify(x) {}", "slugify"));
  assert.ok(!hasName("const slugifyAll = 1", "slugify"));
  assert.ok(!hasName("const Slugify = 1", "slugify"));
});

test("contractProblems rejects bad shapes", () => {
  assert.deepEqual(contractProblems({ files: ["a"], names: ["b"] }), []);
  assert.ok(contractProblems([]).length);
  assert.ok(contractProblems({ files: "a", names: [] }).length);
  assert.ok(contractProblems({ files: [], names: [] }).length);
  assert.ok(contractProblems({ files: ["a"], names: [], notes: 1 }).length);
});

test("check reports a missing and a malformed contract", async () => {
  const missing = await check(await tempProject({}));
  assert.equal(missing.code, 1);
  assert.match(missing.text, /CONTRACT MISSING/);
  const bad = await check(await tempProject({ ".pi/contract.json": "{nope" }));
  assert.equal(bad.code, 1);
  assert.match(bad.text, /MALFORMED/);
});

test("check passes when files exist and names appear", async () => {
  const root = await tempProject({ ...contract({ files: ["src/slug.js"], names: ["slugify"], notes: "assumed: named export" }), "src/slug.js": "export const slugify = (s) => s;\n" });
  const r = await check(root);
  assert.equal(r.code, 0);
  assert.match(r.text, /CONTRACT OK/);
  assert.match(r.text, /assumed: named export/);
});

test("check fails on a missing file, a missing name and a path outside the project", async () => {
  const root = await tempProject({ ...contract({ files: ["src/a.js", "../x.js"], names: ["slugify", "other"] }), "src/b.js": "slugify" });
  const r = await check(root);
  assert.equal(r.code, 1);
  assert.match(r.text, /CONTRACT NOT MET/);
  assert.match(r.text, /src\/a\.js: the file does not exist/);
  assert.match(r.text, /\.\.\/x\.js: outside the project/);
  assert.match(r.text, /names not found.*slugify, other/);
});

test("check finds a name in a changed file that the contract does not list", async () => {
  const root = await tempProject({ ...contract({ files: ["a.js"], names: ["helper"] }), "a.js": "x", "b.js": "y" });
  const git = (...args: string[]) => promisify(execFile)("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root });
  await git("init", "-q");
  await git("add", ".");
  await git("commit", "-qm", "init");
  assert.equal((await check(root)).code, 1);
  await fs.writeFile(path.join(root, "c.js"), "function helper() {}\n");
  const r = await check(root);
  assert.equal(r.code, 0);
  assert.match(r.text, /1 changed file/);
});

test("contract-first is injected in plan with the script path resolved", async () => {
  const root = await tempProject({});
  assert.ok((await phaseSkills(root, "plan")).includes("contract-first"));
  assert.ok(!(await phaseSkills(root, "implement")).includes("contract-first"));
  const block = await skillsBlock(root, "plan");
  assert.match(block, /## Skill: contract-first/);
  assert.match(block, /\.pi\/contract\.json/);
  assert.doesNotMatch(block, /\{\{package\}\}|\bClaude\b/);
  const script = block.match(/node (\S+contract-check\.mjs)/)?.[1];
  assert.ok(script && (await fs.access(script).then(() => true, () => false)));
});

test("check cannot pass on the untracked contract file itself", async () => {
  const root = await tempProject({ ...contract({ files: ["a.js"], names: ["zzNameNowhere"] }), "a.js": "x" });
  const git = (...args: string[]) => promisify(execFile)("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root });
  await git("init", "-q");
  await git("add", "a.js");
  await git("commit", "-qm", "init");
  const r = await check(root);
  assert.equal(r.code, 1);
  assert.match(r.text, /names not found.*zzNameNowhere/);
});
