import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { updateManifest } from "../src/manifest.ts";
import { readTask, writeTask } from "../src/task-state.ts";
import { registerTask } from "../src/task.ts";
import { fakePi, fakeUI, isSubagent, tempProject } from "./helpers.ts";

const plan = (decisions: any[] = [], extra: any = {}) => ({
  summary: "Add fee",
  steps: ["edit"],
  files: ["src/fee.ts", "test/fee.test.ts"],
  decisions,
  interface: [{ file: "src/fee.ts", exports: ["fee"], source: "ticket" }],
  seams: [{ name: "fee calc", testFile: "test/fee.test.ts", catches: "rounding" }],
  ...extra,
});

async function setup(done = true) {
  const root = await tempProject({ "docs/adr/0001-money.md": "# money\n", "src/money.ts": "export const m = 1;\n" });
  if (done) await updateManifest(root, (m) => void (m.setup = "done"));
  const h = fakePi();
  registerTask(h.pi);
  const ctxFor = (answers: unknown[]) => {
    const ui = fakeUI(answers);
    return { ui, ctx: { cwd: root, hasUI: true, ui, waitForIdle: async () => {} } as any };
  };
  return { root, ctxFor, ...h };
}

test("/task requires setup done", async () => {
  const { commands, sent, ctxFor, root } = await setup(false);
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  assert.equal(sent.length, 0);
  assert.equal(await readTask(root), undefined);
});

test("/task creates the task and sends one prompt", async () => {
  const { commands, sent, ctxFor, root } = await setup();
  await commands.get("task").handler("PAY-12", ctxFor([]).ctx);
  const task = await readTask(root);
  assert.equal(task?.status, "planning");
  assert.equal(task?.ticket, "PAY-12");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /task_plan/);
});

test("active task: replace asks, cancel keeps it", async () => {
  const { commands, ctxFor, root } = await setup();
  await commands.get("task").handler("First", ctxFor([]).ctx);
  const first = (await readTask(root))!.id;
  await commands.get("task").handler("Second", ctxFor(["Cancel"]).ctx);
  assert.equal((await readTask(root))!.id, first);
  await commands.get("task").handler("Second", ctxFor(["Replace it"]).ctx);
  assert.equal((await readTask(root))!.title, "Second");
});

test("task_plan with a documented source asks only for approval", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const { ctx, ui } = ctxFor([true]);
  const decisions = [{ question: "Money type?", options: ["cents", "float"], source: "docs/adr/0001-money.md#types" }];
  await tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 1);
  const task = (await readTask(root))!;
  assert.equal(task.status, "implementing");
  assert.equal(task.plan!.decisions[0].status, "documented");
});

test("invalid source is asked and recorded as an ADR", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const { ctx, ui } = ctxFor(["✏️  Other answer…", "basis points", true]);
  const decisions = [{ question: "Fee unit?", options: ["cents", "percent"], source: "docs/missing.md" }];
  await tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 3);
  const d = (await readTask(root))!.plan!.decisions[0];
  assert.equal(d.status, "decided");
  assert.equal(d.answer, "basis points");
  assert.match(await fs.readFile(path.join(root, d.source!), "utf8"), /basis points/);
});

test("cancelled question stops; rejection returns feedback and stays planning", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const run = (answers: unknown[], decisions: any[] = []) => tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, ctxFor(answers).ctx);
  await assert.rejects(run([undefined], [{ question: "Q?", options: ["a", "b"] }]), /not approved/);
  await assert.rejects(run([false, "Smaller steps"]), /Smaller steps/);
  assert.equal((await readTask(root))!.status, "planning");
});

test("task_plan fails without a planning task", async () => {
  const { tools, ctxFor } = await setup();
  await assert.rejects(tools.get("task_plan").execute("1", plan(), undefined, undefined, ctxFor([]).ctx), /No task/);
});

test("nudge is bounded, resets per user message, and skips setup", async () => {
  const { commands, ctxFor, emit, root } = await setup();
  const ctx = ctxFor([]).ctx;
  await commands.get("task").handler("Add fee", ctx);
  const settle = () => emit("agent_before_settle", { outcome: "completed" }, ctx);
  assert.ok(await settle());
  assert.ok(await settle());
  assert.equal(await settle(), undefined);
  await emit("before_agent_start", { messageType: "user" }, ctx);
  assert.ok(await settle());
  await updateManifest(root, (m) => void (m.setup = "running"));
  await emit("before_agent_start", { messageType: "user" }, ctx);
  assert.equal(await settle(), undefined);
  await updateManifest(root, (m) => void (m.setup = "done"));
  await writeTask(root, { ...(await readTask(root))!, status: "implementing" });
  assert.equal(await settle(), undefined);
});

