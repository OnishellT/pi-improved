import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { updateManifest } from "../src/manifest.ts";
import { readTask, writeTask } from "../src/task-state.ts";
import { planCheckWanted, registerTask, specFiles } from "../src/task.ts";
import { APPROACH_FIRST, planText } from "../src/task-prompt.ts";
import { TASK_DONE_EVENT, VERIFY_EVENT } from "../src/events.ts";
import { fakeCtx, fakePi, fakeUI, isSubagent, tempProject } from "./helpers.ts";

const plan = (decisions: any[] = [], extra: any = {}) => ({
  summary: "Add fee",
  intent: "Charge a fee on each payment",
  steps: ["edit"],
  files: ["src/fee.ts", "test/fee.test.ts"],
  decisions,
  interface: [{ file: "src/fee.ts", exports: ["fee"], usage: "fee(100)", source: "ticket" }],
  seams: [{ name: "fee calc", testFile: "test/fee.test.ts", catches: "rounding" }],
  ...extra,
});

/** `fast: false` (default) marks the project as always-review, which keeps the human approval dialog in these tests. */
async function setup(done = true, fast = false) {
  const root = await tempProject({ "docs/adr/0001-money.md": "# money\n", "src/money.ts": "export const m = 1;\n" });
  if (done) await updateManifest(root, (m) => void ((m.setup = "done"), !fast && (m.review = { always: true })));
  const h = fakePi();
  registerTask(h.pi);
  const ctxFor = (answers: unknown[]) => fakeCtx(root, answers);
  return { root, ctxFor, ...h };
}

test("/task requires setup done", async () => {
  const { commands, sent, ctxFor, root } = await setup(false);
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  assert.equal(sent.length, 0);
  assert.equal(await readTask(root), undefined);
});

