import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { updateManifest } from "../src/manifest.ts";
import { readTask, writeTask } from "../src/task-state.ts";
import { planCheckWanted, registerTask, specFiles } from "../src/task.ts";
import { APPROACH_FIRST, planText } from "../src/task-prompt.ts";
import { TASK_DONE_EVENT, VERIFY_EVENT } from "../src/events.ts";
import { METRICS_DIR } from "../src/telemetry.ts";
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

/** `fast: false` (default) marks the project as always-review: a risky plan, which still goes straight to implementing. */
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

test("task_plan with a documented source asks nothing and goes straight to implementing", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const { ctx, ui } = ctxFor([]);
  const decisions = [{ question: "Money type?", options: ["cents", "float"], source: "docs/adr/0001-money.md#types" }];
  await tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 0);
  const task = (await readTask(root))!;
  assert.equal(task.status, "implementing");
  assert.equal(task.plan!.decisions[0].status, "documented");
});

test("invalid source is asked and recorded as an ADR", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const { ctx, ui } = ctxFor(["✏️  Other answer…", "basis points"]);
  const decisions = [{ question: "Fee unit?", options: ["cents", "percent"], source: "docs/missing.md" }];
  const result = await tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 2);
  const d = (await readTask(root))!.plan!.decisions[0];
  // The model is told pi wrote the ADR, so it neither deletes it nor writes its own.
  assert.ok(result.content[0].text.includes(`Fee unit? -> basis points (${d.source})`));
  assert.match(result.content[0].text, /pi wrote an ADR for each one that shows a path/);
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
  const { ctx, ui } = ctxFor([]);
  await tools.get("task_plan").execute("1", plan([{ question: "Rounding?", options: ["half-up", "banker"] }]), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 0);
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
  await tools.get("task_plan").execute("1", plan(), undefined, undefined, ctxFor([]).ctx);
  assert.deepEqual((await readTask(root))!.plan!.decisions.map((d) => d.question), ["Rounding?"]);
});

test("the planning prompt asks for the user's approach first only with understanding plan+end (the default) and a UI", async () => {
  for (const [understanding, asks] of [[undefined, true], ["plan+end", true], ["end", false], ["off", false]] as const) {
    const { commands, sent, ctxFor, root } = await setup();
    if (understanding) await updateManifest(root, (m) => void (m.understanding = understanding));
    await commands.get("task").handler("Add fee", ctxFor([]).ctx);
    assert.equal(sent[0].includes(APPROACH_FIRST), asks, String(understanding));
  }
  // Headless, nobody can answer ask_user: the agent plans straight away.
  const { commands, sent, root } = await setup();
  await commands.get("task").handler("Add fee", fakeCtx(root, [], { hasUI: false }).ctx);
  assert.ok(sent[0] && !sent[0].includes(APPROACH_FIRST));
});

test("ask_user answers outside planning are not plan decisions", async () => {
  const { commands, tools, ctxFor, emit, root } = await setup();
  const result = await emit("tool_result", { toolName: "ask_user", input: { questions: [{ question: "Q?", options: ["a", "b"] }] }, details: { answers: [{ question: "Q?", answer: "a" }] }, content: [] }, ctxFor([]).ctx);
  assert.equal(result, undefined);
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  await tools.get("task_plan").execute("1", plan(), undefined, undefined, ctxFor([]).ctx);
  assert.equal((await readTask(root))!.plan!.decisions.length, 0);
});

test("a cancelled planning question stops the plan, which stays planning", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const decisions = [{ question: "Q?", options: ["a", "b"] }];
  await assert.rejects(tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, ctxFor([undefined]).ctx), /cancelled the decision question, so the plan stops here/);
  const task = (await readTask(root))!;
  assert.equal(task.status, "planning");
  assert.equal(task.plan, undefined);
});

test("a retried plan reuses an answer only while the question's options stay the same", async () => {
  const { commands, tools, ctxFor, emit } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const run = (answers: unknown[], options: string[]) => {
    const c = ctxFor(answers);
    const decisions = [{ question: "Q?", options }, { question: "R?", options: ["x", "y"] }];
    return { ui: c.ui, done: tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, c.ctx) };
  };
  // The second question is cancelled: the retry asks only that one again.
  // Each retry follows a user message: a cancel pauses planning until the user writes.
  const reply = () => emit("before_agent_start", { messageType: "user" }, ctxFor([]).ctx);
  await assert.rejects(run(["a", undefined], ["a", "b"]).done, /cancelled/);
  await reply();
  const same = run([undefined], ["a", "b"]);
  await assert.rejects(same.done, /cancelled/);
  assert.deepEqual(same.ui.asked, ["R?"]);
  await reply();
  const changed = run(["c", "x"], ["a", "c"]);
  await changed.done;
  assert.deepEqual(changed.ui.asked, ["Q?", "R?"]);
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

test("invented interface names are asked once in plain words and kept in task.json, with no ADR", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const { ctx, ui } = ctxFor(["Use them"]);
  const result = await tools.get("task_plan").execute("1", plan([], { interface: [{ file: "src/fee.ts", exports: ["computeFee"], signatures: ["computeFee(n: number): number"], source: "user" }] }), undefined, undefined, ctx);
  assert.deepEqual(ui.asked, ["The ticket does not name these. Use them?\nsrc/fee.ts: computeFee, computeFee(n: number): number"]);
  assert.match(result.content[0].text, /write the tests/);
  const d = (await readTask(root))!.plan!.decisions[0];
  assert.equal(d.status, "decided");
  assert.equal(d.source, undefined);
  assert.equal(d.answer, "src/fee.ts: computeFee, computeFee(n: number): number");
  assert.deepEqual(await fs.readdir(path.join(root, "docs/adr")), ["0001-money.md"]);
});

