import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { TASK_DONE_EVENT, UNDERSTANDING_EVENT } from "../src/events.ts";
import { APPROACH_FIRST, taskPrompt } from "../src/task-prompt.ts";
import { skillsDir } from "../src/skills.ts";
import { readTask } from "../src/task-state.ts";
import { registerUnderstanding } from "../src/understanding.ts";
import { treeSnapshot } from "../src/gate.ts";
import { fakePi, tempProject } from "./helpers.ts";

const taskJson = (extra: object = {}) => JSON.stringify({ id: "U-1", title: "T", status: "implementing", allowedExtra: [], startedAt: "", ...extra });

// The fake git prints `diff` for `git diff`: the tree the check was asked on, unless a test changes it.
function setup(diff = "v1") {
  const f = fakePi((cmd, args) => ({ code: 0, stdout: cmd === "git" && args[0] === "diff" ? diff : "" }));
  const emitted: [string, any][] = [];
  f.pi.events = { emit: (name: string, data: any) => void emitted.push([name, data]), on: () => {} };
  registerUnderstanding(f.pi);
  const done = (input: object, root: string) => f.tools.get("understanding_done").execute("1", input, undefined, undefined, { cwd: root, hasUI: true, ui: { notify: () => {} } });
  return { emitted, done, tree: () => treeSnapshot(f.pi, "/") };
}
const asked = async () => ({ understanding: { tree: await setup().tree() } });

test("understanding_done records the outcome and the number of gaps, then completes the task", async () => {
  const root = await tempProject({ ".pi/task.json": taskJson(await asked()) });
  const { emitted, done } = setup();
  await done({ skipped: false, gaps: ["thinks the retry is unbounded"] }, root);
  assert.deepEqual(emitted.map(([name]) => name), [UNDERSTANDING_EVENT, TASK_DONE_EVENT]);
  assert.deepEqual(emitted[0][1], { root, outcome: "done", gaps: 1 });
  assert.equal((await readTask(root))?.status, "done");
});

test("a skipped check is recorded as skipped with no gaps", async () => {
  const root = await tempProject({ ".pi/task.json": taskJson(await asked()) });
  const { emitted, done } = setup();
  await done({ skipped: true, gaps: ["ignored"] }, root);
  assert.deepEqual(emitted[0][1], { root, outcome: "skipped", gaps: 0 });
});

test("understanding_done refuses when the gate did not ask for a check, and leaves the task open", async () => {
  for (const extra of [{}, { status: "planning", ...(await asked()) }]) {
    const root = await tempProject({ ".pi/task.json": taskJson(extra) });
    const { emitted, done } = setup();
    await assert.rejects(done({ skipped: false, gaps: [] }, root), /No understanding check is pending/);
    assert.equal(emitted.length, 0);
    assert.notEqual((await readTask(root))?.status, "done");
  }
});

test("code changed since the gate verified it is not closed: the task stays open until verify runs on it", async () => {
  const root = await tempProject({ ".pi/task.json": taskJson(await asked()) });
  const { emitted, done } = setup("v2");
  await assert.rejects(done({ skipped: false, gaps: [] }, root), /code changed during the check/);
  assert.equal(emitted.length, 0);
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
