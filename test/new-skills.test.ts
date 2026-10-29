import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { clean, listSkills, loadSkill, skillsDir } from "../src/skills.ts";

const CAPS: Record<string, number> = {
  unslop: 1000,
  "code-review": 2048,
  "codebase-design": 1024,
  "writing-for-agents": 3072,
  "principles-implement": 500,
  "principles-review": 500,
  "principles-diagnose": 500,
};

test("every bundled skill has frontmatter name == dir name and a one-line description under 300 chars", async () => {
  for (const name of await listSkills()) {
    const text = await fs.readFile(path.join(skillsDir(), name, "SKILL.md"), "utf8");
    const fm = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
    assert.equal(fm.match(/^name:\s*(.*)$/m)?.[1].trim(), name);
    const lines = fm.split("\n").filter((l) => l.startsWith("description:"));
    assert.equal(lines.length, 1, `${name} has one description line`);
    const skill = await loadSkill(name);
    assert.ok(skill.description.length > 0 && skill.description.length < 300, `${name} description length ${skill.description.length}`);
  }
});

test("condensed skills stay under their size caps", async () => {
  for (const [name, cap] of Object.entries(CAPS)) {
    const size = (await fs.readFile(path.join(skillsDir(), name, "SKILL.md"), "utf8")).length;
    assert.ok(size <= cap, `${name} is ${size} chars, cap ${cap}`);
  }
});

test("no bundled skill leaves Skill tool or /pstack- references after clean", async () => {
  const bundled = await listSkills();
  for (const name of bundled) {
    const skill = await loadSkill(name);
    for (const body of [skill.body, ...skill.files.map((f) => f.content)]) {
      // `{{package}}` expands to the checkout path, which may itself contain "/pstack-": check the text around it.
      assert.doesNotMatch(clean(body, bundled).replaceAll(path.dirname(path.dirname(skillsDir())), "<package>"), /Skill tool|\/pstack-/i, name);
    }
  }
});

test("every script a bundled skill points at exists, in the skill's folder or in the package", async () => {
  const root = path.dirname(path.dirname(skillsDir()));
  for (const name of await listSkills()) {
    const skill = await loadSkill(name);
    for (const body of [skill.body, ...skill.files.map((f) => f.content)]) {
      for (const [, base, script] of body.matchAll(/(\{\{package\}\}\/|[\w-]+\/)?(scripts\/[\w.-]+\.\w+)/g)) {
        const there = base === "{{package}}/" ? path.join(root, script) : path.join(skillsDir(), name, script);
        assert.ok(await fs.access(there).then(() => true, () => false), `${name} points at ${script}, which is not at ${there}`);
      }
    }
  }
});

test("unslop keeps the em-dash rule", async () => {
  const { body } = await loadSkill("unslop");
  assert.match(body, /em dash/i);
});