test("names labelled 'user' that the ticket already gives are not asked", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("List users with their fees", ctxFor([]).ctx);
  const { ctx, ui } = ctxFor([]);
  await tools.get("task_plan").execute("1", plan([], { interface: [{ file: "src/fee.ts", exports: ["fee"], source: "user" }] }), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 0);
  assert.equal((await readTask(root))!.status, "implementing");
});

test("interface from ticket or an existing path is accepted silently", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const { ctx, ui } = ctxFor([]);
  const iface = [{ file: "src/fee.ts", exports: ["fee"], usage: "fee(100)", source: "ticket" }, { file: "src/money.ts", exports: ["m"], source: "src/money.ts#m" }];
  await tools.get("task_plan").execute("1", plan([], { interface: iface }), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 0);
  assert.equal((await readTask(root))!.plan!.decisions.length, 0);
});

test("seam outside files and empty interface with new files are rejected", async () => {
  const { commands, tools, ctxFor } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const run = (extra: any) => tools.get("task_plan").execute("1", plan([], extra), undefined, undefined, ctxFor([]).ctx);
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
  const quiet = ctxFor([]);
  await tools.get("task_plan").execute("1", plan([], { interface: [{ file: "src/fee.ts", exports: ["fee", "computeTotal"], source: "ticket" }] }), undefined, undefined, quiet.ctx);
  assert.equal(quiet.ui.asked.length, 0);
  // parseMicros is nowhere and the new file `micros.ts` is not a ticket noun: the label 'ticket' does not save it
  await commands.get("task").handler("Add fee per docs/spec.md", ctxFor(["Replace it"]).ctx);
  const loud = ctxFor(["Use them"]);
  await tools.get("task_plan").execute("1", plan([], { files: ["src/micros.ts", "test/fee.test.ts"], interface: [{ file: "src/micros.ts", exports: ["parseMicros"], source: "ticket" }] }), undefined, undefined, loud.ctx);
  assert.deepEqual(loud.ui.asked, ["The ticket does not name these. Use them?\nsrc/micros.ts: parseMicros"]);
  assert.equal((await readTask(root))!.plan!.decisions[0].status, "decided");
});

test("a cited existing file must contain the names too", async () => {
  const { commands, tools, ctxFor } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const { ctx, ui } = ctxFor(["Use them"]);
  await tools.get("task_plan").execute("1", plan([], { interface: [{ file: "src/money.ts", exports: ["m", "formatUsd"], source: "src/money.ts" }] }), undefined, undefined, ctx);
  assert.match(ui.asked[0], /src\/money\.ts: m, formatUsd/);
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
  await tools.get("task_plan").execute("1", plan(), undefined, undefined, ctxFor([]).ctx);
  assert.equal(spawns.length, 1);
  assert.equal((await readTask(root))!.status, "implementing");
});

test("plan check: OK proceeds to implementing", async () => {
  const { tools, spawns, emitted, ctxFor, userNames, root } = await planCheckSetup();
  await tools.get("task_plan").execute("1", userNames, undefined, undefined, ctxFor(["Use them"]).ctx);
  assert.equal(spawns.length, 1);
  assert.equal(emitted.at(-1).payload.status, "plan-ok");
  assert.equal((await readTask(root))!.status, "implementing");
});

test("plan check: one that did not run is reported as plan-skipped, not as a skipped code review", async () => {
  const { tools, verdicts, emitted, ctxFor, userNames } = await planCheckSetup();
  verdicts.push("no verdict line here");
  await tools.get("task_plan").execute("1", userNames, undefined, undefined, ctxFor(["Use them"]).ctx);
  assert.equal(emitted.at(-1).payload.status, "plan-skipped");
});

