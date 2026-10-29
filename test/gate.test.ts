import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { registerGate } from "../src/gate.ts";
import { APPROVE } from "../src/policy.ts";
import { TASK_DONE_EVENT } from "../src/events.ts";
import { ESCALATE_EVENT, REVIEW_EVENT, VERIFY_EVENT } from "../src/events.ts";
import { installMessage } from "../src/nix.ts";
import { readTask } from "../src/task-state.ts";
import { fakePi, fakeUI, isSubagent, tempProject } from "./helpers.ts";

const manifest = (setup: string) => JSON.stringify({ version: 1, setup, verify: ["check"], connectors: [] });
const task = { id: "t1", title: "Do it", status: "implementing", allowedExtra: [], startedAt: "now" };

async function setup(opts: { setup?: string; task?: boolean; pass?: boolean; answers?: unknown[]; review?: string; nix?: boolean | string } = {}) {
  const files: Record<string, string> = { ".pi/workflow.json": manifest(opts.setup ?? "done") };
  if (opts.review) files[".pi/workflow.json"] = JSON.stringify({ version: 1, setup: "done", verify: ["check"], connectors: [], models: { review: "p/m" }, review: { minLevel: "low" } });
  if (opts.task) files[".pi/task.json"] = JSON.stringify(task);
  const root = await tempProject(files);
  let diff = "";
  let verifies = 0;
  const subagent: string[] = [];
  const h = fakePi((cmd, args) => {
    if (cmd === "git" && opts.nix !== undefined) return { code: 127, stderr: opts.nix === false ? installMessage() : String(opts.nix) };
    if (cmd === "git") return { code: 0, stdout: args[0] === "diff" ? diff : "" };
    if (isSubagent(cmd)) subagent.push(args[0]);
    if (isSubagent(cmd)) return args[0] === "spawn" ? { code: 0, stdout: "Spawned review (abc123)" } : args[0] === "wait" ? { code: 0, stdout: `abc123 finished\n\n${opts.review}` } : { code: 0 };
    verifies++;
    if (opts.nix !== undefined) return { code: 127, stderr: opts.nix === false ? installMessage() : String(opts.nix) };
    return opts.pass ? { code: 0 } : { code: 1, stdout: "boom" };
  });
  const emitted: any[] = [];
  h.pi.events = { emit: (name: string, payload: any) => emitted.push({ name, payload }) };
  registerGate(h.pi);
  const ui = fakeUI(opts.answers ?? []);
  const notes: string[] = [];
  (ui as any).notify = (m: string) => void notes.push(m);
  const ctx: any = { cwd: root, hasUI: true, ui };
  const run = async () => {
    await h.emit("before_agent_start", { messageType: "user" }, ctx);
    diff = "changed";
  };
  const settle = () => h.emit("agent_before_settle", { outcome: "completed" }, ctx);
  return { ...h, root, ctx, ui, notes, emitted, run, settle, verifies: () => verifies, subagent };
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
  const t = await setup({ answers: ["Keep trying", "Leave it as is"] });
  await t.run();
  for (let i = 0; i < 2; i++) assert.equal((await t.settle()).continue, true);
  assert.equal(t.ui.asked.length, 0);
  assert.equal((await t.settle()).continue, true);
  assert.equal(await t.settle(), undefined);
  assert.equal(t.ui.asked.length, 2);
});

test("missing Nix tells the user, asks whether to leave the work unverified, and sends nothing to the model", async () => {
  const t = await setup({ nix: false, answers: Array(5).fill("Leave the work unverified") });
  await t.run();
  for (let i = 0; i < 5; i++) assert.equal(await t.settle(), undefined);
  assert.equal(t.ui.asked.length, 5, "a state git could not read is never remembered as verified, so each turn asks again");
  assert.match(t.ui.asked[0], /Verify did not run\. Nix is required and was not found/);
  assert.match(t.notes[0], /^Verify did not run\. Nix is required and was not found/);
  assert.equal(t.emitted.filter((e) => e.name === ESCALATE_EVENT).length, 0);
  assert.notEqual((await readTask(t.root))?.status, "done");
});

test("a Nix build that fails shows Nix's own message, not the install hint", async () => {
  const msg = "Nix could not build bash: Could not resolve host. Check your network and disk space, then run /doctor.";
  const t = await setup({ nix: msg, answers: ["Stop here: I will fix it and finish again"] });
  await t.run();
  assert.equal(await t.settle(), undefined);
  assert.equal(t.notes[0], `Verify did not run. ${msg}`);
});

test("without a UI, missing Nix leaves the task unverified and says so; when git itself fails the work still counts as changed", async () => {
  const t = await setup({ nix: false, task: true });
  t.ctx.hasUI = false;
  await t.run();
  assert.equal(await t.settle(), undefined);
  assert.match(t.notes.join("\n"), /Verify did not run[\s\S]*Unverified: Nix is required[\s\S]*not marked done/);
  assert.equal((await readTask(t.root))?.status, "implementing");
});

