import assert from "node:assert/strict";
import { test } from "node:test";
import { registerDoctor } from "../src/doctor.ts";
import { fakePi, tempProject } from "./helpers.ts";

// Its own file: the startup warning is shown once per process.
test("the startup warning says whether the config or the machine is wrong, and to run /doctor", async () => {
  const root = await tempProject({ ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: [], connectors: [], modles: {}, models: { review: "openai/gpt-5" } }) });
  const notes: string[] = [];
  const ctx: any = { cwd: root, hasUI: true, modelRegistry: { getAvailable: () => [] }, ui: { notify: (msg: string) => notes.push(msg) } };
  const t = { ...fakePi(() => ({ code: 0 })), ctx, notes };
  registerDoctor(t.pi, { has: async () => false });
  await t.emit("session_start", { reason: "startup" }, t.ctx);
  assert.match(t.notes[0], /^pi-improved: your config has problems \(Config\); missing or not working: Nix, Models\. Run \/doctor to see what to fix\.$/);
});

