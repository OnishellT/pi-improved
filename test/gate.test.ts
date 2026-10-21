import assert from "node:assert/strict";
import { test } from "node:test";
import { registerGate } from "../src/gate.ts";
import { TASK_DONE_EVENT } from "../src/learn.ts";
import { readTask } from "../src/task-state.ts";
import { fakePi, fakeUI, tempProject } from "./helpers.ts";

const manifest = (setup: string) => JSON.stringify({ version: 1, setup, verify: ["check"], connectors: [] });
const task = { id: "t1", title: "Do it", status: "implementing", allowedExtra: [], startedAt: "now" };

async function setup(opts: { setup?: string; task?: boolean; pass?: boolean; answers?: unknown[]; review?: string } = {}) {
  const files: Record<string, string> = { ".pi/workflow.json": manifest(opts.setup ?? "done") };
  if (opts.review) files[".pi/workflow.json"] = JSON.stringify({ version: 1, setup: "done", verify: ["check"], connectors: [], models: { review: "p/m" } });
  if (opts.task) files[".pi/task.json"] = JSON.stringify(task);
  const root = await tempProject(files);
  let diff = "";
  let verifies = 0;
  const subagent: string[] = [];
  const h = fakePi((cmd, args) => {
    if (cmd === "git") return { code: 0, stdout: args[0] === "diff" ? diff : "" };
    if (cmd === "subagent") subagent.push(args[0]);
    if (cmd === "subagent") return args[0] === "spawn" ? { code: 0, stdout: "Spawned review (abc123)" } : args[0] === "wait" ? { code: 0, stdout: `abc123 finished\n\n${opts.review}` } : { code: 0 };
    verifies++;
    return opts.pass ? { code: 0 } : { code: 1, stdout: "boom" };
  });
  const emitted: any[] = [];
  h.pi.events = { emit: (name: string, payload: any) => emitted.push({ name, payload }) };
  registerGate(h.pi);
  const ui = fakeUI(opts.answers ?? []);
  const ctx: any = { cwd: root, hasUI: true, ui };
  const run = async () => {
    await h.emit("before_agent_start", { messageType: "user" }, ctx);
    diff = "changed";
  };
  const settle = () => h.emit("agent_before_settle", { outcome: "completed" }, ctx);
  return { ...h, root, ctx, ui, emitted, run, settle, verifies: () => verifies, subagent };
}

test("does nothing when nothing changed", async () => {
  const t = await setup();
  await t.emit("before_agent_start", { messageType: "user" }, t.ctx);
  assert.equal(await t.settle(), undefined);
  assert.equal(t.verifies(), 0);
});

test("inactive while setup is not done", async () => {
  const t = await setup({ setup: "running" });
  await t.run();
  assert.equal(await t.settle(), undefined);
  assert.equal(t.verifies(), 0);
});

test("failure continues with the report; a write tool alone counts as change", async () => {
  const t = await setup();
  await t.emit("before_agent_start", { messageType: "user" }, t.ctx);
  await t.emit("tool_result", { toolName: "write" }, t.ctx);
  const result = await t.settle();
  assert.equal(result.continue, true);
  assert.equal(result.entries[0].customType, "verify-gate");
  assert.match(result.entries[0].content, /verify FAILED[\s\S]*boom[\s\S]*Fix it, then finish\./);
});

test("retry cap asks the user, then stops", async () => {
  const t = await setup({ answers: ["Seguir intentando", "Dejarlo así"] });
  await t.run();
  for (let i = 0; i < 3; i++) assert.equal((await t.settle()).continue, true);
  assert.equal(t.ui.asked.length, 0);
  assert.equal((await t.settle()).continue, true);
  assert.equal(await t.settle(), undefined);
  assert.equal(t.ui.asked.length, 2);
});

test("pass confirms the task, marks it done and emits the event; same state is not re-verified", async () => {
  const t = await setup({ pass: true, task: true, answers: [true] });
  await t.run();
  assert.equal(await t.settle(), undefined);
  const done = await readTask(t.root);
  assert.equal(done?.status, "done");
  assert.ok(done?.completedAt);
  assert.equal(t.emitted[0].name, TASK_DONE_EVENT);
  assert.equal(t.emitted[0].payload.root, t.root);
  await t.settle();
  assert.equal(t.verifies(), 1);
});

test("/verify reports even without changes", async () => {
  const t = await setup({ pass: true });
  const notes: any[] = [];
  t.ctx.ui.notify = (m: string, l: string) => notes.push([m, l]);
  await t.commands.get("verify").handler("", t.ctx);
  assert.equal(notes[0][1], "info");
  assert.match(notes[0][0], /verify passed/);
});

test("review CHANGES continues with the findings; max rounds then asks the user", async () => {
  const t = await setup({ pass: true, task: true, review: "VERDICT: CHANGES\n1. bug", answers: ["Cerrar igual", false] });
  await t.run();
  for (let i = 0; i < 2; i++) {
    const r = await t.settle();
    assert.equal(r.continue, true);
    assert.equal(r.entries[0].customType, "diff-review");
    assert.match(r.entries[0].content, /1\. bug[\s\S]*Fix these, then finish\./);
  }
  assert.equal(t.ui.asked.length, 0);
  assert.equal(await t.settle(), undefined);
  assert.equal(t.ui.asked.length, 2);
  assert.match(t.ui.asked[0], /revisión/);
});

test("review APPROVED goes on to the confirm", async () => {
  const t = await setup({ pass: true, task: true, review: "VERDICT: APPROVED", answers: [true] });
  await t.run();
  assert.equal(await t.settle(), undefined);
  assert.equal((await readTask(t.root))?.status, "done");
});

test("review skipped notifies and still confirms; no review model never spawns", async () => {
  const t = await setup({ pass: true, task: true, review: "no verdict here", answers: [true] });
  const notes: string[] = [];
  t.ctx.ui.notify = (m: string) => notes.push(m);
  await t.run();
  await t.settle();
  assert.match(notes[0], /Revisión omitida/);
  assert.equal((await readTask(t.root))?.status, "done");
  const n = await setup({ pass: true, task: true, answers: [true] });
  await n.run();
  await n.settle();
  assert.equal(n.subagent.length, 0);
});