test("task_plan outside planning is refused", async () => {
  const { tools, ctxFor } = await setup();
  await assert.rejects(tools.get("task_plan").execute("1", plan(), undefined, undefined, ctxFor([]).ctx), /No task is being planned/);
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

test("/task with free text that starts like a key is not a ticket", async () => {
  const { commands, ctxFor, root } = await setup();
  await commands.get("task").handler("UTF-8 handling", ctxFor([]).ctx);
  assert.equal((await readTask(root))?.ticket, undefined);
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
  const result = await tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 3);
  const d = (await readTask(root))!.plan!.decisions[0];
  // The model is told pi wrote the ADR, so it neither deletes it nor writes its own.
  assert.ok(result.content[0].text.includes(`Fee unit? -> basis points (${d.source})`));
  assert.match(result.content[0].text, /pi wrote each one as an ADR/);
  assert.equal(d.status, "decided");
  assert.equal(d.answer, "basis points");
  assert.match(await fs.readFile(path.join(root, d.source!), "utf8"), /basis points/);
});

test("ask_user answers given while planning become decisions with ADRs and are not asked again", async () => {
  const { commands, tools, ctxFor, emit, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const input = { questions: [{ question: "Rounding?", options: ["half-up", "banker"] }, { question: "Negative amounts?", options: ["throw", "zero"] }] };
  const details = { answers: [{ question: "Rounding?", answer: "half-up" }, { question: "Negative amounts?", answer: "throw" }] };
  const result = await emit("tool_result", { toolName: "ask_user", input, details, content: [{ type: "text", text: "Q: Rounding?" }] }, ctxFor([]).ctx);
  assert.match(result.content.at(-1).text, /already recorded as plan decisions/);
  const { ctx, ui } = ctxFor([true]);
  await tools.get("task_plan").execute("1", plan([{ question: "Rounding?", options: ["half-up", "banker"] }]), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 1);
  const decisions = (await readTask(root))!.plan!.decisions;
  assert.deepEqual(decisions.map((d) => [d.question, d.answer]), [["Rounding?", "half-up"], ["Negative amounts?", "throw"]]);
  assert.match(await fs.readFile(path.join(root, decisions[1].source!), "utf8"), /throw/);
});

test("open ask_user answers while planning are the user's approach, not decisions with ADRs", async () => {
  const { commands, tools, ctxFor, emit, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const input = { questions: [{ question: "How would you store the fee?" }, { question: "Rounding?", options: ["half-up", "banker"] }] };
  const details = { answers: [{ question: "How would you store the fee?", answer: "In cents" }, { question: "Rounding?", answer: "half-up" }] };
  await emit("tool_result", { toolName: "ask_user", input, details, content: [] }, ctxFor([]).ctx);
  const open = { questions: [input.questions[0]] };
  assert.equal(await emit("tool_result", { toolName: "ask_user", input: open, details: { answers: [details.answers[0]] }, content: [] }, ctxFor([]).ctx), undefined);
  await tools.get("task_plan").execute("1", plan(), undefined, undefined, ctxFor([true]).ctx);
  assert.deepEqual((await readTask(root))!.plan!.decisions.map((d) => d.question), ["Rounding?"]);
});

test("the planning prompt asks for the user's approach first only with understanding plan+end (the default)", async () => {
  for (const [understanding, asks] of [[undefined, true], ["plan+end", true], ["end", false], ["off", false]] as const) {
    const { commands, sent, ctxFor, root } = await setup();
    if (understanding) await updateManifest(root, (m) => void (m.understanding = understanding));
    await commands.get("task").handler("Add fee", ctxFor([]).ctx);
    assert.equal(sent[0].includes(APPROACH_FIRST), asks, String(understanding));
  }
});

test("ask_user answers outside planning are not plan decisions", async () => {
  const { commands, tools, ctxFor, emit, root } = await setup();
  const result = await emit("tool_result", { toolName: "ask_user", input: { questions: [{ question: "Q?", options: ["a", "b"] }] }, details: { answers: [{ question: "Q?", answer: "a" }] }, content: [] }, ctxFor([]).ctx);
  assert.equal(result, undefined);
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  await tools.get("task_plan").execute("1", plan(), undefined, undefined, ctxFor([true]).ctx);
  assert.equal((await readTask(root))!.plan!.decisions.length, 0);
});

test("cancelled question stops; rejection returns feedback and stays planning", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const run = (answers: unknown[], decisions: any[] = []) => tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, ctxFor(answers).ctx);
  await assert.rejects(run([undefined], [{ question: "Q?", options: ["a", "b"] }]), /not approved/);
  await assert.rejects(run([false, "Smaller steps"]), /Smaller steps/);
  assert.equal((await readTask(root))!.status, "planning");
});

test("a retried plan reuses an answer only while the question's options stay the same", async () => {
  const { commands, tools, ctxFor } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const run = (answers: unknown[], options: string[]) => {
    const c = ctxFor(answers);
    return { ui: c.ui, done: tools.get("task_plan").execute("1", plan([{ question: "Q?", options }]), undefined, undefined, c.ctx) };
  };
  const first = run(["a", false, "Smaller steps"], ["a", "b"]);
  await assert.rejects(first.done, /Smaller steps/);
  const same = run([false, "Again"], ["a", "b"]);
  await assert.rejects(same.done, /Again/);
  assert.equal(same.ui.asked.length, 2);
  const changed = run(["c", true], ["a", "c"]);
  await changed.done;
  assert.equal(changed.ui.asked.length, 2);
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

test("a plain-text question while implementing is routed to ask_user, except in the TUI; a statement is not", async () => {
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
  // In the TUI the person reads the question and answers it: no nudge. RPC (hasUI true too) still gets one.
  await say("Should I scaffold one?");
  assert.equal(await emit("agent_before_settle", { outcome: "completed" }, { ...ctx, mode: "tui" }), undefined);
  assert.equal((await emit("agent_before_settle", { outcome: "completed" }, { ...ctx, mode: "rpc", hasUI: true })).continue, true);
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
  const iface = [{ file: "src/fee.ts", exports: ["fee"], usage: "fee(100)", source: "ticket" }, { file: "src/money.ts", exports: ["m"], source: "src/money.ts#m" }];
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

/** Project with a scripted plan-check subagent: `verdicts` are consumed in order (default OK). */
async function planCheckSetup() {
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
    m.review = { plan: true, always: true };
  });
  const ctxFor = (answers: unknown[]) => fakeCtx(root, answers);
  await h.commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const userNames = { ...plan(), interface: [{ file: "src/fee.ts", exports: ["fee"], source: "user" }] };
  return { ...h, verdicts, spawns, emitted, root, ctxFor, userNames };
}

test("plan check: FIX sends the findings back and the retry skips the paid check", async () => {
  const { tools, verdicts, spawns, emitted, ctxFor, root } = await planCheckSetup();
  verdicts.push("VERDICT: FIX\n1. src/fee.ts: siblings use camelCase, call it feeRate");
  await assert.rejects(tools.get("task_plan").execute("1", plan(), undefined, undefined, ctxFor([]).ctx), /senior review[\s\S]*call it feeRate/);
  assert.deepEqual(spawns, ["gpt-6-astra"]);
  assert.equal(emitted.at(-1).payload.status, "plan-fix");
  await tools.get("task_plan").execute("1", plan(), undefined, undefined, ctxFor([true]).ctx);
  assert.equal(spawns.length, 1);
  assert.equal((await readTask(root))!.status, "implementing");
});

test("plan check: OK proceeds to the approval", async () => {
  const { tools, spawns, emitted, ctxFor, userNames } = await planCheckSetup();
  await tools.get("task_plan").execute("1", userNames, undefined, undefined, ctxFor(["Accept the proposed names", true]).ctx);
  assert.equal(spawns.length, 1);
  assert.equal(emitted.at(-1).payload.status, "plan-ok");
});

test("plan check: review.plan = false disables it", async () => {
  const { tools, spawns, ctxFor, userNames, root } = await planCheckSetup();
  await updateManifest(root, (m) => void (m.review = { plan: false }));
  await tools.get("task_plan").execute("1", userNames, undefined, undefined, ctxFor(["Accept the proposed names", true]).ctx);
  assert.equal(spawns.length, 0);
});

test("ticket text from the tracker connector counts as evidence; other MCP results do not", async () => {
  const { commands, tools, ctxFor, emit, root } = await setup();
  await updateManifest(root, (m) => void (m.connectors = [{ id: "jira" }]));
  await commands.get("task").handler("PAY-12", ctxFor([]).ctx);
  const read = (toolName: string) => emit("tool_result", { toolName, content: [{ type: "text", text: "Add `computeTotal` to src/fee.ts" }] }, { cwd: root });
  const iface = [{ file: "src/fee.ts", exports: ["computeTotal"], source: "ticket" }];
  await read("mcp__browser__page_text");
  await read("bash");
  const loud = ctxFor(["Accept the proposed names", true]);
  await tools.get("task_plan").execute("1", plan([], { interface: iface }), undefined, undefined, loud.ctx);
  assert.equal(loud.ui.asked.length, 2);
  await commands.get("task").handler("PAY-12", ctxFor(["Replace it"]).ctx);
  await read("mcp__jira__get_issue");
  const quiet = ctxFor([true]);
  await tools.get("task_plan").execute("1", plan([], { interface: iface }), undefined, undefined, quiet.ctx);
  assert.equal(quiet.ui.asked.length, 1);
});

test("a tracker result read after planning ended is not evidence for the next task", async () => {
  const { commands, tools, ctxFor, emit, root } = await setup();
  await updateManifest(root, (m) => void (m.connectors = [{ id: "jira" }]));
  await commands.get("task").handler("PAY-12", ctxFor([]).ctx);
  await tools.get("task_plan").execute("1", plan([], { interface: [{ file: "src/money.ts", exports: ["m"], source: "src/money.ts" }] }), undefined, undefined, ctxFor([true]).ctx);
  await emit("tool_result", { toolName: "mcp__jira__get_issue", content: "Add `computeTotal` to src/fee.ts" }, { cwd: root });
  await commands.get("task").handler("PAY-12", ctxFor(["Replace it"]).ctx);
  const { ctx, ui } = ctxFor(["Accept the proposed names", true]);
  await tools.get("task_plan").execute("1", plan([], { interface: [{ file: "src/fee.ts", exports: ["computeTotal"], source: "ticket" }] }), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 2);
});

test("a decision whose source exists but is about something else is still asked", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const { ctx, ui } = ctxFor(["cents", true]);
  const decisions = [{ question: "Fee unit?", options: ["cents", "percent"], source: "docs/adr/0001-money.md" }];
  await tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 2);
  assert.equal((await readTask(root))!.plan!.decisions[0].status, "decided");
});

test("a decision source outside the project is never read", async () => {
  const { commands, tools, ctxFor } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const { ctx, ui } = ctxFor(["cents", true]);
  const decisions = [{ question: "Money type?", options: ["cents", "float"], source: "../../../../etc/hosts" }];
  await tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 2);
});

