#!/usr/bin/env node
// Prints the size of the skills injected per phase (skillsBlock output for DEFAULT_SKILLS) and per skill.
// Usage: node scripts/skill-tokens.mjs [--json]    (tokens ~ chars / 4)
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_SKILLS } from "../src/manifest.ts";
import { clean, listSkills, loadSkill, skillsBlock } from "../src/skills.ts";

const size = (chars) => ({ chars, tokens: Math.round(chars / 4) });

// A directory without a manifest, so every phase uses DEFAULT_SKILLS.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-tokens-"));
const bundled = await listSkills();

const phases = {};
for (const phase of Object.keys(DEFAULT_SKILLS)) {
  phases[phase] = { skills: DEFAULT_SKILLS[phase], ...size((await skillsBlock(root, phase)).length) };
}

const skills = {};
for (const name of bundled) {
  const skill = await loadSkill(name);
  const chars = [skill.body, ...skill.files.map((f) => f.content.trim())].reduce((n, t) => n + clean(t, bundled).length, 0);
  skills[name] = { files: skill.files.map((f) => f.name), ...size(chars) };
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ phases, skills }, null, 2));
} else {
  const row = (label, s) => `${label.padEnd(60)} ${String(s.chars).padStart(7)} chars ${String(s.tokens).padStart(6)} tokens`;
  console.log("Per phase (skillsBlock with DEFAULT_SKILLS)");
  for (const [phase, s] of Object.entries(phases)) console.log(row(`${phase} [${s.skills.join(", ") || "-"}]`, s));
  console.log("\nPer skill (body + injected files)");
  for (const [name, s] of Object.entries(skills)) console.log(row(name, s));
}