test("plan check: review.plan = false disables it", async () => {
  const { tools, spawns, ctxFor, userNames, root } = await planCheckSetup();
  await updateManifest(root, (m) => void (m.review = { plan: false }));
  await tools.get("task_plan").execute("1", userNames, undefined, undefined, ctxFor(["Use them"]).ctx);
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
  const loud = ctxFor(["Use them"]);
  await tools.get("task_plan").execute("1", plan([], { interface: iface }), undefined, undefined, loud.ctx);
  assert.equal(loud.ui.asked.length, 1);
  await commands.get("task").handler("PAY-12", ctxFor(["Replace it"]).ctx);
  await read("mcp__jira__get_issue");
  const quiet = ctxFor([]);
  await tools.get("task_plan").execute("1", plan([], { interface: iface }), undefined, undefined, quiet.ctx);
  assert.equal(quiet.ui.asked.length, 0);
});

test("a tracker result read after planning ended is not evidence for the next task", async () => {
  const { commands, tools, ctxFor, emit, root } = await setup();
  await updateManifest(root, (m) => void (m.connectors = [{ id: "jira" }]));
  await commands.get("task").handler("PAY-12", ctxFor([]).ctx);
  await tools.get("task_plan").execute("1", plan([], { interface: [{ file: "src/money.ts", exports: ["m"], source: "src/money.ts" }] }), undefined, undefined, ctxFor([]).ctx);
  await emit("tool_result", { toolName: "mcp__jira__get_issue", content: "Add `computeTotal` to src/fee.ts" }, { cwd: root });
  await commands.get("task").handler("PAY-12", ctxFor(["Replace it"]).ctx);
  const { ctx, ui } = ctxFor(["Use them"]);
  await tools.get("task_plan").execute("1", plan([], { interface: [{ file: "src/fee.ts", exports: ["computeTotal"], source: "ticket" }] }), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 1);
});

test("a decision whose source exists but is about something else is still asked", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const { ctx, ui } = ctxFor(["cents"]);
  const decisions = [{ question: "Fee unit?", options: ["cents", "percent"], source: "docs/adr/0001-money.md" }];
  await tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 1);
  assert.equal((await readTask(root))!.plan!.decisions[0].status, "decided");
});

test("a decision source outside the project is never read", async () => {
  const { commands, tools, ctxFor } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const { ctx, ui } = ctxFor(["cents"]);
  const decisions = [{ question: "Money type?", options: ["cents", "float"], source: "../../../../etc/hosts" }];
  await tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 1);
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
  const { ctx, ui } = ctxFor([]);
  await tools.get("task_plan").execute("1", plan([], { interface: [{ file: "src/fee.ts", exports: ["computeTotal"], source: "ticket" }] }), undefined, undefined, ctx);
  assert.equal(ui.asked.length, 0);
});