test("prompt lists similar past tasks and the tracker", async () => {
  const { taskPrompt } = await import("../src/task-prompt.ts");
  const text = taskPrompt("PAY-1", "PAY-1", "jira", ["PAY-0: added fees"], "## Skill: x");
  assert.match(text, /Similar past tasks:\n- PAY-0: added fees/);
  assert.match(text, /jira tools/);
  assert.ok(text.startsWith("## Skill: x"));
});

test("a plain-text question while implementing is routed to ask_user; a statement is not", async () => {
  const { root, ctxFor, emit } = await setup();
  await writeTask(root, { id: "t1", title: "x", status: "implementing", allowedExtra: [], startedAt: "now" } as any);
  const { ctx } = ctxFor([]);
  const say = (text: string) => emit("message_end", { message: { role: "assistant", content: [{ type: "text", text }] } }, ctx);
  await say("Done with the calendar.");
  assert.equal(await emit("agent_before_settle", { outcome: "completed" }, ctx), undefined);
  await say("No package.json exists.\nShould I scaffold one?");
  const r = await emit("agent_before_settle", { outcome: "completed" }, ctx);
  assert.equal(r.continue, true);
  assert.match(r.entries[0].content, /ask_user/);
});

test("invented interface names ask the user and write an ADR", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const { ctx, ui } = ctxFor(["Accept the proposed names", true]);
  const result = await tools.get("task_plan").execute("1", plan([], { interface: [{ file: "src/fee.ts", exports: ["fee"], signatures: ["fee(n: number): number"], source: "user" }] }), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 2);
  assert.match(result.content[0].text, /write the tests/);
  const d = (await readTask(root))!.plan!.decisions[0];
  assert.equal(d.status, "decided");
  assert.match(await fs.readFile(path.join(root, d.source!), "utf8"), /Interface for Add fee[\s\S]*fee\(n: number\)/);
});

test("interface from ticket or an existing path is accepted silently", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const { ctx, ui } = ctxFor([true]);
  const iface = [{ file: "src/fee.ts", exports: ["fee"], source: "ticket" }, { file: "src/money.ts", exports: ["m"], source: "src/money.ts#m" }];
  await tools.get("task_plan").execute("1", plan([], { interface: iface }), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 1);
  assert.equal((await readTask(root))!.plan!.decisions.length, 0);
});

test("seam outside files and empty interface with new files are rejected", async () => {
  const { commands, tools, ctxFor } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const run = (extra: any) => tools.get("task_plan").execute("1", plan([], extra), undefined, undefined, ctxFor([true]).ctx);
  await assert.rejects(run({ seams: [{ name: "x", testFile: "test/other.test.ts", catches: "y" }] }), /test\/other\.test\.ts/);
  await assert.rejects(run({ interface: [] }), /interface is empty/);
  await run({ interface: [], files: ["src/money.ts"], seams: [{ name: "m", testFile: "src/money.ts", catches: "x" }] });
});

test("names labelled 'ticket' but absent from the ticket text are asked; names in the title or a spec file pass", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.writeFile(path.join(root, "docs/spec.md"), "# Fees\n\n- `computeTotal(items)` sums the fees\n");
  await commands.get("task").handler("Add fee per docs/spec.md", ctxFor([]).ctx);
  assert.deepEqual((await readTask(root))!.spec, ["docs/spec.md"]);
  // computeTotal is in the spec, fee is in the title: nothing to ask
  const quiet = ctxFor([true]);
  await tools.get("task_plan").execute("1", plan([], { interface: [{ file: "src/fee.ts", exports: ["fee", "computeTotal"], source: "ticket" }] }), undefined, undefined, quiet.ctx);
  assert.equal(quiet.ui.asked.length, 1);
  // parseMicros is nowhere and the new file `micros.ts` is not a ticket noun: the label 'ticket' does not save it
  await commands.get("task").handler("Add fee per docs/spec.md", ctxFor(["Replace it"]).ctx);
  const loud = ctxFor(["Accept the proposed names", true]);
  await tools.get("task_plan").execute("1", plan([], { files: ["src/micros.ts", "test/fee.test.ts"], interface: [{ file: "src/micros.ts", exports: ["parseMicros"], source: "ticket" }] }), undefined, undefined, loud.ctx);
  assert.equal(loud.ui.asked.length, 2);
  assert.match(loud.ui.asked[0], /Proposed names[\s\S]*src\/micros\.ts: parseMicros \(not found in ticket: parseMicros, micros\.ts\)/);
  assert.equal((await readTask(root))!.plan!.decisions[0].status, "decided");
});

