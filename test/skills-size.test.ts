import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { listSkills, loadSkill, skillsDir } from "../src/skills.ts";

const CAPS: Record<string, number> = { tdd: 1950, "contract-first": 2400, "diagnosing-bugs": 3800, "pstack-blast-radius": 2800 };

test("every vendored SKILL.md has name and description frontmatter", async () => {
  for (const name of await listSkills()) {
    const text = await fs.readFile(path.join(skillsDir(), name, "SKILL.md"), "utf8");
    const front = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
    assert.equal(front.match(/^name:\s*(.+)$/m)?.[1].trim(), name, `${name}: name`);
    assert.ok((await loadSkill(name)).description.length > 0, `${name}: description`);
  }
});

test("compressed skills stay under their size caps and inject no companion files", async () => {
  for (const [name, cap] of Object.entries(CAPS)) {
    const skill = await loadSkill(name);
    assert.ok(skill.body.length <= cap, `${name} body is ${skill.body.length} chars, cap ${cap}`);
    assert.deepEqual(skill.files, [], `${name} must not inject companion files`);
  }
});

test("contract-first keeps the interface step and the five input cases, with no hand-written contract file", async () => {
  const { body } = await loadSkill("contract-first");
  for (const needle of ["interface", "usage", "Wrong type", "null", "Empty", "Out of range", "Duplicates"]) {
    assert.ok(body.includes(needle), `contract-first lost "${needle}"`);
  }
  assert.doesNotMatch(body, /contract\.json|contract-check/);
});

test("scripts/skill-tokens.mjs --json reports every phase and skill with chars and tokens", async () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts/skill-tokens.mjs");
  const out = JSON.parse(execFileSync(process.execPath, [script, "--json"], { encoding: "utf8" }));
  assert.deepEqual((Object.keys(out.skills)).sort(), (await listSkills()).sort());
  for (const entry of [...Object.values(out.phases), ...Object.values(out.skills)] as { chars: number; tokens: number }[]) {
    assert.ok(entry.chars >= 0 && entry.tokens === Math.round(entry.chars / 4));
  }
});