test("/task cancel says so when there is no task; an implementing task offers no 'Continue it'", async () => {
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
  await tools.get("task_plan").execute("1", plan(), undefined, undefined, ctxFor([]).ctx);
  const { ctx: keep, ui } = ctxFor(["Keep it"]);
  let options: string[] = [];
  const select = keep.ui.select;
  keep.ui.select = (title: string, o: string[]) => ((options = o), select(title));
  await commands.get("task").handler("Other work", keep);
  assert.deepEqual(options, ["Replace it", "Keep it"]);
  assert.deepEqual(ui.asked, ["A task is already implementing: Add fee"]);
  assert.equal((await readTask(root))!.title, "Add fee");
  assert.match((await say("continue"))[0], /keep working in the session\. \/task done or \/task cancel ends it/);
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

test("recording the plan stores the HEAD commit as baseCommit", async () => {
  const hash = "a".repeat(40);
  const h = fakePi((cmd, args) => (cmd === "git" && args[0] === "rev-parse" ? { code: 0, stdout: `${hash}\n` } : { code: 0 }));
  registerTask(h.pi);
  const root = await tempProject({ "src/money.ts": "export const m = 1;\n" });
  await updateManifest(root, (m) => void (m.setup = "done"));
  const ui = fakeUI(["Use them"]);
  const ctx = { cwd: root, hasUI: true, ui, waitForIdle: async () => {} } as any;
  await h.commands.get("task").handler("Add fee", ctx);
  await h.tools.get("task_plan").execute("1", { ...plan(), interface: [{ file: "src/fee.ts", exports: ["fee"], source: "user" }] }, undefined, undefined, ctx);
  assert.equal((await readTask(root))!.baseCommit, hash);
});

test("small and risky plans both go straight to implementing with one short notice, never the whole plan", async () => {
  for (const [fast, line] of [[true, "Plan recorded: 1 step, 2 files. Implementing."], [false, "Plan recorded: 1 step, 2 files. Implementing. Risk: review.always."]] as const) {
    const { commands, tools, ctxFor, root } = await setup(true, fast);
    await commands.get("task").handler("Add fee", ctxFor([]).ctx);
    const { ui, ctx } = ctxFor([]);
    const notes: string[] = [];
    ctx.ui.notify = (m: string) => void notes.push(m);
    let confirms = 0;
    ctx.ui.confirm = async () => (confirms++, true);
    const result = await tools.get("task_plan").execute("1", plan(), undefined, undefined, ctx);
    assert.equal(confirms, 0);
    assert.deepEqual(ui.asked, []);
    assert.deepEqual(notes, [line]);
    const task = (await readTask(root))!;
    assert.equal(task.status, "implementing");
    assert.ok(!notes.some((n) => n.includes(planText(task.plan!)) || /Steps:|Intent:/.test(n)));
    assert.match(result.content[0].text, /^Plan recorded\./);
    assert.doesNotMatch(result.content[0].text, /approved/);
  }
});

test("a small plan still runs the gates", async () => {
  const { commands, tools, ctxFor } = await setup(true, true);
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const result = await tools.get("task_plan").execute("1", plan(), undefined, undefined, ctxFor([]).ctx);
  assert.match(result.content[0].text, /Do not change existing tests or the verify configuration/);
  assert.match(result.content[0].text, /## Skill: principles-implement/);
  assert.doesNotMatch(result.content[0].text, /## Skill: tdd/);
  const bad = plan([], { interface: [{ file: "src/fee.ts", exports: ["computeTotal"], source: "ticket" }] });
  await commands.get("task").handler("Add fee", ctxFor(["Replace it"]).ctx);
  await assert.rejects(tools.get("task_plan").execute("1", bad, undefined, undefined, ctxFor([undefined]).ctx), /plan stops here/);
});

test("a plan is risky by size and by risk triggers", async () => {
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
    const { ctx, ui } = ctxFor([]);
    await assert.rejects(tools.get("task_plan").execute("1", plan([], { intent }), undefined, undefined, ctx), /no intent/);
    assert.equal(ui.asked.length, 0);
  }
  assert.equal((await readTask(root))?.status, "planning");
});

test("the saved plan keeps the intent and each usage line for the commands that show it", async () => {
  const { commands, tools, ctxFor, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  await tools.get("task_plan").execute("1", plan(), undefined, undefined, ctxFor([]).ctx);
  const saved = (await readTask(root))!.plan!;
  assert.equal(saved.intent, "Charge a fee on each payment");
  assert.equal(saved.interface[0].usage, "fee(100)");
  assert.match(planText(saved), /^Intent: Charge a fee/);
});

test("recording the plan runs no verify command, and the agent hears to keep implementing when tests cannot run here", async () => {
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
  const result = await h.tools.get("task_plan").execute("1", plan(), undefined, undefined, fakeCtx(root, ["Use them"]).ctx);
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

test("/task done during the understanding check records it as skipped, before the task is done", async () => {
  const t = await modelSetup();
  await t.commands.get("task").handler("Add fee", t.ctxFor([]).ctx);
  await writeTask(t.root, { ...(await readTask(t.root))!, status: "implementing", understanding: { tree: "t" } });
  await t.commands.get("task").handler("done", t.ctxFor([]).ctx);
  const { id } = (await readTask(t.root))!;
  assert.deepEqual(t.emitted.map((e) => e.name), [TASK_DONE_EVENT]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(t.root, METRICS_DIR, `${id}.json`), "utf8")).understanding, { outcome: "skipped", gaps: 0 });
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
  assert.deepEqual(notes, ['Task "Add fee" is planning: /task continue resumes planning, /task cancel drops it.']);
  await writeTask(t.root, { ...(await readTask(t.root))!, status: "implementing" });
  await t.emit("session_start", { reason: "fork" }, ctx);
  assert.equal(notes[1], 'Task "Add fee" is implementing: /task done or /task cancel ends it.');
  await writeTask(t.root, { ...(await readTask(t.root))!, status: "done" });
  await t.emit("session_start", { reason: "startup" }, ctx);
  assert.equal(notes.length, 2);
});

/** Runs `fn` with console.error captured and process.exitCode restored after: print mode drops notices, so headless /task says it on stderr. */
async function stderrOf(fn: () => Promise<unknown>) {
  const [error, code] = [console.error, process.exitCode];
  const lines: string[] = [];
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  process.exitCode = undefined;
  try {
    await fn();
    return { lines, exitCode: process.exitCode };
  } finally {
    console.error = error;
    process.exitCode = code;
  }
}

test("without a UI, /task with a task already open says how to end it on stderr and exits 1", async () => {
  const t = await setup();
  await t.commands.get("task").handler("First", t.ctxFor([]).ctx);
  const notes: string[] = [];
  const { ctx } = fakeCtx(t.root, [], { hasUI: false });
  ctx.ui.notify = (m: string) => void notes.push(m);
  const end = await stderrOf(() => t.commands.get("task").handler("Second", ctx));
  assert.equal(notes[0], "A task is already planning: First. /task continue resumes planning, /task cancel drops it.");
  assert.deepEqual(end, { lines: [`[pi-improved] ${notes[0]}`], exitCode: 1 });
  assert.equal((await readTask(t.root))!.title, "First");
});

test("without a UI, /task before setup says so on stderr and exits 1; /task alone shows the task on stderr and exits 0", async () => {
  const t = await setup(false);
  const ctx = fakeCtx(t.root, [], { hasUI: false }).ctx;
  assert.deepEqual(await stderrOf(() => t.commands.get("task").handler("Add fee", ctx)), { lines: ["[pi-improved] Run /setup first."], exitCode: 1 });
  assert.equal(await readTask(t.root), undefined);
  assert.deepEqual(await stderrOf(() => t.commands.get("task").handler("", ctx)), { lines: ["[pi-improved] No active task. Use /task <description or ticket>."], exitCode: undefined });
  // An unreadable task file whose error spans lines still gives one stderr line.
  await fs.mkdir(path.join(t.root, ".pi"), { recursive: true });
  await fs.writeFile(path.join(t.root, ".pi", "task.json"), "{\n  \"title\": x\n}\n");
  const broken = await stderrOf(() => t.commands.get("task").handler("Add fee", ctx));
  assert.equal(broken.lines.length, 1);
  assert.doesNotMatch(broken.lines[0], /\n/);
  assert.match(broken.lines[0], /\/task cancel removes it\.$/);
  assert.equal(broken.exitCode, 1);
  await fs.rm(path.join(t.root, ".pi", "task.json"));
  // With a UI the notice is enough: nothing on stderr.
  assert.deepEqual(await stderrOf(() => t.commands.get("task").handler("Add fee", t.ctxFor([]).ctx)), { lines: [], exitCode: undefined });
});

test("plan check: one that did not run does not use up the budget", async () => {
  const { tools, verdicts, spawns, ctxFor, root } = await planCheckSetup();
  verdicts.push("no verdict here");
  await tools.get("task_plan").execute("1", plan(), undefined, undefined, ctxFor([]).ctx);
  assert.equal(spawns.length, 1);
  assert.equal((await readTask(root))!.planChecks ?? 0, 0);
});

/** Notices of a scripted context, collected. */
const noting = (c: ReturnType<typeof fakeCtx>) => {
  const notes: string[] = [];
  c.ctx.ui.notify = (m: string) => void notes.push(m);
  return { ...c, notes };
};

test("a cancelled planning question pauses planning: no nudge until the user writes, and /task continue asks only what is still open", async () => {
  const { commands, tools, ctxFor, emit, sent, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const decisions = [{ question: "Q?", options: ["a", "b"] }, { question: "R?", options: ["x", "y"] }];
  const c = noting(ctxFor(["a", undefined]));
  await assert.rejects(tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, c.ctx), /cancelled/);
  assert.deepEqual(c.notes, ["Planning paused at: R?. /task continue resumes planning, /task cancel drops it."]);
  const settle = () => emit("agent_before_settle", { outcome: "completed" }, c.ctx);
  assert.equal(await settle(), undefined);
  await commands.get("task").handler("continue", ctxFor([]).ctx);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /New task: Add fee/);
  assert.ok(await settle());
  // the answer to Q? is kept: only R? is asked again
  const again = ctxFor(["y"]);
  await tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, again.ctx);
  assert.deepEqual(again.ui.asked, ["R?"]);
  assert.equal((await readTask(root))!.status, "implementing");
  // a user message after a pause also lifts it
  await commands.get("task").handler("Next", ctxFor(["Replace it"]).ctx);
  await assert.rejects(tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, ctxFor([undefined]).ctx), /cancelled/);
  assert.equal(await settle(), undefined);
  await emit("before_agent_start", { messageType: "user" }, c.ctx);
  assert.ok(await settle());
});

test("without a UI, planning takes the recommended option and accepts proposed names, says so, and records it", async () => {
  const { commands, tools, root } = await setup();
  const c = noting(fakeCtx(root, [], { hasUI: false }));
  await commands.get("task").handler("Add fee", c.ctx);
  const decisions = [{ question: "Fee unit?", options: ["cents", "percent"] }];
  const result = await tools.get("task_plan").execute("1", plan(decisions, { interface: [{ file: "src/fee.ts", exports: ["computeFee"], source: "user" }] }), undefined, undefined, c.ctx);
  const task = (await readTask(root))!;
  assert.equal(task.status, "implementing");
  const [names, unit] = task.plan!.decisions;
  assert.match(names.answer!, /^src\/fee\.ts: computeFee \(chosen without the user/);
  assert.match(unit.answer!, /^cents \(chosen without the user/);
  assert.match(await fs.readFile(path.join(root, unit.source!), "utf8"), /cents \(chosen without the user/);
  assert.match(result.content[0].text, /Fee unit\? -> cents \(chosen without the user/);
  assert.ok(c.notes.includes('No UI: took "cents" for: Fee unit?'));
});

test("while planning, a plain-text question waits for the user in the TUI; elsewhere the nudge points to ask_user", async () => {
  const { commands, ctxFor, emit } = await setup();
  const { ctx } = ctxFor([]);
  await commands.get("task").handler("Add fee", ctx);
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Should the fee be in cents or percent?" }] } }, ctx);
  assert.equal(await emit("agent_before_settle", { outcome: "completed" }, { ...ctx, mode: "tui" }), undefined);
  const r = await emit("agent_before_settle", { outcome: "completed" }, { ...ctx, mode: "rpc" });
  assert.match(r.entries[0].content, /task_plan[\s\S]*ask_user/);
});

test("/task with a ticket key and no tracker warns that the agent sees only the key; with a tracker it does not", async () => {
  const { commands, ctxFor, root } = await setup();
  const bare = noting(ctxFor([]));
  await commands.get("task").handler("PAY-12", bare.ctx);
  assert.match(bare.notes[0], /^No tracker is enabled, so the agent sees only "PAY-12"\. To plan from the ticket: \/task cancel, then \/task PAY-12 <pasted ticket text>\. \/setup adds Jira or Linear\.$/);
  await updateManifest(root, (m) => void (m.connectors = [{ id: "jira" }]));
  const linked = noting(ctxFor(["Replace it"]));
  await commands.get("task").handler("PAY-13", linked.ctx);
  assert.deepEqual(linked.notes, []);
});

test("/task alone and /task done while planning say what to do next", async () => {
  const { commands, ctxFor } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const status = noting(ctxFor([]));
  await commands.get("task").handler("", status.ctx);
  assert.deepEqual(status.notes, ["Add fee (planning). /task continue resumes planning, /task cancel drops it."]);
  const done = noting(ctxFor([]));
  await commands.get("task").handler("done", done.ctx);
  assert.deepEqual(done.notes, ["The task is planning, so it cannot be marked done yet. /task continue resumes planning, /task cancel drops it."]);
  const none = noting(ctxFor([]));
  await commands.get("task").handler("cancel", ctxFor([]).ctx);
  await commands.get("task").handler("continue", none.ctx);
  assert.deepEqual(none.notes, ["No task to continue. Use /task <description or ticket>."]);
});

test("while paused, task_plan is refused; a cancelled ask_user round pauses planning too; /task continue keeps tracker text and skips the approach question", async () => {
  const { commands, tools, ctxFor, emit, sent, root } = await setup();
  await updateManifest(root, (m) => void (m.connectors = [{ id: "jira" }]));
  await commands.get("task").handler("PAY-12", ctxFor([]).ctx);
  assert.ok(sent[0].includes(APPROACH_FIRST));
  await emit("tool_result", { toolName: "mcp__jira__get_issue", content: [{ type: "text", text: "Add `computeTotal` to src/fee.ts" }] }, { cwd: root });
  const c = noting(ctxFor([]));
  const input = { questions: [{ question: "How would you round?" }, { question: "Rounding?", options: ["half-up", "banker"] }, { question: "Negative amounts?", options: ["throw", "zero"] }] };
  const answers = [{ question: "How would you round?", answer: "Half-up, in cents" }, { question: "Rounding?", answer: "half-up" }];
  await emit("tool_result", { toolName: "ask_user", input, details: { answers }, content: [] }, c.ctx);
  assert.deepEqual(c.notes, ["Planning paused at: Negative amounts?. /task continue resumes planning, /task cancel drops it."]);
  assert.equal(await emit("agent_before_settle", { outcome: "completed" }, c.ctx), undefined);
  assert.match((await emit("tool_call", { toolName: "ask_user", input }, c.ctx)).reason, /Planning is paused/);
  assert.equal(await emit("tool_call", { toolName: "read", input: {} }, c.ctx), undefined);
  const iface = [{ file: "src/fee.ts", exports: ["computeTotal"], source: "ticket" }];
  await assert.rejects(tools.get("task_plan").execute("1", plan([], { interface: iface }), undefined, undefined, ctxFor([]).ctx), /Planning is paused/);
  await commands.get("task").handler("continue", ctxFor([]).ctx);
  assert.ok(!sent[1].includes(APPROACH_FIRST));
  assert.equal(await emit("tool_call", { toolName: "ask_user", input }, c.ctx), undefined);
  // the ticket read before the pause still gives computeTotal: nothing is asked
  const quiet = ctxFor([]);
  await tools.get("task_plan").execute("1", plan([], { interface: iface }), undefined, undefined, quiet.ctx);
  assert.equal(quiet.ui.asked.length, 0);
  // an ask_user call that failed (no UI) is not a cancel
  await commands.get("task").handler("Next", ctxFor(["Replace it"]).ctx);
  const failed = noting(ctxFor([]));
  await emit("tool_result", { toolName: "ask_user", input, isError: true, content: [] }, failed.ctx);
  assert.deepEqual(failed.notes, []);
});

test("a cancelled /setup interview round does not pause planning, and /task cancel clears a pause", async () => {
  const { commands, ctxFor, emit, root } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const input = { questions: [{ question: "Which tracker?", options: ["jira", "none"] }] };
  await updateManifest(root, (m) => void (m.setup = "running"));
  const during = noting(ctxFor([]));
  await emit("tool_result", { toolName: "ask_user", input, details: { answers: [] }, content: [] }, during.ctx);
  assert.deepEqual(during.notes, []);
  assert.equal(await emit("tool_call", { toolName: "ask_user", input }, during.ctx), undefined);
  await updateManifest(root, (m) => void (m.setup = "done"));
  await emit("tool_result", { toolName: "ask_user", input, details: { answers: [] }, content: [] }, ctxFor([]).ctx);
  assert.match((await emit("tool_call", { toolName: "ask_user", input }, ctxFor([]).ctx)).reason, /Planning is paused/);
  await commands.get("task").handler("cancel", ctxFor([]).ctx);
  assert.equal(await emit("tool_call", { toolName: "ask_user", input }, ctxFor([]).ctx), undefined);
});

test("a /retro run during planning neither pauses planning nor records its answers as plan decisions", async () => {
  const { commands, tools, ctxFor, emit, sent } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  await emit("input", { text: sent[0], source: "extension" }, ctxFor([]).ctx);
  await emit("before_agent_start", { messageType: "user", prompt: sent[0] }, ctxFor([]).ctx);
  // the planner's own run: its answer is a plan decision
  const mine = { questions: [{ question: "Rounding?", options: ["half-up", "banker"] }] };
  const recorded = await emit("tool_result", { toolName: "ask_user", input: mine, details: { answers: [{ question: "Rounding?", answer: "half-up" }] }, content: [] }, ctxFor([]).ctx);
  assert.match(recorded.content.at(-1).text, /already recorded as plan decisions/);
  const retro = "Review the last 3 finished tasks and propose edits through ask_user options.";
  await emit("input", { text: retro, source: "extension" }, ctxFor([]).ctx);
  await emit("before_agent_start", { messageType: "user", prompt: retro }, ctxFor([]).ctx);
  const input = { questions: [{ question: "Add the rounding rule to AGENTS.md?", options: ["yes", "no"] }, { question: "Write an ADR?", options: ["yes", "no"] }] };
  const c = noting(ctxFor([]));
  const out = await emit("tool_result", { toolName: "ask_user", input, details: { answers: [{ question: "Add the rounding rule to AGENTS.md?", answer: "yes" }] }, content: [] }, c.ctx);
  assert.equal(out, undefined);
  assert.deepEqual(c.notes, []);
  assert.equal(await emit("tool_call", { toolName: "ask_user", input }, c.ctx), undefined);
  assert.equal(await emit("agent_before_settle", { outcome: "completed" }, c.ctx), undefined);
  // back in the planner's run (the user types): the retro answer is not a plan decision
  await emit("input", { text: "go on", source: "interactive" }, ctxFor([]).ctx);
  await emit("before_agent_start", { messageType: "user", prompt: "go on" }, ctxFor([]).ctx);
  const result = await tools.get("task_plan").execute("1", plan([]), undefined, undefined, ctxFor([]).ctx);
  assert.ok(!(result.details.plan.decisions ?? []).some((d: any) => /AGENTS\.md/.test(d.question)));
  assert.ok(result.details.plan.decisions.some((d: any) => d.question === "Rounding?" && d.answer === "half-up"));
});

test("continuing after an approach question was cancelled asks again, and a partial round asks only its open questions", async () => {
  const { commands, ctxFor, emit, sent } = await setup();
  await commands.get("task").handler("Add fee", ctxFor([]).ctx);
  const input = { questions: [{ question: "How would you store the fee?" }] };
  await emit("tool_result", { toolName: "ask_user", input, details: { answers: [] }, content: [] }, ctxFor([]).ctx);
  await commands.get("task").handler("continue", ctxFor([]).ctx);
  assert.ok(sent[1].includes(APPROACH_FIRST));
  // one of two open questions answered: the round is not done
  const two = { questions: [{ question: "How would you store the fee?" }, { question: "How would you round it?" }] };
  await emit("tool_result", { toolName: "ask_user", input: two, details: { answers: [{ question: "How would you store the fee?", answer: "cents" }] }, content: [] }, ctxFor([]).ctx);
  await commands.get("task").handler("continue", ctxFor([]).ctx);
  assert.ok(!sent[2].includes(APPROACH_FIRST));
  assert.ok(sent[2].includes("- How would you store the fee? → cents"));
  assert.match(sent[2], /Ask only what is still open[^]*- How would you round it\?/);
  // answering the rest closes the round
  const rest = { questions: [{ question: "How would you round it?" }] };
  await emit("tool_result", { toolName: "ask_user", input: rest, details: { answers: [{ question: "How would you round it?", answer: "half-up" }] }, content: [] }, ctxFor([]).ctx);
  await commands.get("task").handler("continue", ctxFor([]).ctx);
  assert.ok(!sent[3].includes(APPROACH_FIRST) && !sent[3].includes("Ask only what is still open"));
});

test("/task waits for the planner run to start before it waits for idle, so pi -p does not end before planning", async () => {
  const { commands, ctxFor, emit, pi } = await setup();
  let sentPrompt!: () => void;
  const prompted = new Promise<void>((r) => (sentPrompt = r));
  pi.sendUserMessage = () => sentPrompt(); // as in pi: the run starts later
  const order: string[] = [];
  const { ctx } = ctxFor([]);
  ctx.waitForIdle = async () => void order.push("idle");
  const done = commands.get("task").handler("Add fee", ctx);
  await prompted;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(order.length, 0);
  order.push("start");
  await emit("agent_start", {}, ctx);
  // A missed agent_start would end only at the 30 s fallback: fail fast instead.
  await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("start() did not resume on agent_start")), 1000))]);
  assert.deepEqual(order, ["start", "idle"]);
});

