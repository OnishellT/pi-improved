import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { updateManifest } from "../src/manifest.ts";
import { readTask, writeTask } from "../src/task-state.ts";
import { registerTask } from "../src/task.ts";
import { fakePi, fakeUI, tempProject } from "./helpers.ts";

const plan = (decisions: any[] = []) => ({ summary: "Add fee", steps: ["edit"], files: ["src/fee.ts"], decisions });

async function setup(done = true) {
  const root = await tempProject({ "docs/adr/0001-money.md": "# money\n" });
  if (done) await updateManifest(root, (m) => void (m.setup = "done"));
  const h = fakePi();
  registerTask(h.pi);
  const ctxFor = (answers: unknown[]) => {
    const ui = fakeUI(answers);
    return { ui, ctx: { cwd: root, hasUI: true, ui, waitForIdle: async () => {} } as any };
  };
  return { root, ctxFor, ...h };
}

test("/task requires setup done", async () => {
  const { commands, sent, ctxFor, root } = await setup(false);
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  assert.equal(sent.length, 0);
  assert.equal(await readTask(root), undefined);
});

test("/task creates the task and sends one prompt", async () => {
  const { commands, sent, ctxFor, root } = await setup();
  await commands.get("task").handler("PAY-12", ctxFor([]).ctx);
  const task = await readTask(root);
  assert.equal(task?.status, "planning");
  assert.equal(task?.ticket, "PAY-12");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /task_plan/);
});

test("active task: replace asks, cancel keeps it", async () => {
  const { commands, ctxFor, root } = await setup();
  await commands.get("task").handler("First", ctxFor([]).ctx);
  const first = (await readTask(root))!.id;
  await commands.get("task").handler("Second", ctxFor(["Cancelar"]).ctx);
  assert.equal((await readTask(root))!.id, first);
  await commands.get("task").handler("Second", ctxFor(["Reemplazarla"]).ctx);
  assert.equal((await readTask(root))!.title, "Second");
});

test("task_plan with a documented source asks only for approval", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const { ctx, ui } = ctxFor([true]);
  const decisions = [{ question: "Money type?", options: ["cents", "float"], source: "docs/adr/0001-money.md#types" }];
  await tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 1);
  const task = (await readTask(root))!;
  assert.equal(task.status, "implementing");
  assert.equal(task.plan!.decisions[0].status, "documented");
});

test("invalid source is asked and recorded as an ADR", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const { ctx, ui } = ctxFor(["✏️  Otra respuesta…", "basis points", true]);
  const decisions = [{ question: "Fee unit?", options: ["cents", "percent"], source: "docs/missing.md" }];
  await tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 3);
  const d = (await readTask(root))!.plan!.decisions[0];
  assert.equal(d.status, "decided");
  assert.equal(d.answer, "basis points");
  assert.match(await fs.readFile(path.join(root, d.source!), "utf8"), /basis points/);
});

test("cancelled question stops; rejection returns feedback and stays planning", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const run = (answers: unknown[], decisions: any[] = []) => tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, ctxFor(answers).ctx);
  await assert.rejects(run([undefined], [{ question: "Q?", options: ["a", "b"] }]), /not approved/);
  await assert.rejects(run([false, "Smaller steps"]), /Smaller steps/);
  assert.equal((await readTask(root))!.status, "planning");
});

test("task_plan fails without a planning task", async () => {
  const { tools, ctxFor } = await setup();
  await assert.rejects(tools.get("task_plan").execute("1", plan(), undefined, undefined, ctxFor([]).ctx), /No task/);
});

test("nudge is bounded, resets per user message, and skips setup", async () => {
  const { commands, ctxFor, emit, root } = await setup();
  const ctx = ctxFor([]).ctx;
  await commands.get("task").handler("Add fee", ctx);
  const settle = () => emit("agent_before_settle", { outcome: "completed" }, ctx);
  assert.ok(await settle());
  assert.ok(await settle());
  assert.equal(await settle(), undefined);
  await emit("before_agent_start", { messageType: "user" }, ctx);
  assert.ok(await settle());
  await updateManifest(root, (m) => void (m.setup = "running"));
  await emit("before_agent_start", { messageType: "user" }, ctx);
  assert.equal(await settle(), undefined);
  await updateManifest(root, (m) => void (m.setup = "done"));
  await writeTask(root, { ...(await readTask(root))!, status: "implementing" });
  assert.equal(await settle(), undefined);
});

test("prompt lists similar past tasks and the tracker", async () => {
  const { taskPrompt } = await import("../src/task-prompt.ts");
  const text = taskPrompt("PAY-1", "PAY-1", "jira", ["PAY-0: added fees"]);
  assert.match(text, /Similar past tasks:\n- PAY-0: added fees/);
  assert.match(text, /jira tools/);
});
