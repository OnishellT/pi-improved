import assert from "node:assert/strict";
import { test } from "node:test";
import selfCompact from "../src/self-compact/index.ts";
import { updateManifest } from "../src/manifest.ts";
import { registerSetup } from "../src/setup.ts";
import { fakePi, tempProject } from "./helpers.ts";

/**
 * The extension with defaults (75/85/90% of a 100k window) and a context whose usage the test sets.
 * Like pi, `ctx.compact` aborts the run that is going on: each compaction records whether a run was.
 */
async function session({ setupRunning = false } = {}) {
  const h = fakePi();
  h.pi.registerFlag = () => {};
  h.pi.getFlag = () => undefined;
  const resumes: { message: any; options: any }[] = [];
  h.pi.sendMessage = (message: any, options: any) => void resumes.push({ message, options });
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  h.pi.events = {
    emit: (channel: string, data: unknown) => listeners.get(channel)?.forEach((listener) => listener(data)),
    on: (channel: string, listener: (data: unknown) => void) => void listeners.set(channel, [...(listeners.get(channel) ?? []), listener]),
  };
  const cwd = await tempProject({});
  if (setupRunning) {
    await updateManifest(cwd, (m) => void (m.setup = "running"));
    registerSetup(h.pi); // before self-compact, as in package.json
  }
  selfCompact(h.pi);
  const compactions: { options: any; duringRun: boolean }[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const state = { tokens: 0, running: true };
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "print",
    model: { provider: "p", id: "m", contextWindow: 100_000 },
    ui: { notify: (text: string, type: string) => void (type === "warning" ? warnings : errors).push(text), setWidget() {}, setFooter() {} },
    getContextUsage: () => ({ tokens: state.tokens, contextWindow: 100_000 }),
    compact: (options: any) => void compactions.push({ options, duringRun: state.running }),
  };
  await h.emit("session_start", {}, ctx);
  /** A turn ends; `tools` is how many tool results it had (none: the model gave its answer). */
  const at = (tokens: number, tools = 0) => ((state.tokens = tokens), h.emit("turn_end", { toolResults: Array(tools).fill({}) }, ctx));
  const call = (tokens: number, toolName = "bash") => ((state.tokens = tokens), h.emit("tool_call", { toolName }, ctx));
  const selfCompactTool = (note?: string) => h.tools.get("self_compact").execute("id", { note }, undefined, undefined, ctx);
  /** Ends the run: pi awaits the agent_settled handlers, which is what keeps `pi -p` from exiting early. */
  const settle = (aborted = false) => ((state.running = false), h.emit("agent_settled", { aborted }, ctx));
  return { h, ctx, at, call, selfCompactTool, settle, compactions, errors, warnings, resumes };
}