test("without a UI, a failed ask_user round while planning takes the first options, and the plan records them as chosen without the user", async () => {
  const { commands, tools, emit, root } = await setup();
  const c = noting(fakeCtx(root, [], { hasUI: false }));
  await commands.get("task").handler("Add fee", c.ctx);
  const input = { questions: [{ question: "Fee unit?", options: ["cents", "percent"] }, { question: "Anything else?" }] };
  const result = await emit("tool_result", { toolName: "ask_user", input, isError: true, content: [{ type: "text", text: "No interactive UI" }] }, c.ctx);
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /took the first option/);
  assert.deepEqual(c.notes, ['No UI: took "cents" for: Fee unit?']);
  await tools.get("task_plan").execute("1", plan(), undefined, undefined, c.ctx);
  const unit = (await readTask(root))!.plan!.decisions.find((d) => d.question === "Fee unit?")!;
  assert.match(unit.answer!, /^cents \(chosen without the user/);
  assert.match(await fs.readFile(path.join(root, unit.source!), "utf8"), /cents \(chosen without the user/);
});

test("a question taken through ask_user keeps that answer when task_plan lists it again with other options", async () => {
  const { commands, tools, emit, root } = await setup();
  const c = fakeCtx(root, [], { hasUI: false });
  await commands.get("task").handler("Add fee", c.ctx);
  const input = { questions: [{ question: "Fee unit?", options: ["cents", "percent"] }] };
  await emit("tool_result", { toolName: "ask_user", input, isError: true, content: [] }, c.ctx);
  const decisions = [{ question: "Rounding?", options: ["up", "down"] }, { question: "Fee unit?", options: ["percent", "cents"] }];
  await tools.get("task_plan").execute("1", plan(decisions), undefined, undefined, c.ctx);
  const recorded = (await readTask(root))!.plan!.decisions;
  assert.deepEqual(recorded.map((d) => [d.id, d.question, d.answer?.split(" (")[0]]), [["d1", "Rounding?", "up"], ["d2", "Fee unit?", "cents"]]);
});

test("plan check: one that is not wanted is reported as plan-skipped with no cost", async () => {
  const h = fakePi();
  const emitted: any[] = [];
  h.pi.events = { emit: (name: string, payload: any) => emitted.push({ name, payload }) };
  registerTask(h.pi);
  const root = await tempProject({ "src/money.ts": "export const m = 1;\n" });
  await updateManifest(root, (m) => void ((m.setup = "done"), (m.models = { review: "openai/gpt-6-astra" }), (m.review = { plan: false })));
  await h.commands.get("task").handler("Add fee", fakeCtx(root, []).ctx);
  await h.tools.get("task_plan").execute("1", plan(), undefined, undefined, fakeCtx(root, []).ctx);
  assert.deepEqual(emitted.map((e) => e.payload.status), ["plan-skipped"]);
  assert.equal(emitted[0].payload.cost, undefined);
});

test("plan check: limits.planChecks 0 is reported as plan-skipped", async () => {
  const { tools, root, emitted, spawns, ctxFor, userNames } = await planCheckSetup();
  await updateManifest(root, (m) => void (m.limits = { planChecks: 0 }));
  await tools.get("task_plan").execute("1", userNames, undefined, undefined, ctxFor(["Use them"]).ctx);
  assert.equal(spawns.length, 0);
  assert.deepEqual(emitted.map((e) => e.payload.status), ["plan-skipped"]);
});
