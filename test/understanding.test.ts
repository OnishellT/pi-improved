import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { TASK_DONE_EVENT } from "../src/events.ts";
import { registerLearn } from "../src/learn.ts";
import { METRICS_DIR, taskMetrics } from "../src/telemetry.ts";
import { APPROACH_FIRST, taskPrompt } from "../src/task-prompt.ts";
import { skillsDir } from "../src/skills.ts";
import { readMemory, readTask } from "../src/task-state.ts";
import { registerUnderstanding } from "../src/understanding.ts";
import { treeSnapshot, UNREADABLE } from "../src/gate.ts";
import { fakePi, tempProject } from "./helpers.ts";

// A fresh id per task: telemetry keeps metrics in memory by task id across tests.
let ids = 0;
const taskJson = (extra: object = {}) => JSON.stringify({ id: `U-${++ids}`, title: "T", status: "implementing", allowedExtra: [], startedAt: "", ...extra });

// The fake git prints `diff` for `git diff`: the tree the check was asked on, unless a test changes it.
function setup(diff = "v1", gitWorks = true) {
  const f = fakePi((cmd, args) => (gitWorks ? { code: 0, stdout: cmd === "git" && args[0] === "diff" ? diff : "" } : { code: 128, stderr: "not a git repository" }));
  const emitted: string[] = [];
  const listeners = new Map<string, (d: unknown) => unknown>();
  const running: unknown[] = [];
  // Like pi's bus: listeners start at once and are not awaited by the emitter.
  const atDone: unknown[] = [];
  f.pi.events = {
    emit: (name: string, data: any) => {
      emitted.push(name);
      // What the memory record can see at the moment the task is done.
      if (name === TASK_DONE_EVENT) atDone.push(structuredClone(taskMetrics(data.task.id)?.understanding));
      running.push(listeners.get(name)?.(data));
    },
    on: (name: string, fn: any) => listeners.set(name, fn),
  };
  registerUnderstanding(f.pi);
  registerLearn(f.pi);
  const done = (input: object, root: string) => f.tools.get("understanding_done").execute("1", input, undefined, undefined, { cwd: root, hasUI: true, ui: { notify: () => {} } });
  return { emitted, done, tree: () => treeSnapshot(f.pi, "/"), settled: () => Promise.all(running), atDone };
}
/** The outcome persisted for the task in `root`, as /metrics and the memory record read it. */
async function recorded(root: string) {
  const id = JSON.parse(await fs.readFile(path.join(root, ".pi/task.json"), "utf8")).id;
  return JSON.parse(await fs.readFile(path.join(root, METRICS_DIR, `${id}.json`), "utf8").catch(() => "{}")).understanding;
}
const asked = async () => ({ understanding: { tree: await setup().tree() } });

test("understanding_done records the outcome and the number of gaps, then completes the task with them in its memory record", async () => {
  const root = await tempProject({ ".pi/task.json": taskJson(await asked()) });
  const { emitted, done, settled, atDone } = setup();
  await done({ skipped: false, gaps: ["thinks the retry is unbounded"] }, root);
  assert.deepEqual(emitted, [TASK_DONE_EVENT]);
  assert.deepEqual(atDone, [{ outcome: "done", gaps: 1 }], "kept before the task is done, not by a pending write");
  assert.equal((await readTask(root))?.status, "done");
  await settled();
  const [record] = (await readMemory(root)) as any[];
  assert.deepEqual(record.metrics.understanding, { outcome: "done", gaps: 1 });
});

test("a skipped check is recorded as skipped with no gaps", async () => {
  const root = await tempProject({ ".pi/task.json": taskJson(await asked()) });
  const { done } = setup();
  await done({ skipped: true, gaps: ["ignored"] }, root);
  assert.deepEqual(await recorded(root), { outcome: "skipped", gaps: 0 });
});

test("understanding_done refuses when the gate did not ask for a check, and leaves the task open", async () => {
  for (const extra of [{}, { status: "planning", ...(await asked()) }]) {
    const root = await tempProject({ ".pi/task.json": taskJson(extra) });
    const { emitted, done } = setup();
    await assert.rejects(done({ skipped: false, gaps: [] }, root), /No understanding check is pending/);
    assert.equal(emitted.length, 0);
  assert.equal(await recorded(root), undefined);
    assert.equal(await recorded(root), undefined);
    assert.notEqual((await readTask(root))?.status, "done");
  }
});

test("code changed since the gate verified it is not closed: the task stays open until verify runs on it", async () => {
  const root = await tempProject({ ".pi/task.json": taskJson(await asked()) });
  const { emitted, done } = setup("v2");
  await assert.rejects(done({ skipped: false, gaps: [] }, root), /code changed during the check/);
  assert.equal(emitted.length, 0);
  assert.equal(await recorded(root), undefined);
  assert.equal((await readTask(root))?.status, "implementing");
});

test("a tree git cannot read is never taken as the verified one", async () => {
  const root = await tempProject({ ".pi/task.json": taskJson({ understanding: { tree: UNREADABLE } }) });
  const { emitted, done } = setup("v1", false);
  await assert.rejects(done({ skipped: false, gaps: [] }, root), /git could not read/);
  assert.equal(emitted.length, 0);
  assert.equal(await recorded(root), undefined);
  assert.equal((await readTask(root))?.status, "implementing");
});

test("the planning prompt asks for the user's approach first only when told to", () => {
  assert.ok(taskPrompt("T", undefined, undefined, [], "", [], undefined, true).includes(APPROACH_FIRST));
  assert.ok(!taskPrompt("T", undefined, undefined, []).includes(APPROACH_FIRST));
});

test("the check skill reads new untracked files too, not only git diff", async () => {
  const skill = await fs.readFile(path.join(skillsDir(), "understanding-check", "SKILL.md"), "utf8");
  assert.match(skill, /untracked/);
});
