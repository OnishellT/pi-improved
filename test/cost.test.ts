import assert from "node:assert/strict";
import { test } from "node:test";
import { REVIEW_EVENT } from "../src/events.ts";
import { registerTelemetry, costReport } from "../src/telemetry.ts";
import { fakePi, tempProject } from "./helpers.ts";

const taskJson = (id: string, status: string) => JSON.stringify({ id, title: "T", status, allowedExtra: [], startedAt: "" });
const msg = (cost: number): any => ({ type: "message_end", message: { role: "assistant", usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, cost: { total: cost } } } });

test("/cost shows the active task's phases, total and last risk level", async () => {
  const root = await tempProject({ ".pi/task.json": taskJson("C-1", "implementing") });
  assert.match(await costReport(root), /nothing recorded/);
  const f = fakePi();
  const listeners = new Map<string, (d: unknown) => unknown>();
  f.pi.events = { on: (name: string, fn: any) => listeners.set(name, fn) };
  registerTelemetry(f.pi);
  assert.ok(f.commands.has("cost"));
  await f.emit("message_end", msg(0.5), { cwd: root, ui: { notify: () => {} } });
  assert.match(await costReport(root), /not assessed yet/);
  await listeners.get(REVIEW_EVENT)!({ root, status: "skipped-low-risk", model: "x", seconds: 0, cost: 0 });
  const report = await costReport(root);
  assert.match(report, /C-1: phase implementing/);
  assert.match(report, /implementing\s+\$\s*0\.500/);
  assert.match(report, /Total \$0\.500 \| last risk: low/);
  assert.match(await costReport(await tempProject({})), /No active task/);
});

test("/cost names the last review's status instead of calling every review high risk", async () => {
  const root = await tempProject({ ".pi/task.json": taskJson("C-2", "implementing") });
  const f = fakePi();
  const listeners = new Map<string, (d: unknown) => unknown>();
  f.pi.events = { on: (name: string, fn: any) => listeners.set(name, fn) };
  registerTelemetry(f.pi);
  await listeners.get(REVIEW_EVENT)!({ root, status: "skipped", model: "x", seconds: 0 });
  assert.match(await costReport(root), /last risk: review skipped \|/);
  await listeners.get(REVIEW_EVENT)!({ root, status: "approved", model: "x", seconds: 1, cost: 0.1 });
  assert.match(await costReport(root), /last risk: review approved \|/);
});
