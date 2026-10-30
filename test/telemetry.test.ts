import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as fsCallbacks from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { ESCALATE_EVENT, REVIEW_EVENT, VERIFY_EVENT } from "../src/events.ts";
import { TASK_DONE_EVENT } from "../src/events.ts";
import { registerLearn } from "../src/learn.ts";
import { loadMetrics, metricsReport, recordUnderstanding, registerTelemetry, taskMetrics } from "../src/telemetry.ts";
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

test("progress and premise runs are recorded apart from the final verifies", async () => {
  const root = await tempProject({ ".pi/task.json": taskJson("M-3", "implementing") });
  const s = setup();
  await s.fire(VERIFY_EVENT, { root, kind: "progress", ok: false, seconds: 1 });
  await s.fire(VERIFY_EVENT, { root, kind: "progress", ok: true, seconds: 1 });
  await s.fire(VERIFY_EVENT, { root, kind: "gate", ok: false, seconds: 2, premise: true });
  await s.fire(VERIFY_EVENT, { root, kind: "gate", ok: false, seconds: 2, premise: false });
  const m = taskMetrics("M-3")!;
  assert.deepEqual(m.progress, { runs: 2, failures: 1 });
  assert.deepEqual([m.verifyRuns, m.verifyFailures, m.premises], [2, 2, 1]);
});

test("task and metrics files from before the baseline was removed still load, and /cost and /metrics report them", async () => {
  const old = { phases: { implementing: { input: 1, output: 1, cacheRead: 0, cost: 0.2, seconds: 3 } }, verifyRuns: 2, verifyFailures: 0, predated: 1, premises: 0, baseline: { ok: false, seconds: 40 }, progress: { runs: 0, failures: 0 }, reviews: [], escalations: 0 };
  const task = { ...JSON.parse(taskJson("M-old", "implementing")), baseline: { ok: false, seconds: 40, failing: [{ step: "t", lines: ["FAIL x"] }] }, predates: ["FAIL x"] };
  const root = await tempProject({
    ".pi/task.json": JSON.stringify(task),
    ".pi/metrics/M-old.json": JSON.stringify(old),
    ".pi/memory/tasks.jsonl": `${JSON.stringify({ id: "M-old2", title: "T", completedAt: "2026-10-01T00:00:00Z", metrics: old })}\n`,
  });
  const s = setup();
  const notes: string[] = [];
  const ctx = { cwd: root, ui: { notify: (t: string) => notes.push(t) } };
  await s.commands.get("cost").handler("", ctx);
  await s.commands.get("metrics").handler("", ctx);
  assert.match(notes[0], /\$0\.200/);
  assert.match(notes[1], /M-old2/);
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

test("/metrics leaves plan checks out of the review column, not out of the cost", async () => {
  const mk = (id: string, reviews: object[]) => JSON.stringify({ id, metrics: { phases: {}, verifyFailures: 0, reviews } });
  const root = await tempProject({ ".pi/memory/tasks.jsonl": mk("A", [{ status: "plan-ok", model: "m", seconds: 1, cost: 0.1 }, { status: "approved", model: "m", seconds: 1, cost: 0.4 }]) });
  assert.match(await metricsReport(root), /^A\s+\$  0\.500 .*review: approved$/m);
});

test("a review and the understanding outcome recorded at once, after a restart, both reach the task's metrics", async () => {
  const snapshot = JSON.stringify({ phases: {}, verifyRuns: 1, verifyFailures: 0, premises: 0, progress: { runs: 0, failures: 0 }, reviews: [], escalations: 0 });
  const root = await tempProject({ ".pi/task.json": taskJson("COLD-1", "implementing"), ".pi/metrics/COLD-1.json": snapshot });
  const s = setup();
  // As in the gate: the review listener starts, unawaited, then the outcome is awaited.
  const review = s.fire(REVIEW_EVENT, { root, status: "skipped", model: "m", seconds: 0 });
  await recordUnderstanding(root, "no-ui", 0);
  await review;
  const m = taskMetrics("COLD-1")!;
  assert.deepEqual([m.verifyRuns, m.reviews.length, m.understanding], [1, 1, { outcome: "no-ui", gaps: 0 }]);
  const disk = JSON.parse(await fs.readFile(path.join(root, ".pi/metrics/COLD-1.json"), "utf8"));
  assert.deepEqual([disk.reviews.length, disk.understanding], [1, { outcome: "no-ui", gaps: 0 }]);
});

test("a slow earlier snapshot save never lands over a later one", async () => {
  const root = await tempProject({ ".pi/task.json": taskJson("SLOW-1", "implementing") });
  const s = setup();
  // The first snapshot write (the review alone) takes longer than the next (review + outcome).
  const real = fsCallbacks.promises.writeFile;
  let calls = 0;
  let started!: () => void;
  const firstWrite = new Promise<void>((r) => (started = r));
  fsCallbacks.promises.writeFile = (async (...args: any[]) => {
    if (calls++ === 0) {
      started();
      await new Promise((r) => setTimeout(r, 50));
    }
    return (real as any)(...args);
  }) as any;
  syncBuiltinESMExports();
  try {
    const review = s.fire(REVIEW_EVENT, { root, status: "skipped", model: "m", seconds: 0 });
    await firstWrite;
    await recordUnderstanding(root, "done", 3);
    await review;
  } finally {
    fsCallbacks.promises.writeFile = real;
    syncBuiltinESMExports();
  }
  const disk = JSON.parse(await fs.readFile(path.join(root, ".pi/metrics/SLOW-1.json"), "utf8"));
  assert.deepEqual([disk.reviews.length, disk.understanding], [1, { outcome: "done", gaps: 3 }]);
});

test("the understanding outcome and its gap count are kept per task, and /metrics shows the rates", async () => {
  const root = await tempProject({ ".pi/task.json": taskJson("U-1", "implementing") });
  await recordUnderstanding(root, "done", 2);
  assert.deepEqual(taskMetrics("U-1")!.understanding, { outcome: "done", gaps: 2 });
  const mk = (id: string, understanding?: object) => JSON.stringify({ id, metrics: { phases: {}, verifyFailures: 0, reviews: [], ...(understanding && { understanding }) } });
  const memory = [mk("A", { outcome: "done", gaps: 2 }), mk("B", { outcome: "done", gaps: 1 }), mk("C", { outcome: "skipped", gaps: 0 }), mk("D", { outcome: "no-ui", gaps: 0 }), mk("E")].join("\n");
  const report = await metricsReport(await tempProject({ ".pi/memory/tasks.jsonl": memory }));
  assert.match(report, /^Understanding \(4 tasks\): done 50%, skipped 25%, no-ui 25%, off 0%, 1\.5 gaps per answered check$/m);
  assert.doesNotMatch(await metricsReport(await tempProject({ ".pi/memory/tasks.jsonl": mk("E") })), /Understanding/);
});
