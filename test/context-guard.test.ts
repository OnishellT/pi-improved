import assert from "node:assert/strict";
import { test } from "node:test";
import { registerContextGuard, warnThreshold } from "../src/context-guard.ts";
import { fakePi, tempProject } from "./helpers.ts";

function setup(root: string, tokens: { value: number | null }) {
  const f = fakePi();
  registerContextGuard(f.pi);
  const notes: string[] = [];
  const ctx = { cwd: root, getContextUsage: () => ({ tokens: tokens.value, contextWindow: 1_000_000, percent: null }), ui: { notify: (m: string) => notes.push(m) } };
  return { ...f, ctx, notes };
}

test("warns once past the default 150k, and again only after the context shrank", async () => {
  const tokens = { value: 100_000 as number | null };
  const s = setup(await tempProject({}), tokens);
  await s.emit("turn_end", {}, s.ctx);
  assert.equal(s.notes.length, 0);
  tokens.value = 160_000;
  await s.emit("turn_end", {}, s.ctx);
  await s.emit("turn_end", {}, s.ctx);
  assert.equal(s.notes.length, 1);
  assert.match(s.notes[0], /160k.*\/compact/);
  tokens.value = 20_000;
  await s.emit("turn_end", {}, s.ctx);
  tokens.value = 155_000;
  await s.emit("turn_end", {}, s.ctx);
  assert.equal(s.notes.length, 2);
});

test("manifest contextWarn moves the limit and 0 turns it off; unknown usage is ignored", async () => {
  const tokens = { value: 60_000 as number | null };
  const low = setup(await tempProject({ ".pi/workflow.json": JSON.stringify({ contextWarn: 50_000 }) }), tokens);
  await low.emit("turn_end", {}, low.ctx);
  assert.equal(low.notes.length, 1);
  const off = setup(await tempProject({ ".pi/workflow.json": JSON.stringify({ contextWarn: 0 }) }), { value: 900_000 });
  await off.emit("turn_end", {}, off.ctx);
  assert.equal(off.notes.length, 0);
  const unknown = setup(await tempProject({}), { value: null });
  await unknown.emit("turn_end", {}, unknown.ctx);
  assert.equal(unknown.notes.length, 0);
  assert.equal(warnThreshold("x"), 150_000);
});
