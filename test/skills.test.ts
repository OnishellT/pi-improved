import assert from "node:assert/strict";
import { test } from "node:test";
import { discover } from "../src/discover.ts";
import { updateManifest, readManifest } from "../src/manifest.ts";
import { setupPrompt } from "../src/prompt.ts";
import { listSkills, loadSkill, phaseSkills, registerSkills, skillsBlock } from "../src/skills.ts";
import { fakePi, fakeUI, tempProject } from "./helpers.ts";

test("listSkills finds the bundled skills", async () => {
  assert.deepEqual(await listSkills(), [
    "diagnosing-bugs", "domain-modeling", "grilling", "pstack-blast-radius", "pstack-create-verification-skill",
    "pstack-maintain-verification-skill", "pstack-technical-writing", "retro", "tdd",
  ]);
});

test("loadSkill reads frontmatter, body and companion files", async () => {
  const tdd = await loadSkill("tdd");
  assert.match(tdd.description, /Test-driven/);
  assert.ok(!tdd.body.startsWith("---"));
  assert.deepEqual(tdd.files.map((f) => f.name), ["mocking.md", "tests.md"]);
});

test("skillsBlock strips Skill tool lines, rewrites Claude and is deterministic", async () => {
  const root = await tempProject({});
  const block = await skillsBlock(root, "plan");
  assert.match(block, /^## Skill: tdd/);
  assert.match(block, /### tests\.md/);
  assert.doesNotMatch(block, /Skill tool/);
  assert.equal(block, await skillsBlock(root, "plan"));
  const learn = await skillsBlock(root, "learn");
  assert.doesNotMatch(learn, /Skill tool|\/pstack-|\bClaude\b/);
});

test("phaseSkills honors the manifest override", async () => {
  const root = await tempProject({});
  assert.deepEqual(await phaseSkills(root, "plan"), ["tdd"]);
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
  assert.deepEqual((await readManifest(root)).skills, { plan: ["tdd", "retro"] });
});