test("specFiles keeps existing in-repo files once, ignoring trailing punctuation and files outside the repo", async () => {
  const root = await tempProject({ "docs/a.md": "x" });
  assert.deepEqual(await specFiles(root, "see docs/a.md. Also docs/a.md, docs/missing.md and /etc/hostname.txt, ../x.md"), ["docs/a.md"]);
});

test("ticket text from the tracker is evidence for names labelled 'ticket'", async () => {
  const { commands, tools, ctxFor, emit, root } = await setup();
  await updateManifest(root, (m) => void (m.connectors = [{ id: "jira" }]));
  await commands.get("task").handler("PAY-12", ctxFor([]).ctx);
  assert.equal((await readTask(root))!.ticket, "PAY-12");
  await emit("tool_result", { toolName: "mcp__jira__get_issue", content: "Add `computeTotal` to src/fee.ts" }, { cwd: root });
  const { ctx, ui } = ctxFor([true]);
  await tools.get("task_plan").execute("1", plan([], { interface: [{ file: "src/fee.ts", exports: ["computeTotal"], source: "ticket" }] }), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 1);
});

test("/task cancel says so when there is no task; 'Continue it' on an implementing task tells the user", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  const say = async (cmd: string, answers: unknown[] = []) => {
    const { ctx } = ctxFor(answers);
    const notes: string[] = [];
    ctx.ui.notify = (m: string) => notes.push(m);
    await commands.get("task").handler(cmd, ctx);
    return notes;
  };
  assert.match((await say("cancel"))[0], /No active task/);
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  await tools.get("task_plan").execute("1", plan(), undefined, undefined, ctxFor([true]).ctx);
  assert.match((await say("Add fee", ["Continue it"]))[0], /already implementing/);
  assert.match((await say("cancel"))[0], /Task cancelled/);
  assert.equal(await readTask(root), undefined);
});

