import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { TASK_DONE_EVENT } from "../src/events.ts";
import { registerLearn, relatedTasks } from "../src/learn.ts";
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
  plan: { summary, steps: [], files, interface: [], seams: [], decisions: answer ? [{ id: "d", question: "Rounding mode?", options: [], status: "decided", answer }] : [] },
});

test("appends a record using git output and ranks related tasks", async () => {
  const root = await tempProject({});
  // AGENTS.md changed too, but it is outside the task's plan, so the record leaves it out.
  const emit = setup((cmd, args) => ({ code: 0, stdout: args[0] === "diff" ? "src/pay.ts\0AGENTS.md\0.pi/task.json\0" : args[0] === "ls-files" ? "src/new.ts\0" : "" }));
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

test("sends the retro prompt on every 5th record, only with UI", async () => {
  const root = await tempProject({});
  const f = fakePi(() => ({ code: 0 }));
  const listeners = new Map<string, (d: unknown) => unknown>();
  f.pi.events = { on: (name: string, fn: any) => listeners.set(name, fn) };
  registerLearn(f.pi);
  const emit = (i: number, hasUI = true) => listeners.get(TASK_DONE_EVENT)!({ root, hasUI, task: task(`T-${i}`, "T", "S", ["a.ts"]) });
  for (let i = 1; i <= 4; i++) await emit(i);
  assert.equal(f.sent.length, 0);
  await emit(5);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /Retro: 5 tasks[\s\S]*ask_user[\s\S]*Never write them without/);
  assert.doesNotMatch(f.sent[0].slice(f.sent[0].indexOf("Retro:")), /verification skill/);
  await emit(6);
  assert.equal(f.sent.length, 1);
  for (let i = 7; i <= 10; i++) await emit(i, false);
  assert.equal(f.sent.length, 1);
});

const SYNC = "a".repeat(40);
const covered = (extra: object = {}) => ({ ".pi/skills/verify-app/features/coverage.json": JSON.stringify({ sync: SYNC, paths: ["src/", "lib/x.ts"], ...extra }) });

async function retroWith(files: Record<string, string>, log: string, known = true, head = "") {
  const root = await tempProject(files);
  const logs: string[][] = [];
  const f = fakePi((_cmd, args) => (args[0] === "log" && logs.push(args), { code: args[0] === "cat-file" && !known ? 128 : 0, stdout: args[0] === "log" ? log : args[0] === "rev-parse" ? head : "" }));
  const listeners = new Map<string, (d: unknown) => unknown>();
  f.pi.events = { on: (name: string, fn: any) => listeners.set(name, fn) };
  registerLearn(f.pi);
  for (let i = 1; i <= 5; i++) await listeners.get(TASK_DONE_EVENT)!({ root, hasUI: true, task: task(`T-${i}`, "T", "S", ["a.ts"]) });
  return { sent: f.sent, logs };
}

test("retro asks to update the verification skill, naming the commits, only when covered code changed", async () => {
  const { sent, logs } = await retroWith(covered(), "abc1234 Rename the search box\ndef5678 Add export\n");
  assert.deepEqual(logs[0].slice(logs[0].indexOf(`${SYNC}..HEAD`)), [`${SYNC}..HEAD`, "--", "src/", "lib/x.ts"]);
  assert.match(sent[0].slice(sent[0].indexOf("Retro:")), /verification skill covers changed[\s\S]*- abc1234 Rename the search box\n- def5678 Add export[\s\S]*ask_user[\s\S]*pstack-maintain-verification-skill[\s\S]*coverage\.json to the output of `git rev-parse HEAD`/);
});

test("retro says the sync commit is gone and asks to refresh coverage, instead of staying silent", async () => {
  const { sent, logs } = await retroWith(covered(), "abc1234 x\n", false);
  const retro = sent[0].slice(sent[0].indexOf("Retro:"));
  assert.match(retro, new RegExp(`sync commit ${SYNC} no longer exists[\\s\\S]*ask_user[\\s\\S]*refresh the skill's coverage[\\s\\S]*git rev-parse HEAD`));
  assert.equal(logs.length, 0);
});

test("retro asks for a first sync when the skill was set up before the first commit", async () => {
  const { sent } = await retroWith(covered({ sync: "" }), "", true, "abc1234\n");
  assert.match(sent[0].slice(sent[0].indexOf("Retro:")), /never synced[\s\S]*ask_user[\s\S]*git rev-parse HEAD/);
});

test("the record keeps the plan's intent, and has none for an old plan", async () => {
  const root = await tempProject({});
  const emit = setup();
  const t = task("A-1", "T", "S", ["a.ts"]);
  await emit({ root, task: { ...t, plan: { ...t.plan, intent: "Charge a fee on each payment" } } });
  await emit({ root, task: task("A-2", "T", "S", ["a.ts"]) });
  const [a, b] = (await fs.readFile(path.join(root, ".pi/memory/tasks.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(a.intent, "Charge a fee on each payment");
  assert.equal("intent" in b, false);
});

test("retro leaves the verification skill alone with no covered change, no record or a malformed one", async () => {
  for (const [files, log] of [[covered(), ""], [{}, "abc1234 x\n"], [covered({ sync: "nope" }), "abc1234 x\n"], [covered({ paths: [] }), "abc1234 x\n"]] as const) {
    const { sent } = await retroWith(files, log);
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0].slice(sent[0].indexOf("Retro:")), /verification skill/);
  }
});

test("changed files are measured against the task's base commit, not HEAD", async () => {
  const root = await tempProject({});
  const hash = "d".repeat(40);
  const diffs: string[][] = [];
  const emit = setup((_cmd, args) => (args[0] === "diff" && diffs.push(args), { code: 0, stdout: args[0] === "rev-parse" ? hash : args[0] === "diff" ? "src/a.ts\0" : "" }));
  await emit({ root, task: { ...task("B-1", "T", "S", ["src/"]), baseCommit: hash } });
  assert.ok(diffs[0].includes(hash) && diffs[0].includes("-z"));
});

test("retro lists covered code that is changed but not committed yet, and says only user messages are corrections", async () => {
  const root = await tempProject(covered());
  const f = fakePi((_cmd, args) => ({ code: 0, stdout: args[0] === "diff" ? "src/a.ts\0" : args[0] === "ls-files" ? "src/new.ts\0" : "" }));
  const listeners = new Map<string, (d: unknown) => unknown>();
  f.pi.events = { on: (name: string, fn: any) => listeners.set(name, fn) };
  registerLearn(f.pi);
  for (let i = 1; i <= 5; i++) await listeners.get(TASK_DONE_EVENT)!({ root, hasUI: true, task: task(`T-${i}`, "T", "S", ["a.ts"]) });
  const retro = f.sent[0].slice(f.sent[0].indexOf("Retro:"));
  assert.match(retro, /verification skill covers changed[\s\S]*Not committed yet:\n- src\/a\.ts\n- src\/new\.ts[\s\S]*ask_user/);
  assert.match(retro, /Only messages from the user are corrections[\s\S]*contract-gate, verify-gate/);
});