const notice = (result: any) => result?.entries?.[0]?.content as string | undefined;
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("notice, then warning, each once per tier", async () => {
  const s = await session();
  assert.equal(await s.at(50_000), undefined);
  assert.match(notice(await s.at(76_000))!, /notice threshold reached \(76,000 of 100,000/);
  assert.equal(await s.at(77_000), undefined, "the same tier is not repeated");
  assert.match(notice(await s.at(86_000))!, /warning threshold reached/);
  assert.equal(await s.at(87_000), undefined);
  assert.equal(s.compactions.length, 0);
});

test("self_compact ends the turn, compacts with its note once the run is over, then resumes the agent", async () => {
  const s = await session();
  const result = await s.selfCompactTool("next: write the docs");
  assert.equal(result.terminate, true, "the run stops after this tool batch");
  assert.match(result.content[0].text, /Compaction scheduled/);
  assert.deepEqual(await s.call(50_000), { block: true, terminate: true, reason: "Compaction is scheduled, so this call did not run. Pi compacts when this turn ends and then continues." });
  assert.equal(await s.at(86_000), undefined, "no notice continuation, which would override terminate");
  assert.equal(s.compactions.length, 0, "nothing is compacted while the run goes on");

  let settled = false;
  const settling = s.settle().then(() => (settled = true));
  await tick();
  assert.equal(s.compactions.length, 1);
  assert.equal(s.compactions[0].duringRun, false);
  assert.match(s.compactions[0].options.customInstructions, /Agent handoff note:\nnext: write the docs/);
  assert.equal(settled, false, "the handler waits for the compaction");
  assert.deepEqual(s.resumes, [], "no resume before the compaction is done");
  s.compactions[0].options.onComplete({});
  await settling;
  assert.deepEqual(s.resumes, [{
    message: { customType: "self_compact_resume", content: "Compaction done. Continue with the next action from the handoff note.", display: true },
    options: { triggerTurn: true },
  }]);
  assert.deepEqual(s.errors, []);
  await s.settle();
  assert.equal(s.compactions.length, 1, "a later run compacts nothing more");
});

test("a failed compaction is reported and the agent is not resumed", async () => {
  const s = await session();
  await s.selfCompactTool("note");
  const settling = s.settle();
  await tick();
  s.compactions[0].options.onError(new Error("provider down"));
  await settling;
  assert.deepEqual(s.errors, ["Self-compaction failed: provider down"]);
  assert.deepEqual(s.resumes, []);
});

test("Escape drops the scheduled compaction", async () => {
  const s = await session();
  await s.selfCompactTool("note");
  await s.settle(true);
  assert.equal(s.compactions.length, 0);
  assert.deepEqual(s.resumes, []);
});

test("force: the first call is blocked so the model can call self_compact; then pi compacts with its note and resumes", async () => {
  const s = await session();
  const first: any = await s.call(91_000);
  assert.equal(first.block, true);
  assert.equal(first.terminate, undefined, "the model gets one more turn");
  assert.match(first.reason, /force threshold.*call self_compact now with a handoff note, as the only call/);
  assert.equal(await s.at(91_000), undefined, "no second steering message");
  assert.equal(await s.call(91_000, "self_compact"), undefined, "the agent's own compaction call is not blocked");
  assert.equal((await s.selfCompactTool("resume at step 3")).terminate, true);
  assert.equal(s.compactions.length, 0);
  const settling = s.settle();
  await tick();
  assert.equal(s.compactions[0].duringRun, false);
  assert.match(s.compactions[0].options.customInstructions, /resume at step 3/);
  s.compactions[0].options.onComplete({});
  await settling;
  assert.equal(s.resumes.length, 1);
});

test("force: a model that ignores the steer has its next calls end the run, and pi still compacts and resumes", async () => {
  const s = await session();
  await s.call(91_000);
  assert.equal(((await s.call(91_000)) as any).terminate, true);
  const settling = s.settle();
  await tick();
  assert.equal(s.compactions.length, 1);
  assert.equal(s.compactions[0].duringRun, false);
  s.compactions[0].options.onComplete({});
  await settling;
  assert.equal(s.resumes[0].message.content, "Compaction done. Continue with the next action from the summary.");
});

test("force after tool results asks the next response for self_compact, and compacts and resumes after the run", async () => {
  const s = await session();
  const steer: any = await s.at(91_000, 2);
  assert.match(notice(steer)!, /force threshold reached \(91,000 of 100,000 tokens\): call self_compact now/);
  assert.equal(steer.continue, undefined, "the run goes on by itself, and a continuation would override terminate");
  assert.equal(await s.at(92_000, 1), undefined, "asked once");
  assert.equal(s.compactions.length, 0);
  const settling = s.settle();
  await tick();
  s.compactions[0].options.onComplete({});
  await settling;
  assert.equal(s.resumes.length, 1);
});

test("force at the agent's answer compacts after the run and does not resume a finished agent", async () => {
  const s = await session();
  assert.equal(await s.at(91_000), undefined, "no extra turn");
  const settling = s.settle();
  await tick();
  assert.equal(s.compactions[0].duringRun, false);
  s.compactions[0].options.onComplete({});
  await settling;
  assert.deepEqual(s.resumes, []);
});

test("force at the answer, then a call that something else continued the run with: the call ends the run and the agent resumes", async () => {
  const s = await session();
  await s.at(91_000);
  assert.equal(((await s.call(91_000)) as any).terminate, true);
  const settling = s.settle();
  await tick();
  s.compactions[0].options.onComplete({});
  await settling;
  assert.equal(s.resumes.length, 1);
});

test("a failed forced compaction is not forced again until usage leaves the force tier", async () => {
  const s = await session();
  await s.at(91_000);
  const settling = s.settle();
  await tick();
  s.compactions[0].options.onError(new Error("provider down"));
  await settling;
  assert.deepEqual(s.errors, ["Self-compaction failed: provider down"]);
  assert.equal(await s.at(92_000), undefined);
  assert.equal(await s.call(92_000), undefined, "tools are not blocked either");
  await s.settle();
  assert.equal(s.compactions.length, 1);
  await s.at(80_000);
  assert.match(notice(await s.at(91_000, 1))!, /force threshold reached/);
});

test("when pi compacts on its own before the run settles, there is no second compaction and the agent still resumes", async () => {
  const s = await session();
  await s.selfCompactTool("next: tests");
  await s.h.emit("session_compact", {}, s.ctx);
  await s.settle();
  assert.equal(s.compactions.length, 0);
  assert.match(s.resumes[0].message.content, /Pi compacted the context\. Continue with the next action from your handoff note:\nnext: tests/);
});

test("pi compacting mid-run lets the agent go on by itself: no resume", async () => {
  const s = await session();
  await s.at(91_000, 1);
  await s.h.emit("session_compact", {}, s.ctx);
  assert.equal(await s.call(30_000), undefined, "tools run again");
  assert.equal(await s.at(30_000), undefined);
  await s.settle();
  assert.equal(s.compactions.length, 0);
  assert.deepEqual(s.resumes, []);
});

test("a compaction that leaves usage at the force threshold does not force again, which would loop", async () => {
  const s = await session();
  await s.call(91_000);
  const settling = s.settle();
  await tick();
  s.compactions[0].options.onComplete({});
  await s.h.emit("session_compact", {}, s.ctx);
  await settling;
  assert.equal(s.resumes.length, 1);
  assert.equal(await s.call(92_000), undefined, "the resumed agent's call runs");
  assert.deepEqual(s.errors, ["Context is still at the force threshold after compaction (92,000 of 100,000 tokens), so it is not forced again until usage drops below it."]);
  assert.equal(await s.at(92_000), undefined);
  await s.settle();
  assert.equal(s.compactions.length, 1);
  await s.at(50_000);
  assert.equal((await s.call(91_000) as any).block, true, "forcing is back once usage dropped below");
});

test("right after a compaction, self_compact does not schedule another one", async () => {
  const s = await session();
  await s.h.emit("session_compact", {}, s.ctx);
  const result = await s.selfCompactTool("again");
  assert.equal(result.terminate, undefined);
  assert.match(result.content[0].text, /just compacted/);
  await s.call(20_000);
  assert.equal((await s.selfCompactTool("later")).terminate, true, "once a tool ran, it compacts again");
});

test("/self-compact-now compacts at once and does not resume", async () => {
  const s = await session();
  s.h.commands.get("self-compact-now").handler(" keep the plan ", s.ctx);
  assert.match(s.compactions[0].options.customInstructions, /Agent handoff note:\nkeep the plan$/);
  s.compactions[0].options.onComplete({});
  await s.settle();
  assert.deepEqual(s.resumes, []);
});

test("during setup, a run that ends for self_compact is not nudged on nor called stopped, unless Escape drops it", async () => {
  const s = await session({ setupRunning: true });
  await s.selfCompactTool("next: step 4");
  assert.equal(await s.h.emit("agent_before_settle", { outcome: "completed" }, s.ctx), undefined, "setup's nudge would continue the run");
  const settling = s.settle();
  await tick();
  s.compactions[0].options.onComplete({});
  await settling;
  assert.equal(s.resumes.length, 1);
  assert.deepEqual(s.warnings, []);

  await s.h.emit("before_agent_start", { messageType: "custom" }, s.ctx);
  await s.call(20_000);
  await s.selfCompactTool("again");
  await s.settle(true);
  assert.match(s.warnings[0], /Setup stopped before finishing/);
  assert.equal((await s.h.emit("agent_before_settle", { outcome: "completed" }, s.ctx))?.continue, true, "the nudge is back");
});

test("a buffer (\"1k\") that leaves no window turns enforcement off with one error", async () => {
  const s = await session();
  s.h.pi.getFlag = (name: string) => (name === "compact-buffer" ? "1k" : undefined);
  await s.h.emit("model_select", { model: { provider: "p", id: "m", contextWindow: 1000 } }, s.ctx);
  await s.at(999);
  await s.at(999);
  assert.equal(await s.call(999), undefined);
  assert.equal(s.compactions.length, 0);
  assert.deepEqual(s.errors, ["Self-compact: The buffer must be smaller than the context window. Enforcement is off."]);
});
