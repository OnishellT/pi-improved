import assert from "node:assert/strict";
import { test } from "node:test";
import selfCompact from "../src/self-compact/index.ts";
import { fakePi, tempProject } from "./helpers.ts";

/** The extension with defaults (75/85/90% of a 100k window) and a context whose usage the test sets. */
async function session() {
  const h = fakePi();
  h.pi.registerFlag = () => {};
  h.pi.getFlag = () => undefined;
  selfCompact(h.pi);
  const compactions: any[] = [];
  const errors: string[] = [];
  const state = { tokens: 0 };
  const ctx: any = {
    cwd: await tempProject({}),
    hasUI: true,
    mode: "print",
    model: { provider: "p", id: "m", contextWindow: 100_000 },
    ui: { notify: (text: string) => void errors.push(text), setWidget() {}, setFooter() {} },
    getContextUsage: () => ({ tokens: state.tokens, contextWindow: 100_000 }),
    compact: (options: any) => void compactions.push(options),
  };
  await h.emit("session_start", {}, ctx);
  const at = (tokens: number) => ((state.tokens = tokens), h.emit("turn_end", {}, ctx));
  const call = (tokens: number, toolName = "bash") => ((state.tokens = tokens), h.emit("tool_call", { toolName }, ctx));
  return { h, ctx, at, call, compactions, errors };
}

const notice = (result: any) => result?.entries?.[0]?.content as string | undefined;

test("notice, then warning, each once per tier, then force compacts once", async () => {
  const s = await session();
  assert.equal(await s.at(50_000), undefined);
  assert.match(notice(await s.at(76_000))!, /notice threshold reached \(76,000 of 100,000/);
  assert.equal(await s.at(77_000), undefined, "the same tier is not repeated");
  assert.match(notice(await s.at(86_000))!, /warning threshold reached/);
  assert.equal(await s.at(91_000), undefined);
  assert.equal(s.compactions.length, 1);
  assert.deepEqual(await s.call(91_000), { block: true, terminate: true, reason: "Forced self-compaction at the configured context threshold." });
  assert.equal(await s.call(91_000, "self_compact"), undefined, "the agent's own compaction call is not blocked");
  assert.equal(s.compactions.length, 1, "no second compaction while one runs");
  s.compactions[0].onComplete();
  await s.h.emit("session_compact", {}, s.ctx);
  assert.equal(await s.at(30_000), undefined);
  assert.match(notice(await s.at(76_000))!, /notice/, "after a compaction the tiers start over");
});

test("a failed forced compaction is not forced again until usage leaves the force tier", async () => {
  const s = await session();
  await s.at(91_000);
  s.compactions[0].onError(new Error("provider down"));
  assert.deepEqual(s.errors, ["Self-compaction failed: provider down"]);
  await s.at(92_000);
  assert.equal(await s.call(92_000), undefined, "tools are not blocked either");
  assert.equal(s.compactions.length, 1);
  await s.at(80_000);
  await s.at(91_000);
  assert.equal(s.compactions.length, 2);
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