test("without a UI, a failed Nix build also leaves the task unverified with Nix's message", async () => {
  const msg = "Nix could not build bash: Could not resolve host.";
  const t = await setup({ nix: msg, task: true });
  t.ctx.hasUI = false;
  await t.run();
  assert.equal(await t.settle(), undefined);
  assert.match(t.notes.join("\n"), new RegExp(`Unverified: ${msg}[\\s\\S]*not marked done`));
  assert.equal((await readTask(t.root))?.status, "implementing");
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
  assert.ok(notes.some((n) => /^Review skipped/.test(n)));
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
    ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: ["check"], connectors: [], models, review: { minLevel: "low" } }),
    ".pi/task.json": JSON.stringify(task),
  });
  const gate = deferred();
  const order: string[] = [];
  let verifyCode = 1;
  const h = fakePi();
  h.pi.exec = async (cmd: string, args: string[]) => {
    const base = { stdout: "", stderr: "", killed: false };
    if (cmd === "git") return { ...base, code: 0, stdout: args[0] === "diff" ? "changed" : "" };
    if (isSubagent(cmd)) {
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

test("1st failure fixes, the 2nd diagnoses and escalates, pass restores the model", async () => {
  const t = await parallel({ escalate: "p/strong" }, [false]);
  t.gate.resolve();
  const first = await t.settle();
  assert.equal(first.entries[0].customType, "verify-gate");
  const second = await t.settle();
  assert.equal(second.entries[0].customType, "verify-diagnose");
  assert.match(second.entries[0].content, /Apply the diagnosing-bugs method[\s\S]*reproduce, isolate, state the hypothesis, then fix\./);
  assert.deepEqual(t.set, ["p/strong"]);
  assert.ok(t.notes.some((n) => n.includes("verify failed 2 times: p/strong takes this attempt")));
  assert.deepEqual(t.emitted.find((e) => e.name === ESCALATE_EVENT).payload, { root: t.ctx.cwd, model: "p/strong" });
  t.setCode(0);
  t.ctx.model = { provider: "p", id: "strong" };
  await t.settle();
  assert.deepEqual(t.set, ["p/strong", "p/cheap"]);
});

test("low-risk diff skips the paid review, notifies and emits skipped-low-risk", async () => {
  const t = await setup({ pass: true, task: true, review: "VERDICT: CHANGES\n1. bug", answers: [true] });
  await fs.writeFile(path.join(t.root, ".pi/task.json"), JSON.stringify({ ...task, plan: { summary: "s", steps: [], files: [], decisions: [], interface: [], seams: [] } }));
  const notes: string[] = [];
  t.ctx.ui.notify = (m: string) => notes.push(m);
  await t.run();
  assert.equal(await t.settle(), undefined);
  assert.equal(t.subagent.length, 0);
  assert.ok(notes.some((n) => n.startsWith("Review skipped (risk none)")));
  assert.equal(t.emitted.find((e) => e.name === REVIEW_EVENT).payload.status, "skipped-low-risk");
  assert.equal((await readTask(t.root))?.status, "done");
});

test("no escalation without a configured model", async () => {
  const t = await parallel({});
  t.gate.resolve();
  for (let i = 0; i < 2; i++) await t.settle();
  assert.deepEqual(t.set, []);
  assert.equal(t.emitted.some((e) => e.name === ESCALATE_EVENT), false);
});

test("an agentlint failure never escalates and tells the model how to record an exception", async () => {
  const t = await parallel({ escalate: "p/strong" }, ["Make the model fix it", "Make the model fix it"], "facturas/tax-review src/invoice.js:11\n2 unresolved findings — gate closed");
  t.gate.resolve();
  let last: any;
  for (let i = 0; i < 2; i++) last = await t.settle();
  assert.deepEqual(t.set, []);
  assert.equal(t.emitted.some((e) => e.name === ESCALATE_EVENT), false);
  assert.match(last.entries[0].content, /the user will be asked to approve/);
});

test("a repeated agentlint failure asks the user; approval records the exception and continues", async () => {
  const report = "facturas/money-review src/invoice.js:11\n1 unresolved findings — gate closed";
  const calls: string[] = [];
  const root = await tempProject({
    ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: ["check"], connectors: [], agentlint: "npm exec agentlint --" }),
    ".pi/task.json": JSON.stringify(task),
  });
  let remaining = 1;
  const h = fakePi((cmd, args) => {
    if (cmd === "git") return { code: 0, stdout: args[0] === "diff" ? "changed" : "" };
    const script = args.slice(4).join(" ");
    calls.push(`${args[1]} ${args.slice(3).join(" ")}`);
    if (/^next --format json/.test(script)) return { code: 0, stdout: JSON.stringify({ remaining, selector: remaining ? "sel-1" : undefined }) };
    if (/^approve /.test(script)) return (remaining = 0), { code: 0 };
    return { code: 1, stdout: report };
  });
  h.pi.events = { emit: () => {} };
  registerGate(h.pi);
  const ui = fakeUI([APPROVE, "Cambio revisado por finanzas"]);
  const ctx: any = { cwd: root, hasUI: true, ui };
  await h.emit("before_agent_start", { messageType: "user" }, ctx);
  await h.emit("tool_result", { toolName: "write" }, ctx);
  const first = await h.emit("agent_before_settle", { outcome: "completed" }, ctx);
  assert.match(first.entries[0].content, /the user will be asked to approve/);
  assert.equal(ui.asked.length, 0);
  const second = await h.emit("agent_before_settle", { outcome: "completed" }, ctx);
  assert.match(ui.asked[0], /agentlint blocks/);
  assert.match(second.entries[0].content, /approved the agentlint exception/);
  assert.ok(calls.some((c) => /shift; npm exec agentlint -- "\$@" human:\S+ approve --reason Cambio revisado por finanzas sel-1$/.test(c)));
});