test("plan check is off by default and follows review.plan, review.always and risky plan files", () => {
  const on = (review: any, files: string[] = ["src/fee.ts"]) => planCheckWanted({ version: 1, setup: "done", verify: [], connectors: [], review } as any, files);
  assert.equal(on(undefined), false);
  assert.equal(on(undefined, ["package.json"]), true, "the review level defaults to high");
  assert.equal(on({ minLevel: "off" }, ["package.json"]), false);
  assert.equal(on({ minLevel: "high" }, ["package.json"]), true);
  assert.equal(on({ minLevel: "high" }), false);
  assert.equal(on({ plan: true }), true);
  assert.equal(on({ plan: false, minLevel: "high" }, ["package.json"]), false);
  assert.equal(on({ always: true, never: true, plan: false }), true);
});

test("approving the plan stores the HEAD commit as baseCommit", async () => {
  const hash = "a".repeat(40);
  const h = fakePi((cmd, args) => (cmd === "git" && args[0] === "rev-parse" ? { code: 0, stdout: `${hash}\n` } : { code: 0 }));
  registerTask(h.pi);
  const root = await tempProject({ "src/money.ts": "export const m = 1;\n" });
  await updateManifest(root, (m) => void (m.setup = "done"));
  const ui = fakeUI(["Accept the proposed names", true]);
  const ctx = { cwd: root, hasUI: true, ui, waitForIdle: async () => {} } as any;
  await h.commands.get("task").handler("Add fee", ctx);
  await h.tools.get("task_plan").execute("1", { ...plan(), interface: [{ file: "src/fee.ts", exports: ["fee"], source: "user" }] }, undefined, undefined, ctx);
  assert.equal((await readTask(root))!.baseCommit, hash);
});

