import assert from "node:assert/strict";
import { test } from "node:test";
import { TASK_DONE_EVENT, UNDERSTANDING_EVENT } from "../src/events.ts";
import { APPROACH_FIRST, taskPrompt } from "../src/task-prompt.ts";
import { readTask } from "../src/task-state.ts";
import { registerUnderstanding } from "../src/understanding.ts";
import { fakePi, tempProject } from "./helpers.ts";

const taskJson = (extra: object = {}) => JSON.stringify({ id: "U-1", title: "T", status: "implementing", allowedExtra: [], startedAt: "", ...extra });

function setup() {
  const f = fakePi();
  const emitted: [string, any][] = [];
  f.pi.events = { emit: (name: string, data: any) => void emitted.push([name, data]), on: () => {} };
  registerUnderstanding(f.pi);
  const done = (input: object, root: string) => f.tools.get("understanding_done").execute("1", input, undefined, undefined, { cwd: root, hasUI: true, ui: { notify: () => {} } });
  return { emitted, done };
}

test("understanding_done records the outcome and the number of gaps, then completes the task", async () => {
  const root = await tempProject({ ".pi/task.json": taskJson({ understanding: "asked" }) });
  const { emitted, done } = setup();
  await done({ skipped: false, gaps: ["thinks the retry is unbounded"] }, root);
  assert.deepEqual(emitted.map(([name]) => name), [UNDERSTANDING_EVENT, TASK_DONE_EVENT]);
  assert.deepEqual(emitted[0][1], { root, outcome: "done", gaps: 1 });
  assert.equal((await readTask(root))?.status, "done");
});

test("a skipped check is recorded as skipped with no gaps", async () => {
  const root = await tempProject({ ".pi/task.json": taskJson({ understanding: "asked" }) });
  const { emitted, done } = setup();
  await done({ skipped: true, gaps: ["ignored"] }, root);
  assert.deepEqual(emitted[0][1], { root, outcome: "skipped", gaps: 0 });
});

test("understanding_done refuses when the gate did not ask for a check, and leaves the task open", async () => {
  for (const extra of [{}, { status: "planning", understanding: "asked" }]) {
    const root = await tempProject({ ".pi/task.json": taskJson(extra) });
    const { emitted, done } = setup();
    await assert.rejects(done({ skipped: false, gaps: [] }, root), /No understanding check is pending/);
    assert.equal(emitted.length, 0);
    assert.notEqual((await readTask(root))?.status, "done");
  }
});

test("the planning prompt asks for the user's approach first only when told to", () => {
  assert.ok(taskPrompt("T", undefined, undefined, [], "", [], undefined, true).includes(APPROACH_FIRST));
  assert.ok(!taskPrompt("T", undefined, undefined, []).includes(APPROACH_FIRST));
});
