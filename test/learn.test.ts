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

/** registerLearn with a UI session started: `emit` finishes a task, `retro` runs /retro, `notes` holds the notices. */
async function withUI(root: string, exec?: Parameters<typeof fakePi>[0]) {
  const f = fakePi(exec);
  const listeners = new Map<string, (d: unknown) => unknown>();
  f.pi.events = { on: (name: string, fn: any) => listeners.set(name, fn) };
  registerLearn(f.pi);
  const notes: [string, string?][] = [];
  const delivered: unknown[] = [];
  const send = f.pi.sendUserMessage;
  f.pi.sendUserMessage = (text: string, opts?: unknown) => (delivered.push(opts), send(text));
  const state = { idle: true };
  const ctx = { cwd: root, hasUI: true, isIdle: () => state.idle, ui: { notify: (m: string, t?: string) => notes.push([m, t]) } };
  await f.emit("session_start", {}, ctx);
  const emit = (i: number, hasUI = true) => listeners.get(TASK_DONE_EVENT)!({ root, hasUI, task: task(`T-${i}`, "T", "S", ["a.ts"]) });
  const retro = (args = "") => f.commands.get("retro").handler(args, ctx);
  return { ...f, notes, emit, retro, delivered, state };
}

test("every 5th record shows a /retro reminder, only with UI, and never starts a turn by itself", async () => {
  const f = await withUI(await tempProject({}), () => ({ code: 0 }));
  for (let i = 1; i <= 4; i++) await f.emit(i);
  assert.equal(f.notes.length, 0);
  await f.emit(5);
  assert.deepEqual(f.notes, [["5 tasks finished. Run /retro to review the last 5.", "info"]]);
  await f.emit(6);
  for (let i = 7; i <= 10; i++) await f.emit(i, false);
  assert.equal(f.notes.length, 1);
  assert.equal(f.sent.length, 0);
});

test("/retro sends the retro prompt over the last retroEvery tasks, or the count asked for", async () => {
  const f = await withUI(await tempProject({}), () => ({ code: 0 }));
  await f.retro();
  assert.match(f.notes[0][0], /No finished tasks .* yet\. Finish one with \/task, then run \/retro\./);
  assert.equal(f.sent.length, 0);
  for (let i = 1; i <= 7; i++) await f.emit(i);
  await f.retro();
  assert.match(f.sent[0], /Retro: review the last 5 completed tasks[\s\S]*ask_user[\s\S]*Never write them without/);
  assert.doesNotMatch(f.sent[0].slice(f.sent[0].indexOf("Retro:")), /verification skill/);
  await f.retro("3");
  assert.match(f.sent[1], /Retro: review the last 3 completed tasks/);
  await f.retro("50");
  assert.match(f.sent[2], /Retro: review the last 7 completed tasks/);
});

test("/retro right after a task closes waits for its record, and during a run it queues after the run", async () => {
  const f = await withUI(await tempProject({}), () => ({ code: 0 }));
  void f.emit(1); // the gate does not await its listeners
  await f.retro();
  assert.match(f.sent[0], /Retro: review the last 1 completed tasks/);
  f.state.idle = false;
  await f.retro();
  assert.deepEqual(f.delivered, [undefined, { deliverAs: "followUp" }]);
  assert.deepEqual(f.notes.at(-1), ["The retro starts when the current run ends.", "info"]);
});

test("a task that cannot be saved tells the user, with UI", async () => {
  const root = await tempProject({ ".pi/memory": "a file, not a folder" });
  const f = await withUI(root, () => ({ code: 0 }));
  const quiet = console.error;
  console.error = () => {};
  await f.emit(1);
  console.error = quiet;
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0][0], /^The task was not saved to \.pi\/memory\/tasks\.jsonl \(.+\), so future plans will not see it\.$/);
  assert.equal(f.notes[0][1], "warning");
});

const SYNC = "a".repeat(40);
const covered = (extra: object = {}) => ({ ".pi/skills/verify-app/features/coverage.json": JSON.stringify({ sync: SYNC, paths: ["src/", "lib/x.ts"], ...extra }) });

async function retroWith(files: Record<string, string>, log: string, known = true, head = "") {
  const root = await tempProject(files);
  const logs: string[][] = [];
  const f = await withUI(root, (_cmd, args) => (args[0] === "log" && logs.push(args), { code: args[0] === "cat-file" && !known ? 128 : 0, stdout: args[0] === "log" ? log : args[0] === "rev-parse" ? head : "" }));
  for (let i = 1; i <= 5; i++) await f.emit(i);
  await f.retro();
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
  const f = await withUI(await tempProject(covered()), (_cmd, args) => ({ code: 0, stdout: args[0] === "diff" ? "src/a.ts\0" : args[0] === "ls-files" ? "src/new.ts\0" : "" }));
  for (let i = 1; i <= 5; i++) await f.emit(i);
  await f.retro();
  const retro = f.sent[0].slice(f.sent[0].indexOf("Retro:"));
  assert.match(retro, /verification skill covers changed[\s\S]*Not committed yet:\n- src\/a\.ts\n- src\/new\.ts[\s\S]*ask_user/);
  assert.match(retro, /Only messages from the user are corrections[\s\S]*contract-gate, verify-gate/);
});
