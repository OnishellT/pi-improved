import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { readGlobal } from "../src/config.ts";
import { registerModels, restoreModel, usePhaseModel } from "../src/models.ts";
import { MANIFEST_PATH, readManifest, readProjectManifest, updateManifest } from "../src/manifest.ts";
import { fakePi, fakeUI, tempProject, withEnv } from "./helpers.ts";

const m = (provider: string, id: string) => ({ provider, id });
const luna = m("openai", "gpt-6-luna");
const astra = m("openai", "gpt-6-astra");

function setup(root: string, current: any, available = [luna, astra], answers: unknown[] = []) {
  const f = fakePi();
  const set: string[] = [];
  f.pi.setModel = async (model: any) => (set.push(`${model.provider}/${model.id}`), true);
  const notes: string[] = [];
  const ui = { ...fakeUI(answers), notify: (text: string) => notes.push(text) };
  const registry = {
    find: (p: string, id: string) => [luna, astra, m("openai-codex", "gpt-6-luna")].find((x) => x.provider === p && x.id === id),
    getAvailable: () => available,
  };
  const ctx: any = { cwd: root, ui, model: current, modelRegistry: registry };
  return { ...f, set, notes, ctx, ui };
}

test("switches to the phase model and returns the previous one", async () => {
  const root = await tempProject({});
  await updateManifest(root, (x) => void (x.models = { setup: "openai/gpt-6-astra" }));
  const t = setup(root, luna);
  assert.equal(await usePhaseModel(t.pi, t.ctx, "setup"), "openai/gpt-6-luna");
  assert.deepEqual(t.set, ["openai/gpt-6-astra"]);
  assert.match(t.notes[0], /Model for setup: openai\/gpt-6-astra/);
  await restoreModel(t.pi, t.ctx, "openai/gpt-6-luna");
  assert.deepEqual(t.set, ["openai/gpt-6-astra", "openai/gpt-6-luna"]);
});

test("unknown or unauthenticated model warns and keeps the current one", async () => {
  const root = await tempProject({});
  await updateManifest(root, (x) => void (x.models = { implement: "openai-codex/gpt-6-luna" }));
  const t = setup(root, luna);
  assert.equal(await usePhaseModel(t.pi, t.ctx, "implement"), undefined);
  assert.deepEqual(t.set, []);
  assert.match(t.notes[0], /is not available/);
  await updateManifest(root, (x) => void (x.models = { implement: "nope/missing" }));
  assert.equal(await usePhaseModel(t.pi, t.ctx, "implement"), undefined);
  assert.equal(t.set.length, 0);
});

test("no config, same model, or missing registry is a no-op", async () => {
  const root = await tempProject({});
  const t = setup(root, luna);
  assert.equal(await usePhaseModel(t.pi, t.ctx, "setup"), undefined);
  await updateManifest(root, (x) => void (x.models = { setup: "openai/gpt-6-luna" }));
  assert.equal(await usePhaseModel(t.pi, t.ctx, "setup"), undefined);
  assert.equal(await usePhaseModel(t.pi, { cwd: root, ui: t.ui } as any, "setup"), undefined);
  assert.deepEqual(t.set, []);
  assert.deepEqual(t.notes, []);
});

/** Runs /models with its own empty global file; `global` seeds it. */
async function models(root: string, answers: unknown[], { args = "", available = [luna, astra], global }: { args?: string; available?: any[]; global?: object } = {}) {
  const dir = await tempProject(global ? { "pi-improved.json": JSON.stringify(global) } : {});
  return withEnv({ PI_CODING_AGENT_DIR: dir }, async () => {
    const t = setup(root, luna, available, answers);
    registerModels(t.pi);
    await t.commands.get("models").handler(args, t.ctx);
    return { ...t, dir, global: readGlobal(dir), merged: (await readManifest(root)).models };
  });
}
const row = (name: string, value: string) => `${name}: ${value}`;

test("/models changes only the phase picked, loops until Done, and saves to the global file", async () => {
  const root = await tempProject({});
  const t = await models(root, [row("Setup", "session model"), "openai/gpt-6-astra", row("Review and plan check (no model: no review)", "off"), "openai/gpt-6-luna", "Done"]);
  assert.deepEqual(t.global, { models: { setup: "openai/gpt-6-astra", review: "openai/gpt-6-luna" } });
  assert.equal((await readProjectManifest(root)).models, undefined, "nothing personal in the committed file");
  assert.equal(t.ui.asked.filter((q) => q === "Which phase to change?").length, 3);
  assert.equal(t.notes.length, 1, "one summary");
  assert.match(t.notes[0], /Setup: openai\/gpt-6-astra[\s\S]*Escalate \(when verify keeps failing\): review model, else setup model[\s\S]*Saved in .*pi-improved\.json\./);
});

test("/models: Esc in the phase list saves nothing; Esc in the model list goes back", async () => {
  const root = await tempProject({});
  const t = await models(root, [row("Setup", "session model"), "openai/gpt-6-astra", undefined]);
  assert.deepEqual(t.global, {});
  assert.match(t.notes[0], /nothing saved/);
  const back = await models(root, [row("Setup", "session model"), undefined, "Done"]);
  assert.deepEqual(back.global, {});
  assert.match(back.notes[0], /no changes/);
});