test("interface contract: names missing from the files block before verify and the review; present names pass", async () => {
  const t = await setup({ pass: true, task: true, review: "VERDICT: APPROVED", answers: [true] });
  const plan = { summary: "s", steps: [], files: ["src/fee.ts"], decisions: [], interface: [{ file: "src/fee.ts", exports: ["fee", "formatFee"], source: "ticket" }], seams: [] };
  await fs.writeFile(path.join(t.root, ".pi/task.json"), JSON.stringify({ ...task, plan }));
  await fs.mkdir(path.join(t.root, "src"), { recursive: true });
  await fs.writeFile(path.join(t.root, "src/fee.ts"), "export const fee = 1;\n");
  await t.run();
  const r = await t.settle();
  assert.equal(r.continue, true);
  assert.equal(r.entries[0].customType, "contract-gate");
  assert.match(r.entries[0].content, /src\/fee\.ts: missing formatFee/);
  assert.equal(t.verifies(), 0);
  assert.equal(t.subagent.length, 0);
  await fs.writeFile(path.join(t.root, "src/fee.ts"), "export const fee = 1;\nexport const formatFee = () => '';\n");
  assert.equal(await t.settle(), undefined);
  assert.equal(t.verifies(), 1);
  assert.equal((await readTask(t.root))?.status, "done");
});

test("contract misses do not use up the verify retries", async () => {
  const t = await setup({ pass: false, task: true });
  const plan = { summary: "s", steps: [], files: ["src/fee.ts"], decisions: [], interface: [{ file: "src/fee.ts", exports: ["fee"], source: "ticket" }], seams: [] };
  await fs.writeFile(path.join(t.root, ".pi/task.json"), JSON.stringify({ ...task, plan }));
  await t.run();
  assert.equal((await t.settle()).entries[0].customType, "contract-gate");
  assert.equal((await t.settle()).entries[0].customType, "contract-gate");
  await fs.mkdir(path.join(t.root, "src"), { recursive: true });
  await fs.writeFile(path.join(t.root, "src/fee.ts"), "export const fee = 1;\n");
  const r = await t.settle();
  assert.equal(r.entries[0].customType, "verify-gate");
  assert.equal(t.ui.asked.length, 0);
});

test("with no verify retries a missing interface asks the user instead of passing", async () => {
  const t = await setup({ pass: true, task: true, answers: ["Leave it as is", "Keep trying"] });
  const plan = { summary: "s", steps: [], files: ["src/fee.ts"], decisions: [], interface: [{ file: "src/fee.ts", exports: ["fee"], source: "ticket" }], seams: [] };
  await fs.writeFile(path.join(t.root, ".pi/task.json"), JSON.stringify({ ...task, plan }));
  await fs.writeFile(path.join(t.root, ".pi/workflow.json"), JSON.stringify({ version: 1, setup: "done", verify: ["check"], connectors: [], limits: { verifyRetries: 0 } }));
  await t.run();
  assert.equal(await t.settle(), undefined);
  assert.equal(t.verifies(), 0);
  assert.equal(t.ui.asked.length, 1);
  assert.equal((await t.settle()).entries[0].customType, "contract-gate");
});

test("a requested review without models.review is announced once; the Risk line says there is no review model", async () => {
  const root = await tempProject({
    ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: ["check"], connectors: [], review: { always: true } }),
    ".pi/task.json": JSON.stringify(task),
  });
  const h = fakePi((cmd, args) => (cmd === "git" ? { code: 0, stdout: args[0] === "diff" ? "changed" : "" } : { code: 0 }));
  h.pi.events = { emit: () => {} };
  registerGate(h.pi);
  const notes: string[] = [];
  const ui = fakeUI([false, false]);
  (ui as any).notify = (m: string) => notes.push(m);
  const ctx: any = { cwd: root, hasUI: true, ui };
  await h.emit("before_agent_start", { messageType: "user" }, ctx);
  await h.emit("tool_result", { toolName: "write" }, ctx);
  await h.emit("agent_before_settle", { outcome: "completed" }, ctx);
  assert.equal(notes.filter((n) => /needs models\.review/.test(n)).length, 1);
  assert.ok(notes.some((n) => /^Risk high.*\(no review model\)$/.test(n)));
});
