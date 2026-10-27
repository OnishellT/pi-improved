import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ON_DEMAND, OPT_IN, readManifest, updateManifest } from "../src/manifest.ts";
import { listSkills, loadSkill, phaseOnDemand, registerSkills, skillsBlock, skillsDir } from "../src/skills.ts";
import { fakePi, fakeUI, tempProject } from "./helpers.ts";

const onDemand = (phase: string, names: string[]) => (m: { skillsOnDemand?: Record<string, string[]> }) => void (m.skillsOnDemand = { [phase]: names });
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("no on-demand skills: no index, output unchanged", async () => {
  const root = await tempProject({});
  const block = await skillsBlock(root, "review");
  assert.doesNotMatch(block, /Skills on request/);
  assert.ok(block.startsWith("## Skill: code-review"));
  await updateManifest(root, onDemand("review", []));
  assert.equal(await skillsBlock(root, "review"), block);
});

test("DEFAULT_ON_DEMAND lists the per-phase on-request skills and OPT_IN the opt-in ones", () => {
  assert.deepEqual(DEFAULT_ON_DEMAND, {
    setup: ["research"], plan: ["how", "architect", "codebase-design"], implement: ["handoff"], diagnose: ["why"], review: [], learn: [],
  });
  assert.deepEqual(OPT_IN, ["interrogate", "reflect"]);
});

test("on-demand skills are listed in an index after the injected ones, deterministically", async () => {
  const root = await tempProject({});
  await updateManifest(root, onDemand("plan", []));
  const plain = await skillsBlock(root, "plan");
  await updateManifest(root, onDemand("plan", ["retro", "grilling"]));
  assert.deepEqual(await phaseOnDemand(root, "plan"), ["retro", "grilling"]);
  assert.deepEqual(await phaseOnDemand(root, "setup"), ["research"]);
  const block = await skillsBlock(root, "plan");
  assert.ok(block.startsWith(plain));
  const index = block.slice(plain.length);
  assert.match(index, /^\n\n## Skills on request\n\n[^\n]*only if the task needs it/);
  for (const name of ["retro", "grilling"]) {
    assert.match(index, new RegExp(`^- ${name}: .+ \\(${escape(join(skillsDir(), name, "SKILL.md"))}\\)$`, "m"));
  }
  assert.ok(index.indexOf("- retro:") < index.indexOf("- grilling:"));
  assert.equal(block, await skillsBlock(root, "plan"));
});

test("the index ignores missing and already injected skills", async () => {
  const root = await tempProject({});
  await updateManifest(root, onDemand("plan", ["nope", "tdd"]));
  assert.doesNotMatch(await skillsBlock(root, "plan"), /Skills on request/);
  await updateManifest(root, onDemand("plan", ["nope", "retro"]));
  const block = await skillsBlock(root, "plan");
  assert.doesNotMatch(block, /- nope:/);
  assert.match(block, /- retro:/);
});

test("index descriptions are one line and cut at 160 characters", async () => {
  const root = await tempProject({});
  const names = (await listSkills()).filter((n) => !["tdd", "contract-first"].includes(n));
  await updateManifest(root, onDemand("plan", names));
  const lines = (await skillsBlock(root, "plan")).split("## Skills on request")[1].split("\n").filter((l) => l.startsWith("- "));
  assert.equal(lines.length, names.length);
  let cut = 0;
  for (const line of lines) {
    const description = line.replace(/^- [^:]+: /, "").replace(/ \([^()]*SKILL\.md\)$/, "");
    assert.ok(description.length <= 160);
    if (description.endsWith("…")) cut++;
  }
  assert.ok(cut > 0);
});

test("skill sub-directories are never injected", async () => {
  const dir = join(skillsDir(), "tdd", "references-test");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "deep.md"), "SUBDIR-MARKER\n");
    assert.deepEqual((await loadSkill("tdd")).files.map((f) => f.name), []);
    assert.doesNotMatch(await skillsBlock(await tempProject({}), "plan"), /SUBDIR-MARKER/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function run(root: string, answers: unknown[]) {
  const { pi, commands } = fakePi();
  registerSkills(pi);
  const ui = fakeUI(answers);
  const seen: string[][] = [];
  const select = ui.select;
  (ui as any).select = (title: string, options: string[]) => (seen.push(options), select(title));
  return commands.get("skills").handler("", { cwd: root, ui }).then(() => seen);
}

test("/skills toggles on-demand per phase", async () => {
  const root = await tempProject({});
  const seen = await run(root, ["No changes", "◇ retro (on request)", "Done", "No changes", "No changes", "No changes", "No changes"]);
  assert.deepEqual((await readManifest(root)).skillsOnDemand, { plan: ["how", "architect", "codebase-design", "retro"] });
  assert.ok(seen[1].includes("◇ retro (on request)") && seen[1].includes("· retro"));
});

test("/skills moves a skill between inject and on request", async () => {
  const root = await tempProject({});
  await updateManifest(root, (m) => void ((m.skills = { plan: ["tdd", "retro"] }), (m.skillsOnDemand = { plan: ["grilling"] })));
  await run(root, ["No changes", "◇ retro (on request)", "· tdd", "· tdd", "Done", "No changes", "No changes", "No changes", "No changes"]);
  const m = await readManifest(root);
  assert.deepEqual(m.skills, { plan: ["tdd"] });
  assert.deepEqual(m.skillsOnDemand, { plan: ["grilling", "retro"] });
});

test("/skills Defaults clears both overrides", async () => {
  const root = await tempProject({});
  await updateManifest(root, (m) => void ((m.skills = { plan: ["retro"] }), (m.skillsOnDemand = { plan: ["grilling"] })));
  await run(root, ["No changes", "Defaults", "No changes", "No changes", "No changes", "No changes", "No changes"]);
  const m = await readManifest(root);
  assert.equal(m.skills, undefined);
  assert.equal(m.skillsOnDemand, undefined);
});

test("opt-in skills carry a marker in the /skills list and are not in any default list", async () => {
  const root = await tempProject({});
  const seen = await run(root, ["No changes", "No changes", "No changes", "No changes", "No changes", "No changes"]);
  assert.ok(seen.every((options) => options.every((o) => !/\[opt-in\]/.test(o) || OPT_IN.some((s) => o.includes(s)))));
  for (const names of Object.values(DEFAULT_ON_DEMAND)) for (const s of OPT_IN) assert.ok(!names.includes(s));
});
