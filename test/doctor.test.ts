import * as fs from "node:fs/promises";
import * as path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeOk, registerDoctor } from "../src/doctor.ts";
import { fakePi, tempProject } from "./helpers.ts";

const models = [{ provider: "anthropic", id: "opus" }];
const setup = async (exec: (cmd: string, args: string[]) => any, hasUI = true, mode?: string, extra = {}) => {
  const root = await tempProject({ ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: [], connectors: [], mode, models: { implement: "anthropic/opus", review: "openai/gpt-5" }, ...extra }) });
  const notes: { msg: string; level: string }[] = [];
  const ctx: any = { cwd: root, hasUI, modelRegistry: { getAvailable: () => models }, ui: { notify: (msg: string, level: string) => notes.push({ msg, level }) } };
  const h = fakePi(exec);
  registerDoctor(h.pi);
  return { ...h, ctx, notes };
};

test("node version gate", () => {
  assert.ok(nodeOk("v22.18.0") && nodeOk("24.0.1"));
  assert.ok(!nodeOk("22.17.9") && !nodeOk("20.11.0"));
});

test("/doctor lists missing models with a login hint and failing CLIs", async () => {
  const t = await setup((cmd) => (cmd === "git" ? { code: 0 } : { code: 1 }));
  await t.commands.get("doctor").handler("", t.ctx);
  const { msg, level } = t.notes[0];
  assert.equal(level, "warning");
  assert.match(msg, /✗ subagent/);
  assert.match(msg, /✓ git/);
  assert.match(msg, /openai\/gpt-5[\s\S]*\/login <provider>[^\n]*openai/);
});

test("agentlint is checked only when the project runs it", async () => {
  const fail = (cmd: string) => (cmd === "git" ? { code: 0 } : { code: 1 });
  const unused = await setup(fail);
  await unused.commands.get("doctor").handler("", unused.ctx);
  assert.doesNotMatch(unused.notes[0].msg, /agentlint/);
  const used = await setup(fail, true, undefined, { agentlint: "npm exec agentlint --" });
  await used.commands.get("doctor").handler("", used.ctx);
  assert.match(used.notes[0].msg, /✗ agentlint: not found/);
});

test("session_start warns once, only with a UI, and only when something is missing", async () => {
  const t = await setup(() => ({ code: 0 }));
  await t.emit("session_start", { reason: "startup" }, t.ctx);
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0].msg, /Models/);
  await t.emit("session_start", { reason: "startup" }, t.ctx);
  assert.equal(t.notes.length, 1);
});

test("/doctor validates mode: absent and valid pass, anything else fails", async () => {
  for (const [mode, ok] of [[undefined, true], ["direct", true], ["flow", true], ["turbo", false]] as const) {
    const t = await setup(() => ({ code: 0 }), true, mode);
    await t.commands.get("doctor").handler("", t.ctx);
    const msg = t.notes[0].msg;
    assert.equal(/✗ Mode:/.test(msg), !ok, String(mode));
    if (mode === "turbo") assert.match(msg, /"direct" or "flow"/);
  }
});

test("/doctor reports a corrupt workflow.json as a problem instead of throwing", async () => {
  const t = await setup(() => ({ code: 0 }));
  await fs.writeFile(path.join(t.ctx.cwd, ".pi/workflow.json"), "{ nope");
  await t.commands.get("doctor").handler("", t.ctx);
  assert.match(t.notes[0].msg, /✗ Manifest: .*not valid JSON/);
});