test("fast path: a small plan with no risk trigger skips the approval dialog but still runs the gates", async () => {
  const { commands, tools, ctxFor, root } = await setup(true, true);
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const { ui, ctx } = ctxFor([]);
  const result = await tools.get("task_plan").execute("1", plan(), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 0);
  assert.equal((await readTask(root))?.status, "implementing");
  assert.match(result.content[0].text, /Plan approved/);
  assert.match(result.content[0].text, /Do not change existing tests or the verify configuration/);
  assert.match(result.content[0].text, /## Skill: principles-implement/);
  assert.doesNotMatch(result.content[0].text, /## Skill: tdd/);
  const bad = plan([], { interface: [{ file: "src/fee.ts", exports: ["computeTotal"], source: "ticket" }] });
  await commands.get("task").handler("Add fee", ctxFor(["Replace it"]).ctx);
  await assert.rejects(tools.get("task_plan").execute("1", bad, undefined, undefined, ctxFor([undefined]).ctx), /not approved/);
});

test("fast path is closed by size and by risk triggers", async () => {
  const { planRiskReasons } = await import("../src/risk.ts");
  const m: any = { review: {} };
  const base = { files: ["src/a.ts", "test/a.test.ts"], interface: [], decisions: [] };
  assert.deepEqual(planRiskReasons(base, m), []);
  assert.deepEqual(planRiskReasons({ ...base, files: Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`) }, m), []);
  assert.match(planRiskReasons({ ...base, files: Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`) }, m)[0], /9 files/);
  assert.match(planRiskReasons({ ...base, interface: new Array(7).fill({}) }, m)[0], /7 interface/);
  assert.match(planRiskReasons({ ...base, decisions: [1, 2, 3] }, m)[0], /3 decisions/);
  assert.match(planRiskReasons({ ...base, files: ["package.json"] }, m)[0], /dependencies/);
  assert.match(planRiskReasons({ ...base, files: ["db/migrations/001.sql"] }, m)[0], /migration/);
  assert.match(planRiskReasons({ ...base, files: ["src/auth/login.ts"] }, m)[0], /sensitive/);
  assert.match(planRiskReasons(base, { review: { paths: ["src/**"] } } as any)[0], /review.paths/);
  assert.deepEqual(planRiskReasons(base, { review: { always: true } } as any), ["review.always"]);
});

test("a plan without an intent is refused before anything is asked", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  for (const intent of ["", "   ", undefined]) {
    const { ctx, ui } = ctxFor([true]);
    await assert.rejects(tools.get("task_plan").execute("1", plan([], { intent }), undefined, undefined, ctx), /no intent/);
    assert.equal(ui.asked.length, 0);
  }
  assert.equal((await readTask(root))?.status, "planning");
});

test("the approval dialog shows the intent and each usage line, and the saved plan keeps them", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const { ctx, ui } = ctxFor([true]);
  const bodies: string[] = [];
  const confirm = ui.confirm;
  ui.confirm = ((title: string, body: string) => (bodies.push(body), confirm(title))) as any;
  await tools.get("task_plan").execute("1", plan(), undefined, undefined, ctx);
  assert.match(bodies[0], /Intent: Charge a fee on each payment[\s\S]*src\/fee\.ts: fee[\s\S]*usage: fee\(100\)/);
  const saved = (await readTask(root))!.plan!;
  assert.equal(saved.intent, "Charge a fee on each payment");
  assert.equal(saved.interface[0].usage, "fee(100)");
  assert.match(planText(saved), /^Intent: Charge a fee/);
});

