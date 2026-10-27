import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlanBrief, checkPlan, parsePlanVerdict, siblings } from "../src/plan-check.ts";
import type { Plan, Task } from "../src/task-state.ts";
import { fakeSubagentExec, isSubagent, ok, tempProject } from "./helpers.ts";

const task: Task = { id: "t1", title: "Stop and trailing levels", status: "planning", allowedExtra: [], startedAt: "now" };
const plan: Plan = {
  summary: "Pure stop functions",
  steps: ["tests", "impl"],
  files: ["src/lib/domain/protection.ts", "src/lib/domain/protection.test.ts"],
  decisions: [],
  interface: [{ file: "src/lib/domain/protection.ts", exports: ["stopLevel", "shouldExit"], signatures: ["shouldExit(position: Position, bid: number): boolean"], source: "ticket" }],
  seams: [{ name: "stop math", testFile: "src/lib/domain/protection.test.ts", catches: "levels" }],
};

const fakeExec = (wait: string) =>
  fakeSubagentExec({ spawn: ok("Spawned plan-check (c0ffee)\n"), wait: ok(`c0ffee finished\n\n${wait}`) });

test("siblings does not read directories outside the project", async () => {
  const root = await tempProject({ "src/a.ts": "" });
  assert.deepEqual(await siblings(root, { ...plan, files: ["../x.ts", "../../y/"] }), []);
});

test("brief carries the ticket evidence, the plan interface and the sibling files", async () => {
  const root = await tempProject({ "src/lib/domain/money.ts": "", "src/lib/domain/calendar.ts": "", "src/lib/domain/.hidden": "" });
  const sib = await siblings(root, plan);
  assert.deepEqual(sib, ["- src/lib/domain/: calendar.ts, money.ts"]);
  const brief = buildPlanBrief(task, plan, "## Scope\n- `stopLevel(avgEntryPrice, stopPct)`", sib);
  assert.match(brief, /Plan check: Stop and trailing levels[\s\S]*stopLevel\(avgEntryPrice, stopPct\)[\s\S]*protection\.ts: stopLevel, shouldExit, shouldExit\(position[\s\S]*calendar\.ts, money\.ts/);
  assert.match(brief, /VERDICT: OK/);
  assert.match(brief, /Decisions are settled: an answer came from the user/);
  assert.match(buildPlanBrief(task, plan, "x".repeat(30_000), []), /truncated/);
});

test("parsePlanVerdict: last verdict wins; FIX keeps the findings", () => {
  assert.equal(parsePlanVerdict("thinking\nVERDICT: FIX\nno wait\nVERDICT: OK\n")?.status, "ok");
  const fix = parsePlanVerdict("analysis here\nVERDICT: FIX\n1. rename protection.ts to stop.ts (siblings are nouns)\n");
  assert.equal(fix?.status, "fix");
  assert.match(fix!.report, /^VERDICT: FIX\n1\. rename/);
  assert.equal(parsePlanVerdict("no verdict"), undefined);
  assert.match(parsePlanVerdict("x\n\n**VERDICT: FIX**\n1. rename")!.report, /^\*\*VERDICT: FIX\*\*\n1\. rename/);
  assert.equal(parsePlanVerdict("**VERDICT: OK**")?.status, "ok");
});

test("checkPlan spawns a read-only subagent on the given model, stops it, and maps the verdict", async () => {
  const root = await tempProject({});
  const f = fakeExec("VERDICT: FIX\n1. use stop.ts");
  const r = await checkPlan(f.exec, root, task, plan, "ticket text", "openai/gpt-6-astra");
  assert.equal(r.status, "fix");
  assert.match(r.report, /use stop\.ts/);
  const spawn = f.calls.find((c) => c.args[0] === "spawn")!;
  assert.ok(isSubagent(spawn.cmd));
  assert.equal(spawn.args[spawn.args.indexOf("--name") + 1], "plan-check");
  assert.deepEqual(spawn.args.slice(spawn.args.indexOf("--provider"), spawn.args.indexOf("--provider") + 4), ["--provider", "openai", "--model", "gpt-6-astra"]);
  assert.equal(spawn.args[spawn.args.indexOf("--tools") + 1], "read,grep,find,ls");
  assert.match(f.brief(), /ticket text/);
  assert.ok(f.calls.some((c) => c.args[0] === "stop" && c.args[1] === "c0ffee"));
  assert.equal((await checkPlan(fakeExec("VERDICT: OK").exec, root, task, plan, "", "p/m")).status, "ok");
  assert.equal((await checkPlan(fakeExec("no verdict").exec, root, task, plan, "", "p/m")).status, "skipped");
  assert.equal((await checkPlan(fakeExec("x").exec, root, task, plan, "", "bad-model")).status, "skipped");
});
