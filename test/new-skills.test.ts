import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { clean, listSkills, loadSkill, skillsDir } from "../src/skills.ts";

const VERBATIM = ["how", "why", "architect", "correct", "reflect", "interrogate", "handoff", "research"];
const CAPS: Record<string, number> = {
  unslop: 1000,
  "code-review": 2048,
  "codebase-design": 1024,
  pr: 1024,
  "writing-for-agents": 3072,
  "principles-implement": 500,
  "principles-review": 500,
  "principles-diagnose": 500,
};
const NEW = [...VERBATIM, ...Object.keys(CAPS)];

test("every new skill has frontmatter name == dir name and a one-line description under 200 chars", async () => {
  const bundled = await listSkills();
  for (const name of NEW) {
    assert.ok(bundled.includes(name), `${name} is bundled`);
    const text = await fs.readFile(path.join(skillsDir(), name, "SKILL.md"), "utf8");
    const fm = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
    assert.equal(fm.match(/^name:\s*(.*)$/m)?.[1].trim(), name);
    const lines = fm.split("\n").filter((l) => l.startsWith("description:"));
    assert.equal(lines.length, 1, `${name} has one description line`);
    const skill = await loadSkill(name);
    assert.ok(skill.description.length > 0 && skill.description.length < 200, `${name} description length ${skill.description.length}`);
    assert.doesNotMatch(fm, /disable-model-invocation/);
  }
});

test("condensed skills stay under their size caps", async () => {
  for (const [name, cap] of Object.entries(CAPS)) {
    const size = (await fs.readFile(path.join(skillsDir(), name, "SKILL.md"), "utf8")).length;
    assert.ok(size <= cap, `${name} is ${size} chars, cap ${cap}`);
  }
});

test("no new skill leaves Skill tool or /pstack- references after clean", async () => {
  const bundled = await listSkills();
  for (const name of NEW) {
    const skill = await loadSkill(name);
    for (const body of [skill.body, ...skill.files.map((f) => f.content)]) {
      assert.doesNotMatch(clean(body, bundled), /Skill tool|\/pstack-/i, name);
    }
  }
});

test("unslop keeps the em-dash rule", async () => {
  const { body } = await loadSkill("unslop");
  assert.match(body, /em dash/i);
});