test("approving the plan runs no verify command, and the agent hears to keep implementing when tests cannot run here", async () => {
  const runs: string[] = [];
  const h = fakePi(() => ({ code: 1, stdout: "FAIL old test 12" }));
  const base = h.pi.exec;
  h.pi.exec = (cmd: string, args: string[], o: any) => (cmd === "bash" && runs.push(args[1]), base(cmd, args, o));
  const emitted: any[] = [];
  h.pi.events = { emit: (name: string, payload: any) => emitted.push({ name, payload }) };
  registerTask(h.pi);
  const root = await tempProject({ "src/money.ts": "export const m = 1;\n" });
  await updateManifest(root, (m) => void ((m.setup = "done"), (m.review = { always: true }), (m.verify = ["fast check", "slow check"])));
  await h.commands.get("task").handler("Add fee", fakeCtx(root, []).ctx);
  const result = await h.tools.get("task_plan").execute("1", plan(), undefined, undefined, fakeCtx(root, ["Accept the proposed names", true]).ctx);
  assert.deepEqual(runs, []);
  assert.equal(emitted.find((e) => e.name === VERIFY_EVENT), undefined);
  assert.equal((await readTask(root))!.status, "implementing");
  assert.match(result.content[0].text, /cannot run here, keep implementing: verify runs at the end/);
});

test("/task titles a long pasted ticket by its first line and keeps the whole text in the prompt and the evidence", async () => {
  const h = fakePi();
  registerTask(h.pi);
  const root = await tempProject({ "TICKET.md": "# Superconduct shred is missing\n\nBody of the ticket.\n" });
  await updateManifest(root, (m) => void (m.setup = "done"));
  const ticket = "# Superconduct physical shred is missing, and the optimizer ignores enemy shred and more words to be long\n\nSecond paragraph with the details.";
  await h.commands.get("task").handler(ticket, fakeCtx(root, []).ctx);
  const task = (await readTask(root))!;
  assert.ok(!task.title.includes("\n") && task.title.length <= 72, task.title);
  assert.equal(task.body, ticket);
  assert.match(h.sent[0], /Second paragraph with the details\./);
  await h.commands.get("task").handler("cancel", fakeCtx(root, []).ctx);
  // a request that is only a spec file is titled by the file's first line
  await h.commands.get("task").handler("TICKET.md", fakeCtx(root, []).ctx);
  const byFile = (await readTask(root))!;
  assert.equal(byFile.title, "Superconduct shred is missing");
  assert.equal(byFile.body, undefined);
  assert.deepEqual(byFile.spec, ["TICKET.md"]);
  // a short request stays as typed
  await h.commands.get("task").handler("cancel", fakeCtx(root, []).ctx);
  await h.commands.get("task").handler("Add fee", fakeCtx(root, []).ctx);
  const plain = (await readTask(root))!;
  assert.equal(plain.title, "Add fee");
  assert.equal(plain.body, undefined);
});

/** A task session whose model switches are recorded: starts on p/mine, the implement model is p/cheap. */
async function modelSetup() {
  const t = await setup();
  await updateManifest(t.root, (m) => void (m.models = { implement: "p/cheap" }));
  const set: string[] = [];
  const emitted: any[] = [];
  t.pi.setModel = async (m: any) => (set.push(`${m.provider}/${m.id}`), true);
  t.pi.events = { emit: (name: string, payload: any) => emitted.push({ name, payload }) };
  const mk = (id: string) => ({ provider: "p", id });
  const registry = { find: (_p: string, id: string) => mk(id), getAvailable: () => [mk("cheap"), mk("mine")] };
  const ctxFor = (answers: unknown[], extra: object = {}) => fakeCtx(t.root, answers, { model: mk("mine"), modelRegistry: registry, ...extra });
  return { ...t, set, emitted, ctxFor };
}

test("/task done closes an implementing task (done, event, model back); declining the dialog is no dead end", async () => {
  const t = await modelSetup();
  await t.commands.get("task").handler("Add fee", t.ctxFor([]).ctx);
  assert.equal((await readTask(t.root))!.model, "p/mine");
  await t.commands.get("task").handler("done", t.ctxFor([]).ctx);
  assert.equal((await readTask(t.root))!.status, "planning", "a task still being planned is not done");
  await writeTask(t.root, { ...(await readTask(t.root))!, status: "implementing" });
  await t.commands.get("task").handler("done", t.ctxFor([]).ctx);
  const done = (await readTask(t.root))!;
  assert.equal(done.status, "done");
  assert.ok(done.completedAt);
  assert.deepEqual(t.emitted.map((e) => e.name), [TASK_DONE_EVENT]);
  assert.deepEqual(t.set, ["p/cheap", "p/mine"]);
});

