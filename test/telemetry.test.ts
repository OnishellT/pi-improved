import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { ESCALATE_EVENT, REVIEW_EVENT, VERIFY_EVENT } from "../src/events.ts";
import { TASK_DONE_EVENT } from "../src/events.ts";
import { registerLearn } from "../src/learn.ts";
import { loadMetrics, metricsReport, registerTelemetry, taskMetrics } from "../src/telemetry.ts";
import { fakePi, tempProject } from "./helpers.ts";

function setup() {
  const f = fakePi();
  const listeners = new Map<string, (d: unknown) => unknown>();
  f.pi.events = { on: (name: string, fn: any) => listeners.set(name, fn) };
  registerTelemetry(f.pi);
  registerLearn(f.pi);
  return { ...f, fire: (name: string, d: unknown) => listeners.get(name)!(d) };
}
const taskJson = (id: string, status: string) => JSON.stringify({ id, title: "T", status, allowedExtra: [], startedAt: "" });
const msg = (cost: number): any => ({ type: "message_end", message: { role: "assistant", usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, cost: { total: cost } } } });

test("accumulates usage per phase and counts events", async () => {
  const root = await tempProject({ ".pi/task.json": taskJson("M-1", "planning") });
  const s = setup();
  const ctx = { cwd: root, ui: { notify: () => {} } };
  await s.emit("message_end", msg(0.5), ctx);
  await s.emit("message_end", { type: "message_end", message: { role: "user" } }, ctx);
  await fs.writeFile(path.join(root, ".pi/task.json"), taskJson("M-1", "implementing"));
  await s.emit("message_end", msg(0.25), ctx);
  await s.emit("message_end", msg(0.25), ctx);
  await s.fire(VERIFY_EVENT, { root, kind: "gate", ok: false, seconds: 1 });
  await s.fire(VERIFY_EVENT, { root, kind: "gate", ok: true, seconds: 1 });
  await s.fire(REVIEW_EVENT, { root, status: "changes", model: "x", seconds: 2 });
  await s.fire(ESCALATE_EVENT, { root, model: "big" });
  const m = taskMetrics("M-1")!;
  assert.deepEqual([m.phases.planning.input, m.phases.planning.cost], [100, 0.5]);
  assert.deepEqual([m.phases.implementing.output, m.phases.implementing.cacheRead, m.phases.implementing.cost], [20, 100, 0.5]);
  assert.deepEqual([m.verifyRuns, m.verifyFailures, m.escalations, m.reviews.length], [2, 1, 1, 1]);
});

test("baseline, progress, predating and premise runs are recorded apart from the final verifies", async () => {
  const root = await tempProject({ ".pi/task.json": taskJson("M-3", "implementing") });
  const s = setup();
  await s.fire(VERIFY_EVENT, { root, kind: "baseline", ok: false, seconds: 4.5 });
  await s.fire(VERIFY_EVENT, { root, kind: "progress", ok: false, seconds: 1 });
  await s.fire(VERIFY_EVENT, { root, kind: "progress", ok: true, seconds: 1 });
  await s.fire(VERIFY_EVENT, { root, kind: "gate", ok: false, seconds: 2, predates: true });
  await s.fire(VERIFY_EVENT, { root, kind: "gate", ok: false, seconds: 2, premise: true });
  await s.fire(VERIFY_EVENT, { root, kind: "gate", ok: false, seconds: 2, premise: false });
  const m = taskMetrics("M-3")!;
  assert.deepEqual(m.baseline, { ok: false, seconds: 4.5 });
  assert.deepEqual(m.progress, { runs: 2, failures: 1 });
  assert.deepEqual([m.verifyRuns, m.verifyFailures, m.predated, m.premises], [3, 2, 1, 1]);
});

test("snapshots are written through a temp file: no leftovers, valid JSON", async () => {
  const root = await tempProject({ ".pi/task.json": taskJson("M-9", "planning") });
  const s = setup();
  await Promise.all([s.emit("message_end", msg(0.1), { cwd: root }), s.fire(VERIFY_EVENT, { root, kind: "gate", ok: true, seconds: 1 })]);
  const files = await fs.readdir(path.join(root, ".pi/metrics"));
  assert.deepEqual(files, ["M-9.json"]);
  JSON.parse(await fs.readFile(path.join(root, ".pi/metrics/M-9.json"), "utf8"));
});

test("ignores usage without an active task", async () => {
  const root = await tempProject({});
  const s = setup();
  await s.emit("message_end", msg(1), { cwd: root });
  assert.equal(await loadMetrics(root, "none"), undefined);
  await assert.rejects(fs.readdir(path.join(root, ".pi/metrics")));
});

test("snapshot is persisted and reloaded; learn record includes metrics; /metrics reports", async () => {
  const root = await tempProject({ ".pi/task.json": taskJson("M-2", "implementing") });
  const s = setup();
  const notes: string[] = [];
  const ctx = { cwd: root, ui: { notify: (t: string) => notes.push(t) } };
  await s.emit("message_end", msg(0.4), ctx);
  const saved = JSON.parse(await fs.readFile(path.join(root, ".pi/metrics/M-2.json"), "utf8"));
  assert.equal(saved.phases.implementing.cost, 0.4);
  const fresh = await loadMetrics(root, "M-2");
  assert.equal(fresh!.phases.implementing.input, 100);

  await s.fire(TASK_DONE_EVENT, { root, task: { id: "M-2", title: "T", status: "done", allowedExtra: [], startedAt: "", plan: { summary: "", steps: [], files: [], decisions: [] } } });
  const record = JSON.parse((await fs.readFile(path.join(root, ".pi/memory/tasks.jsonl"), "utf8")).trim());
  assert.equal(record.metrics.phases.implementing.cost, 0.4);

  await s.commands.get("metrics").handler("", ctx);
  assert.match(notes[0], /M-2/);
  assert.match(notes[0], /Mean cost per task: \$0\.400/);
});

test("/metrics without data", async () => {
  const root = await tempProject({});
  const s = setup();
  const notes: string[] = [];
  await s.commands.get("metrics").handler("", { cwd: root, ui: { notify: (t: string) => notes.push(t) } });
  assert.match(notes[0], /No metrics/);
});

test("/metrics shows skipped reviews as · and the savings line", async () => {
  const mk = (id: string, reviews: object[]) => JSON.stringify({ id, metrics: { phases: {}, verifyFailures: 0, reviews } });
  const root = await tempProject({
    ".pi/memory/tasks.jsonl": [mk("A", [{ status: "approved", model: "m", seconds: 1, cost: 0.4 }]), mk("B", [{ status: "skipped-low-risk", model: "m", seconds: 0 }]), mk("C", [{ status: "skipped-low-risk", model: "m", seconds: 0 }]), mk("D", [{ status: "not-requested", model: "m", seconds: 0 }])].join("\n"),
  });
  const report = await metricsReport(root);
  assert.match(report, /^D\s.*review: ·$/m);
  assert.match(report, /^B\s.*review: ·$/m);
  assert.match(report, /Reviews avoided: 2 \(≈ \$0\.80 saved\)/);
});
