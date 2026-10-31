import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { slug } from "../src/adr.ts";
import { registerTask } from "../src/task.ts";
import { readTask } from "../src/task-state.ts";
import { updateManifest } from "../src/manifest.ts";
import { fakePi, fakeUI, tempProject } from "./helpers.ts";

test("slug strips accents, cuts at 60 characters before trimming dashes", () => {
  assert.equal(slug("Qué moneda: ¿céntimos?"), "que-moneda-centimos");
  assert.equal(slug("a".repeat(59) + " b"), "a".repeat(59));
  assert.equal(slug("***"), "");
});

test("ADRs are written only once the plan is recorded, once per decision across retries", async () => {
  const h = fakePi();
  registerTask(h.pi);
  const root = await tempProject({});
  await updateManifest(root, (m) => void ((m.setup = "done"), (m.review = { always: true })));
  const ctxFor = (answers: unknown[]) => {
    const ui = fakeUI(answers);
    return { ui, ctx: { cwd: root, hasUI: true, ui, waitForIdle: async () => {} } as any };
  };
  await h.commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const plan = {
    summary: "s",
    intent: "i",
    steps: ["e"],
    files: ["src/fee.ts", "test/fee.test.ts"],
    decisions: [{ question: "Fee unit?", options: ["cents", "percent"] }, { question: "Rounding?", options: ["half-up", "banker"] }],
    interface: [{ file: "src/fee.ts", exports: ["fee"], usage: "fee(1)", source: "ticket" }],
    seams: [{ name: "x", testFile: "test/fee.test.ts", catches: "y" }],
  };
  const adrs = async () => (await fs.readdir(path.join(root, "docs/adr")).catch(() => [])).length;
  const run = (ctx: any) => h.tools.get("task_plan").execute("1", plan, undefined, undefined, ctx);
  // The second question is cancelled: the plan stops before any ADR is written.
  const first = ctxFor(["cents", undefined]);
  await assert.rejects(run(first.ctx), /cancelled/);
  assert.equal(await adrs(), 0);
  const retry = ctxFor(["half-up"]);
  await run(retry.ctx);
  assert.deepEqual(retry.ui.asked, ["Rounding?"], "the answered decision is not asked again");
  assert.equal(await adrs(), 2);
  assert.match((await readTask(root))!.plan!.decisions[0].source!, /^docs\/adr\/0001-fee-unit\.md$/);
});
