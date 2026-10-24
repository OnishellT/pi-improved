import assert from "node:assert/strict";
import { test } from "node:test";
import { registerModels, restoreModel, usePhaseModel } from "../src/models.ts";
import { readManifest, updateManifest } from "../src/manifest.ts";
import { fakePi, fakeUI, tempProject } from "./helpers.ts";

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

test("/models saves selections, unsets and keeps", async () => {
  const root = await tempProject({});
  await updateManifest(root, (x) => void (x.models = { implement: "openai/gpt-6-luna", review: "openai/gpt-6-luna" }));
  const t = setup(root, luna, [luna, astra], ["openai/gpt-6-astra", "Use the session model", "No changes", "No changes"]);
  registerModels(t.pi);
  await t.commands.get("models").handler("", t.ctx);
  assert.deepEqual((await readManifest(root)).models, { setup: "openai/gpt-6-astra", review: "openai/gpt-6-luna" });
});

test("/models asks provider first when the list is long", async () => {
  const root = await tempProject({});
  const many = Array.from({ length: 20 }, (_, i) => m(i < 10 ? "a" : "b", `m${i}`));
  const t = setup(root, luna, many, ["b", "b/m12", "No changes", "No changes", "No changes"]);
  registerModels(t.pi);
  await t.commands.get("models").handler("", t.ctx);
  assert.equal((await readManifest(root)).models?.setup, "b/m12");
  assert.match(t.ui.asked[0], /provider/);
});