test("a cited existing file must contain the names too", async () => {
  const { commands, tools, ctxFor } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const { ctx, ui } = ctxFor(["Accept the proposed names", true]);
  await tools.get("task_plan").execute("1", plan([], { interface: [{ file: "src/money.ts", exports: ["m", "formatUsd"], source: "src/money.ts" }] }), undefined, undefined, ctx);
  assert.match(ui.asked[0], /not found in src\/money\.ts: formatUsd/);
});

test("plan check: FIX sends the findings back once, the retry skips the paid check, OK and disabled proceed", async () => {
  const verdicts: string[] = [];
  const spawns: string[] = [];
  const h = fakePi((cmd, args) => {
    if (!isSubagent(cmd)) return { code: 0 };
    if (args[0] === "spawn") {
      spawns.push(args[args.indexOf("--model") + 1]);
      return { code: 0, stdout: "Spawned plan-check (abc)\n" };
    }
    if (args[0] === "wait") return { code: 0, stdout: `abc finished\n\n${verdicts.shift() ?? "VERDICT: OK"}` };
    return { code: 0 };
  });
  const emitted: any[] = [];
  h.pi.events = { emit: (name: string, payload: any) => emitted.push({ name, payload }) };
  registerTask(h.pi);
  const root = await tempProject({ "src/money.ts": "export const m = 1;\n" });
  await updateManifest(root, (m) => {
    m.setup = "done";
    m.models = { review: "openai/gpt-6-astra" };
  });
  const ctxFor = (answers: unknown[]) => {
    const ui = fakeUI(answers);
    return { ui, ctx: { cwd: root, hasUI: true, ui, waitForIdle: async () => {} } as any };
  };
  await h.commands.get("task").handler("Add fee", ctxFor([]).ctx);
  verdicts.push("VERDICT: FIX\n1. src/fee.ts: siblings use camelCase, call it feeRate");
  await assert.rejects(h.tools.get("task_plan").execute("1", plan(), undefined, undefined, ctxFor([]).ctx), /senior review[\s\S]*call it feeRate/);
  assert.deepEqual(spawns, ["openai/gpt-6-astra"].map(() => "gpt-6-astra"));
  assert.equal(emitted.at(-1).payload.status, "plan-fix");
  // second submission: no second paid check, straight to the user's approval
  await h.tools.get("task_plan").execute("1", plan(), undefined, undefined, ctxFor([true]).ctx);
  assert.equal(spawns.length, 1);
  assert.equal((await readTask(root))!.status, "implementing");

  // OK proceeds to the approval in one go
  await h.commands.get("task").handler("Again", ctxFor(["Replace it"]).ctx);
  await h.tools.get("task_plan").execute("1", { ...plan(), interface: [{ file: "src/fee.ts", exports: ["fee"], source: "user" }] }, undefined, undefined, ctxFor(["Accept the proposed names", true]).ctx);
  assert.equal(spawns.length, 2);
  assert.equal(emitted.at(-1).payload.status, "plan-ok");

  // review.plan = false disables it
  await updateManifest(root, (m) => void (m.review = { plan: false }));
  await h.commands.get("task").handler("Third", ctxFor(["Replace it"]).ctx);
  await h.tools.get("task_plan").execute("1", { ...plan(), interface: [{ file: "src/fee.ts", exports: ["fee"], source: "user" }] }, undefined, undefined, ctxFor(["Accept the proposed names", true]).ctx);
  assert.equal(spawns.length, 2);
});

test("MCP tool results read while planning count as ticket evidence", async () => {
  const { commands, tools, ctxFor, emit, root } = await setup();
  await commands.get("task").handler("PAY-12", ctxFor([]).ctx);
  await emit("tool_result", { toolName: "mcp__jira__get_issue", content: [{ type: "text", text: "Summary: fees\n\nAdd `computeTotal` to src/fee.ts" }] }, { cwd: root });
  const { ctx, ui } = ctxFor([true]);
  await tools.get("task_plan").execute("1", plan([], { interface: [{ file: "src/fee.ts", exports: ["computeTotal"], source: "ticket" }] }), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 1);
});
