import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { registerGate } from "../src/gate.ts";
import { registerGuards } from "../src/guards.ts";
import { APPROVE } from "../src/policy.ts";
import { TASK_DONE_EVENT } from "../src/events.ts";
import { ESCALATE_EVENT, REVIEW_EVENT, VERIFY_EVENT } from "../src/events.ts";
import { installMessage } from "../src/nix.ts";
import { readTask } from "../src/task-state.ts";
import { updateManifest } from "../src/manifest.ts";
import { failureSignature } from "../src/verify.ts";
import { fakePi, fakeUI, isSubagent, tempProject } from "./helpers.ts";

const manifest = (setup: string) => JSON.stringify({ version: 1, setup, verify: ["check"], connectors: [] });
const task = { id: "t1", title: "Do it", status: "implementing", allowedExtra: [], startedAt: "2026-10-01T00:00:00.000Z" };

async function setup(opts: { setup?: string; task?: boolean; pass?: boolean; answers?: unknown[]; review?: string; nix?: boolean | string; status?: string } = {}) {
  const files: Record<string, string> = { ".pi/workflow.json": manifest(opts.setup ?? "done") };
  if (opts.review) files[".pi/workflow.json"] = JSON.stringify({ version: 1, setup: "done", verify: ["check"], connectors: [], models: { review: "p/m" }, review: { minLevel: "low" } });
  if (opts.task) files[".pi/task.json"] = JSON.stringify(task);
  const root = await tempProject(files);
  let diff = "";
  let untracked = "";
  let verifies = 0;
  const subagent: string[] = [];
  const h = fakePi((cmd, args) => {
    if (cmd === "git" && opts.nix !== undefined) return { code: 127, stderr: opts.nix === false ? installMessage() : String(opts.nix) };
    // rev-list: the commit before the task started, the diff base of a task without baseCommit.
    if (cmd === "git") return { code: 0, stdout: args.includes("--name-status") ? opts.status ?? "" : args[0] === "diff" ? diff : args[0] === "rev-list" ? "a".repeat(40) : args[0] === "ls-files" && untracked ? "new.ts\0link\0" : "" };
    if (isSubagent(cmd)) subagent.push(args[0]);
    if (isSubagent(cmd)) return args[0] === "spawn" ? { code: 0, stdout: "Spawned review (abc123)" } : args[0] === "wait" ? { code: 0, stdout: `abc123 finished\n\n${opts.review}` } : { code: 0 };
    verifies++;
    if (opts.nix !== undefined) return { code: 127, stderr: opts.nix === false ? installMessage() : String(opts.nix) };
    return opts.pass ? { code: 0 } : { code: 1, stdout: "Error: boom" };
  });
  const emitted: any[] = [];
  h.pi.events = { emit: (name: string, payload: any) => emitted.push({ name, payload, taskStatus: (() => { try { return JSON.parse(readFileSync(path.join(root, ".pi/task.json"), "utf8")).status; } catch {} })() }) };
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
  return { ...h, root, ctx, ui, notes, emitted, run, settle, verifies: () => verifies, subagent, setDiff: (d: string) => void (diff = d), setUntracked: async (content: string) => {
    untracked = content;
    await fs.writeFile(path.join(root, "new.ts"), content);
    await fs.symlink("missing", path.join(root, "link")).catch(() => {});
  } };
}

