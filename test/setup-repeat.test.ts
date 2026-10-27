import assert from "node:assert/strict";
import { test } from "node:test";
import { readManifest, updateManifest } from "../src/manifest.ts";
import { REPEAT_WARNING, registerSetup } from "../src/setup.ts";
import { fakePi, fakeUI, tempProject } from "./helpers.ts";

const ctxFor = (root: string, answers: unknown[]) => {
  const ui = fakeUI(answers);
  return { ui, ctx: { cwd: root, hasUI: true, mode: "tui", ui, waitForIdle: async () => {}, reload: async () => {} } as any };
};

test("/setup on a finished setup warns about the strong-model cost and stops when declined; the startup offer stays quiet", async () => {
  const root = await tempProject({ ".git/HEAD": "ref: refs/heads/main\n" });
  await updateManifest(root, (m) => void (m.setup = "done"));
  const { pi, commands, emit, sent } = fakePi();
  registerSetup(pi);
  const { ctx, ui } = ctxFor(root, [false]);
  await commands.get("setup").handler("", ctx);
  assert.equal(ui.asked.length, 1);
  assert.equal(sent.length, 0);
  assert.equal((await readManifest(root)).setup, "done");
  assert.match(REPEAT_WARNING, /strong setup model.*costs/);
  const quiet = ctxFor(root, []);
  await emit("session_start", { reason: "startup" }, quiet.ctx);
  assert.equal(quiet.ui.asked.length, 0);
});
