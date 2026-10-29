import assert from "node:assert/strict";
import { test } from "node:test";
import { discover } from "../src/discover.ts";
import { DEFAULT_ON_DEMAND, DEFAULT_SKILLS, OPT_IN, updateManifest, readManifest } from "../src/manifest.ts";
import { setupPrompt } from "../src/setup-prompt.ts";
import { clean, listSkills, loadSkill, phaseSkills, registerSkills, skillsBlock } from "../src/skills.ts";
import { fakePi, fakeUI, tempProject } from "./helpers.ts";

test("listSkills finds the bundled skills", async () => {
  assert.deepEqual(await listSkills(), [
    "architect", "benchmark-checklist", "bend-laws", "code-review", "codebase-design", "contract-first", "correct", "diagnosing-bugs", "domain-modeling", "grilling", "handoff", "how",
    "interrogate", "principle-explain-the-number", "principles-diagnose", "principles-implement", "principles-review", "pstack-blast-radius",
    "pstack-create-verification-skill", "pstack-maintain-verification-skill", "pstack-technical-writing", "reflect", "research", "retro", "tdd", "unslop", "why", "writing-for-agents",
  ]);
});

test("every skill named in the manifest lists exists under vendor/skills", async () => {
  const bundled = await listSkills();
  const named = [...Object.values(DEFAULT_SKILLS).flat(), ...Object.values(DEFAULT_ON_DEMAND).flat(), ...OPT_IN];
  for (const name of named) assert.ok(bundled.includes(name), `${name} is not bundled`);
});

test("loadSkill reads frontmatter, body and companion files", async () => {
  const tdd = await loadSkill("tdd");
  assert.match(tdd.description, /Test-driven/);
  assert.ok(!tdd.body.startsWith("---"));
  assert.deepEqual(tdd.files, []);
});

test("skillsBlock strips Skill tool lines, rewrites Claude and is deterministic", async () => {
  const root = await tempProject({});
  const block = await skillsBlock(root, "plan");
  assert.match(block, /^## Skill: tdd/);
  assert.doesNotMatch(block, /### tests\.md/);
  assert.doesNotMatch(block, /Skill tool/);
  assert.equal(block, await skillsBlock(root, "plan"));
  const learn = await skillsBlock(root, "learn");
  assert.doesNotMatch(learn.replace(/\(folder: [^)]*\)/g, ""), /Skill tool|\/pstack-|\bClaude\b/);
});

test("skillsBlock drops the pstack boilerplate section and keeps the skill body", async () => {
  const root = await tempProject({});
  for (const phase of ["setup", "review", "learn"] as const) {
    assert.doesNotMatch(await skillsBlock(root, phase), /Agent integration boundary|not an enforcement layer/);
  }
  await updateManifest(root, (m) => void (m.skills = { review: ["pstack-blast-radius"] }, m.skillsOnDemand = { review: [] }));
  assert.match(await skillsBlock(root, "review"), /Reply[^\n]*\n*$/);
});

test("phaseSkills honors the manifest override", async () => {
  const root = await tempProject({});
  assert.deepEqual(await phaseSkills(root, "plan"), ["tdd", "contract-first"]);
  await updateManifest(root, (m) => void (m.skills = { plan: ["retro"] }));
  assert.deepEqual(await phaseSkills(root, "plan"), ["retro"]);
  assert.match(await skillsBlock(root, "plan"), /^## Skill: retro/);
});

test("setupPrompt starts with the skills block and asks for GLOSSARY.md", async () => {
  const root = await tempProject({ "GLOSSARY.md": "# G\n" });
  const found = await discover(root, async () => "");
  assert.equal(found.glossary, true);
  const manifest = await updateManifest(root, (m) => void (m.language = "English"));
  const block = await skillsBlock(root, "setup");
  const text = setupPrompt(found, manifest, false, block);
  assert.ok(text.startsWith(block));
  assert.match(text, /GLOSSARY\.md/);
  assert.match(text, /already exists: extend it/);
});

test("/skills saves a per-phase selection", async () => {
  const root = await tempProject({});
  const { pi, commands } = fakePi();
  registerSkills(pi);
  // setup: keep; plan: toggle retro then done; the other four phases: keep.
  const ui = fakeUI(["No changes", "· retro", "Done", "No changes", "No changes", "No changes", "No changes"]);
  await commands.get("skills").handler("", { cwd: root, ui });
  assert.deepEqual((await readManifest(root)).skills, { plan: ["tdd", "contract-first", "retro"] });
});

test("clean matches a referenced skill as a whole token and keeps ordinary lines", () => {
  const bundled = ["pr", "how", "pstack-create-verification-skill"];
  const out = clean("This skill runs after /pstack-create-verification-skill has written the first one, and checks how it ages.", bundled);
  assert.equal(out, "(The referenced skill how, pstack-create-verification-skill, if bundled, is included below.)");
  assert.doesNotMatch(clean("Unrelated /pstack-x line about a probe.", bundled), /referenced skill/);
  const path = "Launch the reviewer with ~/.cursor/rules/pstack-models.mdc as its rules.";
  assert.equal(clean(path, bundled), path);
});

test("/skills Escape after a toggle restores the phase and saves nothing", async () => {
  const root = await tempProject({});
  const { pi, commands } = fakePi();
  registerSkills(pi);
  const ui = fakeUI(["No changes", "· retro", undefined, "No changes", "No changes", "No changes", "No changes"]);
  await commands.get("skills").handler("", { cwd: root, ui });
  assert.equal((await readManifest(root)).skills, undefined);
});

test("/skills toggling back to the defaults stores no explicit override", async () => {
  const root = await tempProject({});
  const { pi, commands } = fakePi();
  registerSkills(pi);
  const ui = fakeUI(["No changes", "· retro", "✓ retro", "Done", "No changes", "No changes", "No changes", "No changes"]);
  await commands.get("skills").handler("", { cwd: root, ui });
  assert.equal((await readManifest(root)).skills, undefined);
});

test("skillsBlock leaves skipped skills out of the injected block", async () => {
  const root = await tempProject({});
  const block = await skillsBlock(root, "plan", ["tdd"]);
  assert.doesNotMatch(block, /## Skill: tdd\b/);
  assert.match(block, /## Skill: contract-first/);
});

test("clean ignores a ## line inside a code fence when looking for the boilerplate section", () => {
  const text = ["# Skill", "", "## Agent integration boundary", "", "```md", "## not a heading", "```", "", "Still boilerplate.", "", "## Next", "Kept."].join("\n");
  assert.equal(clean(text, []), ["# Skill", "", "## Next", "Kept."].join("\n"));
});
test("interrogate starts each adversary in its own copy, not the real tree", async () => {
  const { body } = await loadSkill("interrogate");
  assert.match(body, /subagent spawn [^`]*--cwd <copy>/);
  assert.match(body, /git worktree add <copy>/);
  assert.match(body, /Rerun each finding's command yourself, in an adversary's copy/);
});

test("benchmark-checklist flips the run order so neither side always runs second", async () => {
  assert.match((await loadSkill("benchmark-checklist")).body, /\(A, B, B, A, …\)/);
});