test("an exception the user never saw is undone before the gate verifies", async () => {
  const h = await setup({ pass: true, answers: [false] });
  registerGuards(h.pi);
  const call = { toolName: "bash", toolCallId: "1", input: { command: "agentlint accept 1 --reason 'x' &" } };
  await h.emit("tool_call", call, h.ctx);
  await h.emit("tool_result", { ...call, content: [], isError: false }, h.ctx);
  // Written by a background process after the command returned: no later bash call sees it.
  const file = path.join(h.root, ".agentlint", "acceptances.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{"id":"late"}\n');
  await h.run();
  await h.settle();
  assert.deepEqual(h.ui.asked, ["The agent recorded agentlint exceptions. Keep them?"]);
  assert.equal(await fs.readFile(file, "utf8").catch(() => undefined), undefined);
});

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

test("the completion dialog lists the pre-existing tests and verify files the task changed", async () => {
  const t = await setup({ pass: true, task: true, answers: [true], status: "M\0test/old.test.ts\0M\0src/a.ts\0" });
  await t.run();
  await t.settle();
  assert.match(t.ui.messages[0], /Tests and verify setup changed \(check before accepting\):\n- test\/old\.test\.ts$/);
  assert.match(t.notes.join("\n"), /Risk high: tests or verify setup changed \(test\/old\.test\.ts\)/);
  const clean = await setup({ pass: true, task: true, answers: [true] });
  await clean.run();
  await clean.settle();
  assert.doesNotMatch(clean.ui.messages[0], /Tests and verify/);
});

test("a Nix build that fails is an infrastructure failure too: the user hears Nix's message, no retry, no escalation, nothing for the model", async () => {
  const msg = "Nix could not build bash: Could not resolve host. Check your network and disk space, then run /doctor.";
  const t = await setup({ nix: msg, answers: ["Stop here: I will fix it and finish again"] });
  await updateManifest(t.root, (m) => void (m.models = { ...m.models, escalate: "p/strong" }));
  await t.run();
  assert.equal(await t.settle(), undefined);
  assert.equal(t.ui.asked.length, 1);
  assert.equal(t.notes[0], `Verify did not run. ${msg}`);
  assert.equal(t.emitted.filter((e) => e.name === ESCALATE_EVENT).length, 0);
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

async function parallel(models: object, answers: unknown[] = [], verifyOut = "", taskExtra: object = {}, steps = ["check"], perStep?: (step: string) => { code: number; stdout: string }) {
  const root = await tempProject({
    ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: steps, connectors: [], models, review: { minLevel: "low" } }),
    ".pi/task.json": JSON.stringify({ ...task, ...taskExtra }),
  });
  const gate = deferred();
  let out = verifyOut;
  const order: string[] = [];
  let verifyCode = 1;
  const h = fakePi();
  h.pi.exec = async (cmd: string, args: string[]) => {
    const base = { stdout: "", stderr: "", killed: false };
    if (cmd === "git") return { ...base, code: 0, stdout: args[0] === "diff" ? "changed" : "" };
    if (cmd === "tmux") return { ...base, code: 1 };
    if (isSubagent(cmd)) {
      order.push(`subagent:${args[0]}`);
      if (args[0] === "spawn") return { ...base, code: 0, stdout: "Spawned review (abc123)" };
      if (args[0] === "wait") return { ...base, code: 0, stdout: "abc123 finished\n\nVERDICT: CHANGES\n1. bug" };
      return { ...base, code: 0 };
    }
    order.push("verify:start");
    await gate.promise;
    order.push("verify:end");
    if (perStep) return { ...base, ...perStep(args[1]) };
    return { ...base, code: verifyCode, stdout: verifyCode ? out : "" };
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
  return { ...h, ctx, gate, order, emitted, set, notes, setCode: (c: number) => (verifyCode = c), setOut: (o: string) => (out = o), settle: () => h.emit("agent_before_settle", { outcome: "completed" }, ctx) };
}

test("review starts before verify finishes; verify failure ignores the review", async () => {
  const t = await parallel({ review: "p/strong" });
  const settled = t.settle();
  for (let i = 0; i < 400 && !t.order.includes("subagent:wait"); i++) await new Promise((r) => setTimeout(r, 5));
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

const sigOf = (output: string, step = "check") => failureSignature({ ok: false, results: [{ step, ok: false, output }] });
const PREMISE_LINES = /every fix so far assumed something false[\s\S]*contradict it[\s\S]*before you touch code/;
const baselineOf = (output: string, extra: object = {}) => ({ baseline: { ok: false, seconds: 1, failing: [sigOf(output)].filter(Boolean), ...extra } });
const gateEvents = (t: { emitted: any[] }) => t.emitted.filter((e) => e.name === VERIFY_EVENT).map((e) => e.payload);

test("the same failure twice adds the premise lines to the escalation prompt; a different one keeps today's", async () => {
  const same = await parallel({ escalate: "p/strong" }, [false], "Error at src/a.ts:12 expected 3 got 4");
  same.gate.resolve();
  assert.doesNotMatch((await same.settle()).entries[0].content, /every fix so far assumed/);
  const second = await same.settle();
  assert.equal(second.entries[0].customType, "verify-diagnose");
  assert.match(second.entries[0].content, PREMISE_LINES);
  assert.deepEqual(gateEvents(same).map((p) => p.premise), [false, true]);
  const other = await parallel({ escalate: "p/strong" }, [false], "Error at src/a.ts:12 expected 3 got 4");
  other.gate.resolve();
  await other.settle();
  other.setOut("TypeError: x is not a function");
  const diagnose = await other.settle();
  assert.equal(diagnose.entries[0].customType, "verify-diagnose");
  assert.doesNotMatch(diagnose.entries[0].content, /every fix so far assumed/);
});

test("the premise lines go with every repeat from the escalation point on, including failuresBeforeEscalation 1 and the failures after the diagnosing one", async () => {
  const one = await parallel({ escalate: "p/strong" }, [], "Error: x 1");
  await updateManifest(one.ctx.cwd, (m) => void (m.limits = { failuresBeforeEscalation: 1, verifyRetries: 9 }));
  one.gate.resolve();
  const first = await one.settle();
  assert.equal(first.entries[0].customType, "verify-diagnose");
  assert.doesNotMatch(first.entries[0].content, /every fix so far assumed/);
  const second = await one.settle();
  assert.equal(second.entries[0].customType, "verify-gate");
  assert.match(second.entries[0].content, /Fix it, then finish\.[\s\S]*every fix so far assumed/);
  one.setOut("Error: y 2");
  assert.doesNotMatch((await one.settle()).entries[0].content, /every fix so far assumed/);
  one.setOut("Error: y 2");
  assert.match((await one.settle()).entries[0].content, PREMISE_LINES);
  const late = await parallel({ escalate: "p/strong" }, [], "Error: z 1");
  await updateManifest(late.ctx.cwd, (m) => void (m.limits = { verifyRetries: 9 }));
  late.gate.resolve();
  assert.doesNotMatch((await late.settle()).entries[0].content, /every fix so far assumed/);
  assert.match((await late.settle()).entries[0].content, PREMISE_LINES);
  const third = await late.settle();
  assert.equal(third.entries[0].customType, "verify-gate");
  assert.match(third.entries[0].content, /Fix it, then finish\.[\s\S]*every fix so far assumed/);
});

test("a failure that predates the change lets the agent finish: no retry, no escalation, a note, a task record and one notice", async () => {
  const out = "FAIL test/old.test.ts after 7ms\nError: expected 1 got 2";
  const t = await parallel({ escalate: "p/strong" }, [false, false], out, baselineOf(out));
  t.gate.resolve();
  t.setOut("FAIL test/old.test.ts after 9ms\nError: expected 1 got 2");
  assert.equal(await t.settle(), undefined);
  assert.deepEqual(t.set, []);
  assert.equal(t.emitted.find((e) => e.name === ESCALATE_EVENT), undefined);
  assert.deepEqual((await readTask(t.ctx.cwd))?.predates, ["FAIL test/old.test.ts after 9ms", "Error: expected 1 got 2"]);
  assert.equal(t.notes.filter((n) => /predate this change/.test(n)).length, 1);
  assert.match(t.notes.find((n) => /predate/.test(n))!, /^Verify fails, but only with failures that predate this change: FAIL test\/old\.test\.ts after 9ms \| Error: expected 1 got 2$/);
  assert.deepEqual(gateEvents(t).map((p) => [p.kind, p.ok, p.predates]), [["gate", false, true]]);
  assert.deepEqual(t.ctx.ui.asked, ["Only old failures remain"]);
  assert.match(t.ctx.ui.messages[0], /done\?\n\nThese steps still fail, as they did before the task:\n- check$/);
  t.setOut("a brand new failure: Error 5");
  await t.emit("tool_result", { toolName: "write" }, t.ctx);
  const fresh = await t.settle();
  assert.match(fresh.entries[0].content, /Fix it, then finish/);
  assert.doesNotMatch(fresh.entries[0].content, /predate/);
  t.setCode(0);
  await t.settle();
  assert.equal((await readTask(t.ctx.cwd))?.predates, undefined);
});

test("the stored predating lines follow the latest verify, not the first one", async () => {
  const out = "FAIL test/old.test.ts\nError: expected 1 got 2";
  const t = await parallel({}, [false, false], out, baselineOf(out));
  t.gate.resolve();
  assert.equal(await t.settle(), undefined);
  assert.deepEqual((await readTask(t.ctx.cwd))?.predates, ["FAIL test/old.test.ts", "Error: expected 1 got 2"]);
  t.setOut("FAIL test/old.test.ts");
  await t.emit("tool_result", { toolName: "write" }, t.ctx);
  assert.equal(await t.settle(), undefined);
  assert.deepEqual((await readTask(t.ctx.cwd))?.predates, ["FAIL test/old.test.ts"]);
});

test("a new line, a baseline that passed or one without lines is a normal failure", async () => {
  const out = "FAIL test/old.test.ts\nError: expected 1 got 2";
  for (const [now, extra] of [
    [`${out}\nError: brand new`, baselineOf(out)],
    [out, { baseline: { ok: true, seconds: 1 } }],
    [out, { baseline: { ok: false, seconds: 1 } }],
    [out, {}],
  ] as const) {
    const t = await parallel({}, [], now, extra);
    t.gate.resolve();
    const r = await t.settle();
    assert.match(r.entries[0].content, /Fix it, then finish/, now);
    assert.equal((await readTask(t.ctx.cwd))?.predates, undefined);
  }
});

const twoSteps = (second: { code: number; stdout: string }) => (step: string) => (step === "check" ? { code: 1, stdout: "FAIL old.test.ts" } : second);
const withBaseline = (...failing: [string, string][]) => ({ baseline: { ok: false, seconds: 1, failing: failing.map(([step, out]) => sigOf(out, step)) } });

test("step 1 predates and a later step passes: the gate runs on and the agent finishes with the note", async () => {
  const t = await parallel({}, [false], "", withBaseline(["check", "FAIL old.test.ts"]), ["check", "types"], twoSteps({ code: 0, stdout: "" }));
  t.gate.resolve();
  assert.equal(await t.settle(), undefined);
  assert.equal(t.order.filter((o) => o === "verify:end").length, 2);
  assert.deepEqual((await readTask(t.ctx.cwd))?.predates, ["FAIL old.test.ts"]);
  assert.equal(t.notes.filter((n) => /predate this change/.test(n)).length, 1);
});

test("step 1 predates and a later step fails with something new: it blocks, and the report is the new failure", async () => {
  const t = await parallel({}, [], "", withBaseline(["check", "FAIL old.test.ts"]), ["check", "types"], twoSteps({ code: 1, stdout: "Error TS2322 in a.ts" }));
  t.gate.resolve();
  const r = await t.settle();
  assert.match(r.entries[0].content, /Fix it, then finish/);
  assert.match(r.entries[0].content, /Error TS2322 in a\.ts/);
  assert.equal((await readTask(t.ctx.cwd))?.predates, undefined);
});

test("a later step that failed at the baseline with the same lines predates too; one the baseline never saw failing does not", async () => {
  const both = await parallel({}, [false], "", withBaseline(["check", "FAIL old.test.ts"], ["types", "Error TS1 in a.ts"]), ["check", "types"], twoSteps({ code: 1, stdout: "Error TS1 in a.ts" }));
  both.gate.resolve();
  assert.equal(await both.settle(), undefined);
  const unseen = await parallel({}, [], "", withBaseline(["check", "FAIL old.test.ts"]), ["check", "types"], twoSteps({ code: 1, stdout: "Error TS1 in a.ts" }));
  unseen.gate.resolve();
  assert.match((await unseen.settle()).entries[0].content, /Fix it, then finish/);
});

test("a failing agentlint rule never counts as predating", async () => {
  const out = "agentlint: unresolved findings\nerror x";
  const lint = "agentlint check --all";
  const t = await parallel({}, [], out, { baseline: { ok: false, seconds: 1, failing: [sigOf(out, lint)] } }, [lint]);
  t.gate.resolve();
  assert.match((await t.settle()).entries[0].content, /This is an agentlint rule/);
});

test("the agentlint step setup recorded is an agentlint rule whatever its command, never predating", async () => {
  const out = "agentlint: unresolved findings\nerror x";
  const step = "pnpm agentlint check --all";
  const t = await parallel({}, [], out, { baseline: { ok: false, seconds: 1, failing: [sigOf(out, step)] } }, [step]);
  await updateManifest(t.ctx.cwd, (m) => void (m.agentlintStep = step));
  t.gate.resolve();
  assert.match((await t.settle()).entries[0].content, /This is an agentlint rule/);
});

const slow = { baseline: { ok: true, seconds: 1 } };
const everyOne = async (t: { root: string }, limits: object = { verifyEvery: 1 }) => updateManifest(t.root, (m) => void (m.limits = limits));

test("every verifyEvery writes the first verify command runs and its result is appended to the tool result", async () => {
  const t = await setup({ pass: false, task: true });
  await updateManifest(t.root, (m) => void (m.limits = { verifyEvery: 2 }));
  await fs.writeFile(path.join(t.root, ".pi/task.json"), JSON.stringify({ ...task, ...slow }));
  await t.emit("before_agent_start", { messageType: "user" }, t.ctx);
  const event = { toolName: "edit", content: [{ type: "text", text: "edited" }] };
  assert.equal(await t.emit("tool_result", event, t.ctx), undefined);
  assert.equal(t.verifies(), 0);
  const second: any = await t.emit("tool_result", event, t.ctx);
  assert.equal(t.verifies(), 1);
  assert.equal(second.content[0].text, "edited");
  assert.match(second.content[1].text, /Progress check: `check` fails\. This is not the final gate[\s\S]*boom/);
  assert.equal(await t.emit("tool_result", event, t.ctx), undefined);
  assert.equal(await t.emit("tool_result", { toolName: "read", content: [] }, t.ctx), undefined);
  assert.ok((await t.emit("tool_result", event, t.ctx)) !== undefined);
  assert.equal(t.verifies(), 2);
  assert.deepEqual(t.emitted.filter((e) => e.name === VERIFY_EVENT).map((e) => [e.payload.kind, e.payload.ok]), [["progress", false], ["progress", false]]);
});

test("a progress failure says it may be expected mid-change (a test for code not written yet) and to fix it only if not", async () => {
  const t = await setup({ pass: false, task: true });
  await everyOne(t);
  await fs.writeFile(path.join(t.root, ".pi/task.json"), JSON.stringify({ ...task, ...slow }));
  const text = ((await t.emit("tool_result", { toolName: "write", content: [] }, t.ctx)) as any).content[0].text;
  assert.match(text, /not the final gate, and a failure can be expected mid-change \(a test for code you have not written yet\)\. Fix it only if it is not\./);
  assert.doesNotMatch(text, /fix it if your change caused it/);
});

test("the progress check says when it passes or already failed at baseline, and never runs when off or not implementing", async () => {
  const pass = await setup({ pass: true, task: true });
  await everyOne(pass);
  await fs.writeFile(path.join(pass.root, ".pi/task.json"), JSON.stringify({ ...task, ...slow }));
  const event = { toolName: "write", content: [] };
  assert.match(((await pass.emit("tool_result", event, pass.ctx)) as any).content[0].text, /^Progress check: `check` passes\.$/);
  const old = await setup({ pass: false, task: true });
  await everyOne(old);
  await fs.writeFile(path.join(old.root, ".pi/task.json"), JSON.stringify({ ...task, ...baselineOf("Error: boom") }));
  assert.match(((await old.emit("tool_result", event, old.ctx)) as any).content[0].text, /fails \(it already failed before the change\)/);
  const off = await setup({ pass: false, task: true });
  await everyOne(off, { verifyEvery: 0 });
  await fs.writeFile(path.join(off.root, ".pi/task.json"), JSON.stringify({ ...task, ...slow }));
  for (let i = 0; i < 6; i++) assert.equal(await off.emit("tool_result", event, off.ctx), undefined);
  const planning = await setup({ pass: false, task: true });
  await everyOne(planning);
  await fs.writeFile(path.join(planning.root, ".pi/task.json"), JSON.stringify({ ...task, ...slow, status: "planning" }));
  assert.equal(await planning.emit("tool_result", event, planning.ctx), undefined);
  assert.equal(off.verifies() + planning.verifies(), 0);
});

test("the progress check is on by default every 5 writes", async () => {
  const t = await setup({ pass: true, task: true });
  await fs.writeFile(path.join(t.root, ".pi/task.json"), JSON.stringify({ ...task, ...slow }));
  const event = { toolName: "write", content: [] };
  for (let i = 0; i < 4; i++) assert.equal(await t.emit("tool_result", event, t.ctx), undefined);
  assert.ok(await t.emit("tool_result", event, t.ctx));
});

test("the progress check is skipped when the baseline's first step took 30 s or more; the first write result says why, once", async () => {
  const t = await setup({ pass: false, task: true });
  await everyOne(t);
  await fs.writeFile(path.join(t.root, ".pi/task.json"), JSON.stringify({ ...task, baseline: { ok: true, seconds: 45.4 } }));
  const event = { toolName: "write", content: [{ type: "text", text: "wrote" }] };
  const first: any = await t.emit("tool_result", event, t.ctx);
  assert.equal(first.content[0].text, "wrote");
  assert.match(first.content[1].text, /^Progress check off: `check` took 45 s before the change, over 30 s\./);
  for (let i = 0; i < 3; i++) assert.equal(await t.emit("tool_result", event, t.ctx), undefined);
  assert.equal(t.verifies(), 0);
  const edge = await setup({ pass: true, task: true });
  await everyOne(edge);
  await fs.writeFile(path.join(edge.root, ".pi/task.json"), JSON.stringify({ ...task, baseline: { ok: true, seconds: 29.9 } }));
  assert.match(((await edge.emit("tool_result", event, edge.ctx)) as any).content[1].text, /passes/);
});

test("the progress check does not run without a recorded baseline duration", async () => {
  const t = await setup({ pass: true, task: true });
  await everyOne(t);
  for (let i = 0; i < 3; i++) assert.equal(await t.emit("tool_result", { toolName: "write", content: [] }, t.ctx), undefined);
  assert.equal(t.verifies(), 0);
});

test("the progress check has a 60 s cap", async () => {
  const t = await setup({ pass: true, task: true });
  const timeouts: number[] = [];
  const exec = t.pi.exec;
  t.pi.exec = (cmd: string, args: string[], o: any) => (timeouts.push(o?.timeout), exec(cmd, args, o));
  await everyOne(t);
  await fs.writeFile(path.join(t.root, ".pi/task.json"), JSON.stringify({ ...task, ...slow }));
  await t.emit("tool_result", { toolName: "write", content: [] }, t.ctx);
  assert.deepEqual(timeouts, [60_000]);
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

test("the low-risk skip counts when the task completes without a review, not before verify or on a failed settle", async () => {
  const skips = (t: any) => t.emitted.filter((e: any) => e.name === REVIEW_EVENT && e.payload.status === "skipped-low-risk").length;
  const small = { ...task, plan: { summary: "s", steps: [], files: [], decisions: [], interface: [], seams: [] } };
  const failing = await setup({ pass: false, task: true, review: "VERDICT: OK", answers: [] });
  await fs.writeFile(path.join(failing.root, ".pi/task.json"), JSON.stringify(small));
  await failing.run();
  await failing.settle();
  assert.equal(skips(failing), 0, "verify failed: the task is not done");
  const passing = await setup({ pass: true, task: true, review: "VERDICT: OK", answers: [true] });
  await fs.writeFile(path.join(passing.root, ".pi/task.json"), JSON.stringify(small));
  await passing.run();
  await passing.settle();
  assert.equal(skips(passing), 1);
  assert.equal(passing.emitted.find((e: any) => e.payload?.status === "skipped-low-risk").taskStatus, "implementing", "emitted while the task is still active, before it is marked done");
  assert.equal((await readTask(passing.root))?.status, "done");
});

test("a task already reviewed in an earlier turn is not counted as a low-risk skip", async () => {
  const t = await setup({ pass: true, task: true, review: "VERDICT: OK", answers: [false, true] });
  await t.run();
  await t.settle();
  assert.equal(t.subagent.filter((a) => a === "spawn").length, 1, "no plan: low risk, reviewed");
  // Next turn: the task got a plan, so the diff is now below the policy.
  await fs.writeFile(path.join(t.root, ".pi/task.json"), JSON.stringify({ ...task, plan: { summary: "s", steps: [], files: [], decisions: [], interface: [], seams: [] } }));
  await t.run();
  t.setDiff("changed again");
  await t.settle();
  assert.equal((await readTask(t.root))?.status, "done");
  assert.equal(t.emitted.filter((e: any) => e.name === REVIEW_EVENT && e.payload.status === "skipped-low-risk").length, 0);
});

test("no escalation without a configured model", async () => {
  const t = await parallel({});
  t.gate.resolve();
  for (let i = 0; i < 2; i++) await t.settle();
  assert.deepEqual(t.set, []);
  assert.equal(t.emitted.some((e) => e.name === ESCALATE_EVENT), false);
});

test("a failing test that merely mentions agentlint is an ordinary failure: counted, then diagnosed", async () => {
  const t = await parallel({ escalate: "p/strong" }, [], "FAIL test/agentlint-config.test.ts: expected 2, got 3");
  t.gate.resolve();
  const first = await t.settle();
  assert.doesNotMatch(first.entries[0].content, /agentlint rule/);
  assert.equal((await t.settle()).entries[0].customType, "verify-diagnose");
});

test("an agentlint failure never escalates and tells the model how to record an exception", async () => {
  const t = await parallel({ escalate: "p/strong" }, ["Make the model fix it", "Make the model fix it"], "facturas/tax-review src/invoice.js:11\n2 unresolved findings — gate closed", {}, ["agentlint check --all"]);
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
    ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: ["npm exec agentlint -- check --all"], connectors: [], agentlint: "npm exec agentlint --" }),
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
  assert.ok(calls.some((c) => /shift; npm exec --package=@aurelienbbn\/agentlint -- agentlint "\$@" human:\S+ approve --reason Cambio revisado por finanzas sel-1$/.test(c)));
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

/** A high-risk diff (package.json changed) with models.review set and the given review policy. */
async function highRisk(review?: object, models: object = { review: "p/m" }) {
  const root = await tempProject({
    ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: ["check"], connectors: [], models, ...(review && { review }) }),
    ".pi/task.json": JSON.stringify({ ...task, plan: { summary: "s", steps: [], files: ["package.json"], decisions: [], interface: [], seams: [] } }),
  });
  let started = false;
  const spawned: string[] = [];
  const h = fakePi((cmd, args) => {
    if (cmd === "git") return { code: 0, stdout: args.includes("--numstat") ? "3\t0\tpackage.json\0" : started ? "changed" : "" };
    if (isSubagent(cmd)) {
      spawned.push(args[0]);
      return args[0] === "spawn" ? { code: 0, stdout: "Spawned review (abc123)" } : args[0] === "wait" ? { code: 0, stdout: "abc123 finished\n\nVERDICT: APPROVED" } : { code: 0 };
    }
    return { code: 0 };
  });
  const emitted: any[] = [];
  h.pi.events = { emit: (name: string, payload: any) => emitted.push({ name, payload }) };
  registerGate(h.pi);
  const ui: any = fakeUI([true]);
  const notes: string[] = [];
  ui.notify = (m: string) => void notes.push(m);
  const ctx: any = { cwd: root, hasUI: true, ui };
  await h.emit("before_agent_start", { messageType: "user" }, ctx);
  started = true;
  await h.emit("agent_before_settle", { outcome: "completed" }, ctx);
  return { notes, spawned, status: emitted.find((e) => e.name === REVIEW_EVENT)?.payload.status };
}

test("a review skipped as low risk on one settle does not use up the review a later, riskier diff needs", async () => {
  const root = await tempProject({
    ".pi/workflow.json": JSON.stringify({ version: 1, setup: "done", verify: ["check"], connectors: [], models: { review: "p/m" } }),
    ".pi/task.json": JSON.stringify({ ...task, plan: { summary: "s", steps: [], files: [], decisions: [], interface: [], seams: [] } }),
  });
  let stat = "1\t0\tsrc/a.ts\0";
  let state = "";
  let checks = 0;
  const spawned: string[] = [];
  const h = fakePi((cmd, args) => {
    if (cmd === "git") return { code: 0, stdout: args.includes("--numstat") ? stat : state };
    if (isSubagent(cmd)) {
      spawned.push(args[0]);
      return args[0] === "wait" ? { code: 0, stdout: "abc123 finished\n\nVERDICT: APPROVED" } : { code: 0, stdout: "Spawned review (abc123)" };
    }
    return checks++ ? { code: 0 } : { code: 1, stderr: "Error: boom" };
  });
  h.pi.events = { emit: () => {} };
  registerGate(h.pi);
  const ctx: any = { cwd: root, hasUI: true, ui: fakeUI([true]) };
  await h.emit("before_agent_start", { messageType: "user" }, ctx);
  state = "changed";
  await h.emit("agent_before_settle", { outcome: "completed" }, ctx);
  assert.equal(spawned.length, 0);
  stat = "3\t0\tpackage.json\0";
  state = "changed again";
  await h.emit("agent_before_settle", { outcome: "completed" }, ctx);
  assert.ok(spawned.includes("spawn"));
});

test("review.minLevel is high by default: a high-risk diff gets a review when models.review is set", async () => {
  const r = await highRisk();
  assert.ok(r.spawned.includes("spawn"));
  assert.equal(r.status, "approved");
  assert.ok(r.notes.some((n) => /^Risk high.*\(review requested\)$/.test(n)));
});

test("a review that is off is reported as not requested, with how to turn it on, not as a low-risk skip", async () => {
  const r = await highRisk({ minLevel: "off" });
  assert.deepEqual(r.spawned, []);
  assert.equal(r.status, "not-requested");
  assert.ok(r.notes.some((n) => /^Review not requested \(risk high\).*Set review\.minLevel/.test(n)));
  assert.equal((await highRisk({ never: true })).status, "not-requested");
});

test("with review off and no models.review the Risk line says the model is missing", async () => {
  const r = await highRisk({ minLevel: "off" }, {});
  assert.ok(r.notes.some((n) => /^Risk high.*\(review not requested; models\.review is not set\)$/.test(n)));
});

test("the done dialog names the task on one line, even when the title holds a whole ticket", async () => {
  const t = await setup({ pass: true, answers: [true] });
  await fs.mkdir(path.join(t.root, ".pi"), { recursive: true });
  await fs.writeFile(path.join(t.root, ".pi/task.json"), JSON.stringify({ ...task, title: `# Superconduct shred\n\n${"long body ".repeat(50)}` }));
  const asked: string[][] = [];
  t.ctx.ui.confirm = async (title: string, message: string) => (asked.push([title, message]), true);
  await t.run();
  await t.settle();
  assert.equal(asked.length, 1);
  assert.equal(asked[0][1], 'Is the task "Superconduct shred" done?');
});

test("without a UI a passing verify marks the task done; only old failures keep it open with a notice", async () => {
  const t = await setup({ pass: true, task: true });
  t.ctx.hasUI = false;
  await t.run();
  assert.equal(await t.settle(), undefined);
  assert.equal((await readTask(t.root))?.status, "done");
  assert.ok(t.emitted.some((e) => e.name === TASK_DONE_EVENT && e.payload.hasUI === false));
  const out = "FAIL test/old.test.ts\nError: expected 1 got 2";
  const old = await parallel({}, [], out, baselineOf(out));
  old.ctx.hasUI = false;
  old.gate.resolve();
  assert.equal(await old.settle(), undefined);
  assert.equal((await readTask(old.ctx.cwd))?.status, "implementing");
  assert.equal(old.emitted.find((e) => e.name === TASK_DONE_EVENT), undefined);
  assert.match(old.notes.at(-1)!, /^The task stays open: verify still fails as it did before the task \(check\)\. \/task done closes it\.$/);
});

test("declining the done dialog says how to close the task later", async () => {
  const t = await setup({ pass: true, task: true, answers: [false] });
  await t.run();
  await t.settle();
  assert.equal((await readTask(t.root))?.status, "implementing");
  assert.equal(t.notes.at(-1), "The task stays open. /task done closes it.");
});

test("a .pi/workflow.json that does not parse is reported, not a silently open gate", async () => {
  const t = await setup({ pass: true });
  await fs.writeFile(path.join(t.root, ".pi/workflow.json"), '<<<<<<< HEAD\n{"version": 1}\n');
  await t.run();
  assert.equal(await t.settle(), undefined);
  assert.match(t.notes[0], /^Verify did not run: \.pi\/workflow\.json is not valid JSON/);
});

test("the same diff is not reviewed twice; a changed one is", async () => {
  const t = await setup({ pass: true, task: true, review: "VERDICT: APPROVED", answers: [false, false, false] });
  await t.run();
  await t.settle();
  // A later message that rewrites the files to the same content: nothing new to review.
  await t.run();
  await t.emit("tool_result", { toolName: "write" }, t.ctx);
  await t.settle();
  assert.equal(t.subagent.filter((s) => s === "spawn").length, 1);
  assert.equal(t.verifies(), 2);
  await t.run();
  t.setDiff("changed again");
  await t.settle();
  assert.equal(t.subagent.filter((s) => s === "spawn").length, 2);
});

test("leaving an escalated attempt does not undo a model picked since (/task cancel, /task done, the user)", async () => {
  const t = await parallel({ escalate: "p/strong" }, [false]);
  t.gate.resolve();
  await t.settle();
  await t.settle();
  assert.deepEqual(t.set, ["p/strong"]);
  t.ctx.model = { provider: "p", id: "mine" };
  await t.emit("before_agent_start", { messageType: "user" }, t.ctx);
  assert.deepEqual(t.set, ["p/strong"]);
});

test("editing an untracked file (even only its line ends, next to a dangling link) is a new diff to review; a review that did not run is tried again on the same diff", async () => {
  const t = await setup({ pass: true, task: true, review: "VERDICT: APPROVED", answers: [false, false, false] });
  await t.setUntracked("a\n");
  await t.run();
  await t.settle();
  await t.run();
  await t.setUntracked("a\r\n");
  await t.settle();
  // A chmod alone, with the old mtime put back, is a change too.
  const file = path.join(t.root, "new.ts");
  await fs.utimes(file, 1e9, 1e9);
  await t.run();
  await fs.chmod(file, 0o755);
  await fs.utimes(file, 1e9, 1e9);
  await t.settle();
  assert.equal(t.notes.filter((n) => n === "Diff review: approved.").length, 3);
  const s = await setup({ pass: true, task: true, review: "no verdict here", answers: [false, false] });
  await s.run();
  await s.emit("tool_result", { toolName: "write" }, s.ctx);
  await s.settle();
  // The same single write as the first turn: the same state, which a skipped review must not leave verified.
  await s.run();
  await s.emit("tool_result", { toolName: "write" }, s.ctx);
  await s.settle();
  assert.equal(s.notes.filter((n) => n.startsWith("Review skipped")).length, 2);
});

test("a TUI turn that ends on a question waits for the answer once; the next turn runs the gate even on a question", async () => {
  const t = await setup({ pass: true, task: true, answers: [false] });
  t.ctx.mode = "tui";
  const say = (text: string) => t.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text }] } }, t.ctx);
  await t.run();
  await say("Changed the fee.\nShould it round up?");
  assert.equal(await t.settle(), undefined);
  assert.equal(t.verifies(), 0);
  await t.run();
  t.setDiff("changed again");
  await say("Rounded up. Anything else?");
  await t.settle();
  assert.equal(t.verifies(), 1);
  // An answer turn that changes nothing still runs the deferred gate.
  const n = await setup({ pass: true, task: true, answers: [false] });
  n.ctx.mode = "tui";
  await n.run();
  await n.emit("message_end", { message: { role: "assistant", content: "Should it round up?" } }, n.ctx);
  await n.settle();
  await n.emit("before_agent_start", { messageType: "user" }, n.ctx);
  await n.emit("message_end", { message: { role: "assistant", content: "Kept it as is." } }, n.ctx);
  await n.settle();
  assert.equal(n.verifies(), 1);
  // RPC (no TUI): never deferred.
  const r = await setup({ pass: true, task: true, answers: [false] });
  r.ctx.mode = "rpc";
  await r.run();
  await r.emit("message_end", { message: { role: "assistant", content: "Should it round up?" } }, r.ctx);
  await r.settle();
  assert.equal(r.verifies(), 1);
});
