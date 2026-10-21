import assert from "node:assert/strict";
import { test } from "node:test";
import { registerGate } from "../src/gate.ts";
import { TASK_DONE_EVENT } from "../src/learn.ts";
import { ESCALATE_EVENT, REVIEW_EVENT, VERIFY_EVENT } from "../src/events.ts";
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
  const doneEvent = t.emitted.find((e) => e.name === TASK_DONE_EVENT);
  assert.equal(doneEvent.payload.root, t.root);
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

test("review CHANGES continues with the findings once; the fix is checked by verify only", async () => {
  const t = await setup({ pass: true, task: true, review: "VERDICT: CHANGES\n1. bug", answers: [true] });
  await t.run();
  const r = await t.settle();
  assert.equal(r.continue, true);
  assert.equal(r.entries[0].customType, "diff-review");
  assert.match(r.entries[0].content, /1\. bug[\s\S]*Fix these, then finish\./);
  assert.equal(await t.settle(), undefined);
  assert.equal(t.subagent.filter((s) => s === "spawn").length, 1);
  assert.equal((await readTask(t.root))?.status, "done");
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

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function parallel(models: object, answers: unknown[] = [], verifyOut = "") {
  const root = await tempProject({
    ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: ["check"], connectors: [], models }),
    ".pi/task.json": JSON.stringify(task),
  });
  const gate = deferred();
  const order: string[] = [];
  let verifyCode = 1;
  const h = fakePi();
  h.pi.exec = async (cmd: string, args: string[]) => {
    const base = { stdout: "", stderr: "", killed: false };
    if (cmd === "git") return { ...base, code: 0, stdout: args[0] === "diff" ? "changed" : "" };
    if (cmd === "subagent") {
      order.push(`subagent:${args[0]}`);
      if (args[0] === "spawn") return { ...base, code: 0, stdout: "Spawned review (abc123)" };
      if (args[0] === "wait") return { ...base, code: 0, stdout: "abc123 finished\n\nVERDICT: CHANGES\n1. bug" };
      return { ...base, code: 0 };
    }
    order.push("verify:start");
    await gate.promise;
    order.push("verify:end");
    return { ...base, code: verifyCode, stdout: verifyCode ? verifyOut : "" };
  };
  const emitted: any[] = [];
  const set: string[] = [];
  h.pi.events = { emit: (name: string, payload: any) => emitted.push({ name, payload }) };
  const mk = (id: string) => ({ provider: "p", id });
  h.pi.setModel = async (m: any) => (set.push(`${m.provider}/${m.id}`), true);
  const notes: string[] = [];
  const ui = { ...fakeUI(answers), notify: (m: string) => notes.push(m) };
  const ctx: any = {
    cwd: root, hasUI: true, ui, model: mk("cheap"),
    modelRegistry: { find: (p: string, id: string) => mk(id), getAvailable: () => [mk("cheap"), mk("strong")] },
  };
  registerGate(h.pi);
  await h.emit("before_agent_start", { messageType: "user" }, ctx);
  await h.emit("tool_result", { toolName: "write" }, ctx);
  return { ...h, ctx, gate, order, emitted, set, notes, setCode: (c: number) => (verifyCode = c), settle: () => h.emit("agent_before_settle", { outcome: "completed" }, ctx) };
}

test("review starts before verify finishes; verify failure ignores the review", async () => {
  const t = await parallel({ review: "p/strong" });
  const settled = t.settle();
  for (let i = 0; i < 50 && !t.order.includes("subagent:wait"); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(t.order.includes("subagent:spawn") && t.order.includes("verify:start") && !t.order.includes("verify:end"));
  t.gate.resolve();
  const r = await settled;
  assert.equal(r.entries[0].customType, "verify-gate");
  assert.equal(t.ctx.ui.asked.length, 0);
  assert.equal(t.emitted.filter((e) => e.name === VERIFY_EVENT).length, 1);
  const v = t.emitted.find((e) => e.name === VERIFY_EVENT).payload;
  assert.equal(v.ok, false);
  assert.equal(typeof v.seconds, "number");
});

test("verify pass handles the parallel review as before and emits both events", async () => {
  const t = await parallel({ review: "p/strong" });
  t.setCode(0);
  t.gate.resolve();
  const r = await t.settle();
  assert.equal(r.entries[0].customType, "diff-review");
  const names = t.emitted.map((e) => e.name);
  assert.ok(names.includes(VERIFY_EVENT) && names.includes(REVIEW_EVENT));
  const rev = t.emitted.find((e) => e.name === REVIEW_EVENT).payload;
  assert.deepEqual([rev.status, rev.model, rev.root], ["changes", "p/strong", t.ctx.cwd]);
});

test("escalates on the 2nd failure and restores the model on pass", async () => {
  const t = await parallel({ escalate: "p/strong" }, [false]);
  t.gate.resolve();
  await t.settle();
  assert.deepEqual(t.set, []);
  await t.settle();
  assert.deepEqual(t.set, ["p/strong"]);
  assert.ok(t.notes.some((n) => n.includes("verify falló 2 veces: este intento lo hace p/strong")));
  assert.deepEqual(t.emitted.find((e) => e.name === ESCALATE_EVENT).payload, { root: t.ctx.cwd, model: "p/strong" });
  t.setCode(0);
  t.ctx.model = { provider: "p", id: "strong" };
  await t.settle();
  assert.deepEqual(t.set, ["p/strong", "p/cheap"]);
});

test("no escalation without a configured model", async () => {
  const t = await parallel({});
  t.gate.resolve();
  for (let i = 0; i < 3; i++) await t.settle();
  assert.deepEqual(t.set, []);
  assert.equal(t.emitted.some((e) => e.name === ESCALATE_EVENT), false);
});

test("an agentlint failure never escalates and tells the model how to record an exception", async () => {
  const t = await parallel({ escalate: "p/strong" }, [], "facturas/tax-review src/invoice.js:11\n2 unresolved findings — gate closed");
  t.gate.resolve();
  let last: any;
  for (let i = 0; i < 3; i++) last = await t.settle();
  assert.deepEqual(t.set, []);
  assert.equal(t.emitted.some((e) => e.name === ESCALATE_EVENT), false);
  assert.match(last.entries[0].content, /agentlint accept command/);
});
