import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { TASK_DONE_EVENT, registerLearn, relatedTasks } from "../src/learn.ts";
import { fakePi, tempProject } from "./helpers.ts";

function setup(exec?: Parameters<typeof fakePi>[0]) {
  const f = fakePi(exec);
  const listeners = new Map<string, (d: unknown) => unknown>();
  f.pi.events = { on: (name: string, fn: any) => listeners.set(name, fn) };
  registerLearn(f.pi);
  return (payload: unknown) => listeners.get(TASK_DONE_EVENT)!(payload);
}

const task = (id: string, title: string, summary: string, files: string[], answer?: string): any => ({
  id, title, ticket: id, status: "done", allowedExtra: [], startedAt: "", completedAt: "2026-10-20T10:00:00Z",
  plan: { summary, steps: [], files, decisions: answer ? [{ id: "d", question: "Rounding mode?", options: [], status: "decided", answer }] : [] },
});

test("appends a record using git output and ranks related tasks", async () => {
  const root = await tempProject({});
  // AGENTS.md changed too, but it is outside the task's plan, so the record leaves it out.
  const emit = setup((cmd, args) => ({ code: 0, stdout: args.includes("diff") ? "src/pay.ts\nAGENTS.md\n" : "?? src/new.ts\n M src/pay.ts\n" }));
  await emit({ root, task: task("PAY-142", "Fix rounding", "Corrige redondeo de pagos", ["src/"], "half-even") });
  await emit({ root, task: task("UI-7", "Botón de login", "Cambia estilos", ["login.css"]) });
  const lines = (await fs.readFile(path.join(root, ".pi/memory/tasks.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]).files, ["src/pay.ts", "src/new.ts"]);
  const [top] = await relatedTasks(root, "REDONDEÓ pagos");
  assert.match(top, /^\[PAY-142\] Fix rounding \(2026-10-20\)/);
  assert.match(top, /Rounding mode\? → half-even/);
  assert.ok(top.length <= 400);
  assert.equal((await relatedTasks(root, "zzz")).length, 0);
});

test("falls back to plan files and swallows errors", async () => {
  const root = await tempProject({});
  const emit = setup(() => ({ code: 128 }));
  await emit({ root, task: task("A-1", "T", "S", ["a.ts"]) });
  assert.match(await fs.readFile(path.join(root, ".pi/memory/tasks.jsonl"), "utf8"), /"files":\["a.ts"\]/);
  const quiet = console.error;
  console.error = () => {};
  await assert.doesNotReject(async () => emit({ root: undefined, task: undefined }));
  console.error = quiet;
});

test("empty store returns []", async () => {
  assert.deepEqual(await relatedTasks(await tempProject({}), "anything"), []);
});