test("/task cancel puts the model back; a replaced task hands it on", async () => {
  const t = await modelSetup();
  await t.commands.get("task").handler("First", t.ctxFor([]).ctx);
  await t.commands.get("task").handler("Second", t.ctxFor(["Replace it"], { model: { provider: "p", id: "cheap" } }).ctx);
  assert.equal((await readTask(t.root))!.model, "p/mine");
  await t.commands.get("task").handler("cancel", t.ctxFor([]).ctx);
  assert.deepEqual(t.set, ["p/cheap", "p/mine"]);
});

test("an unreadable task file: /task says how out, /task cancel removes it", async () => {
  const t = await setup();
  await fs.writeFile(path.join(t.root, ".pi/task.json"), '{"id": "t1", "tit');
  const notes: string[] = [];
  const { ctx } = t.ctxFor([]);
  ctx.ui.notify = (m: string) => void notes.push(m);
  await t.commands.get("task").handler("", ctx);
  assert.match(notes[0], /\.pi\/task\.json is not valid JSON.*\/task cancel removes it/);
  await t.commands.get("task").handler("cancel", ctx);
  assert.equal(notes[1], "Task cancelled.");
  assert.equal(await readTask(t.root), undefined);
});

test("writeTask leaves no temp file and a read error that is not JSON says it cannot be read", async () => {
  const root = await tempProject({});
  await writeTask(root, { id: "t", title: "T", status: "planning", allowedExtra: [], startedAt: "" });
  assert.deepEqual(await fs.readdir(path.join(root, ".pi")), ["task.json"]);
  await fs.rm(path.join(root, ".pi/task.json"));
  await fs.mkdir(path.join(root, ".pi/task.json"));
  await assert.rejects(readTask(root), /\.pi\/task\.json cannot be read: EISDIR/);
});

test("a session that starts with an open task says so once; a reload or a done task says nothing", async () => {
  const t = await setup();
  const notes: string[] = [];
  const { ctx } = t.ctxFor([]);
  ctx.ui.notify = (m: string) => void notes.push(m);
  await t.emit("session_start", { reason: "startup" }, ctx);
  assert.deepEqual(notes, []);
  await t.commands.get("task").handler("Add fee", t.ctxFor([]).ctx);
  await t.emit("session_start", { reason: "reload" }, ctx);
  assert.deepEqual(notes, []);
  await t.emit("session_start", { reason: "resume" }, ctx);
  assert.deepEqual(notes, ['Task "Add fee" is planning: /task cancel ends it.']);
  await writeTask(t.root, { ...(await readTask(t.root))!, status: "implementing" });
  await t.emit("session_start", { reason: "fork" }, ctx);
  assert.equal(notes[1], 'Task "Add fee" is implementing: /task done or /task cancel ends it.');
  await writeTask(t.root, { ...(await readTask(t.root))!, status: "done" });
  await t.emit("session_start", { reason: "startup" }, ctx);
  assert.equal(notes.length, 2);
});

test("without a UI, /task with a task already open says how to end it instead of returning silently", async () => {
  const t = await setup();
  await t.commands.get("task").handler("First", t.ctxFor([]).ctx);
  const notes: string[] = [];
  const { ctx } = fakeCtx(t.root, [], { hasUI: false });
  ctx.ui.notify = (m: string) => void notes.push(m);
  await t.commands.get("task").handler("Second", ctx);
  assert.equal(notes[0], "A task is already active: First. /task cancel ends it.");
  assert.equal((await readTask(t.root))!.title, "First");
});

test("plan check: one that did not run does not use up the budget", async () => {
  const { tools, verdicts, spawns, ctxFor, root } = await planCheckSetup();
  verdicts.push("no verdict here");
  await tools.get("task_plan").execute("1", plan(), undefined, undefined, ctxFor([true]).ctx);
  assert.equal(spawns.length, 1);
  assert.equal((await readTask(root))!.planChecks ?? 0, 0);
});