test("/models: Review offers Off, never the session model; other phases offer the session model", async () => {
  const root = await tempProject({});
  const t = await models(root, [row("Review and plan check (no model: no review)", "openai/gpt-6-luna"), "Off: no diff review (the plan check uses the setup model)", row("Setup", "session model"), "Use the session model", "Done"], { global: { models: { review: "openai/gpt-6-luna" } } });
  assert.deepEqual(t.global, {});
  assert.equal(t.merged, undefined);
  assert.match(t.notes[0], /Review and plan check \(no model: no review\): off/);
  assert.match(t.ui.asked[1], /^Review and plan check/);
});

test("/models changes a phase the project file sets in the project file, and `/models project` saves there", async () => {
  const root = await tempProject({});
  await updateManifest(root, (x) => void (x.models = { implement: "openai/gpt-6-luna" }));
  const t = await models(root, [row("Implement (plan and code)", "openai/gpt-6-luna"), "openai/gpt-6-astra", row("Setup", "session model"), "openai/gpt-6-luna", "Done"]);
  assert.deepEqual((await readProjectManifest(root)).models, { implement: "openai/gpt-6-astra" });
  assert.deepEqual(t.global, { models: { setup: "openai/gpt-6-luna" } });
  assert.match(t.notes[0], new RegExp(`Saved in .*pi-improved\\.json and ${MANIFEST_PATH.replaceAll(".", "\\.")}\\.`));
  const local = await tempProject({});
  const p = await models(local, [row("Review and plan check (no model: no review)", "openai/gpt-6-luna"), "Off: no diff review (the plan check uses the setup model)", "Done"], { args: "project", global: { models: { review: "openai/gpt-6-luna" } } });
  assert.deepEqual(p.global, { models: { review: "openai/gpt-6-luna" } }, "the global file is untouched");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(local, MANIFEST_PATH), "utf8")).models, { review: null }, "unset for this project only");
  assert.equal(p.merged?.review, undefined);
});

test("/models: Escalate unset says what it falls back to", async () => {
  const root = await tempProject({});
  const t = await models(root, [row("Escalate (when verify keeps failing)", "openai/gpt-6-luna"), "Unset: use the review model, else the setup model", "Done"], { global: { models: { escalate: "openai/gpt-6-luna" } } });
  assert.deepEqual(t.global, {});
  assert.match(t.notes[0], /Escalate \(when verify keeps failing\): review model, else setup model/);
});

test("/models: a project `models: null` keeps hiding the global phases it does not set", async () => {
  const root = await tempProject({});
  await updateManifest(root, (x) => void (x.models = null as any));
  const t = await models(root, [row("Setup", "session model"), "openai/gpt-6-astra", "Done"], { global: { models: { review: "openai/gpt-6-luna", setup: "openai/gpt-6-luna" } } });
  assert.deepEqual(t.global, { models: { review: "openai/gpt-6-luna", setup: "openai/gpt-6-luna" } }, "the global file is untouched");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, MANIFEST_PATH), "utf8")).models, { setup: "openai/gpt-6-astra", implement: null, review: null, escalate: null }, "every other phase stays hidden, even one the global file adds later");
  assert.deepEqual(t.merged, { setup: "openai/gpt-6-astra" });
});

test("/models says which file was saved when the other one fails", async () => {
  const root = await tempProject({});
  await updateManifest(root, (x) => void (x.models = { implement: "openai/gpt-6-luna" }));
  const dir = await tempProject({ "pi-improved.json": "{broken" });
  await withEnv({ PI_CODING_AGENT_DIR: dir }, async () => {
    const t = setup(root, luna, [luna, astra], [row("Implement (plan and code)", "openai/gpt-6-luna"), "openai/gpt-6-astra", row("Setup", "session model"), "openai/gpt-6-astra", "Done"]);
    registerModels(t.pi);
    await t.commands.get("models").handler("", t.ctx);
    assert.match(t.notes[0], /Saved in \.pi\/workflow\.json\. Not saved in .*pi-improved\.json: .*not valid JSON.*Fix the file and run \/models again\./);
    assert.deepEqual((await readProjectManifest(root)).models, { implement: "openai/gpt-6-astra" });
  });
});

test("/models refuses an unknown argument instead of saving for all projects", async () => {
  const root = await tempProject({});
  const t = await models(root, [], { args: "projct" });
  assert.match(t.notes[0], /Unknown argument "projct"\. Run \/models, or \/models project/);
  assert.deepEqual(t.global, {});
});

test("/models asks provider first when the list is long", async () => {
  const root = await tempProject({});
  const many = Array.from({ length: 20 }, (_, i) => m(i < 10 ? "a" : "b", `m${i}`));
  const t = await models(root, [row("Setup", "session model"), "b", "b/m12", "Done"], { available: many });
  assert.equal(t.global.models?.setup, "b/m12");
  assert.match(t.ui.asked[1], /provider/);
});
