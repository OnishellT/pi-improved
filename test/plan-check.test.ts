import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlanBrief, checkPlan, parsePlanVerdict, siblings } from "../src/plan-check.ts";
import type { Plan, Task } from "../src/task-state.ts";
import { isSubagent, tempProject } from "./helpers.ts";

const task: Task = { id: "t1", title: "Stop and trailing levels", status: "planning", allowedExtra: [], startedAt: "now" };
const plan: Plan = {
  summary: "Pure stop functions",
  steps: ["tests", "impl"],
  files: ["src/lib/domain/protection.ts", "src/lib/domain/protection.test.ts"],
  decisions: [],
  interface: [{ file: "src/lib/domain/protection.ts", exports: ["stopLevel", "shouldExit"], signatures: ["shouldExit(position: Position, bid: number): boolean"], source: "ticket" }],
  seams: [{ name: "stop math", testFile: "src/lib/domain/protection.test.ts", catches: "levels" }],
};

function fakeExec(wait: string) {
  const calls: { cmd: string; args: string[] }[] = [];
  let brief = "";
  const exec: any = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const ok = { stdout: "", stderr: "", code: 0, killed: false };
    if (args[0] === "spawn") {
      brief = readFileSync(args[args.indexOf("--file") + 1], "utf8");
      return { ...ok, stdout: "Spawned plan-check (c0ffee)\n" };
    }
    if (args[0] === "wait") return { ...ok, stdout: `c0ffee finished\n\n${wait}` };
    return ok;
  };
  return { exec, calls, brief: () => brief };
}

test("brief carries the ticket evidence, the plan interface and the sibling files", async () => {
  const root = await tempProject({ "src/lib/domain/money.ts": "", "src/lib/domain/calendar.ts": "", "src/lib/domain/.hidden": "" });
  const sib = await siblings(root, plan);
  assert.deepEqual(sib, ["- src/lib/domain/: calendar.ts, money.ts"]);
  const brief = buildPlanBrief(task, plan, "## Scope\n- `stopLevel(avgEntryPrice, stopPct)`", sib);
  assert.match(brief, /Plan check: Stop and trailing levels[\s\S]*stopLevel\(avgEntryPrice, stopPct\)[\s\S]*protection\.ts: stopLevel, shouldExit, shouldExit\(position[\s\S]*calendar\.ts, money\.ts/);
  assert.match(brief, /VERDICT: OK/);
  assert.match(buildPlanBrief(task, plan, "x".repeat(30_000), []), /truncated/);
});

test("parsePlanVerdict: last verdict wins; FIX keeps the findings", () => {
  assert.equal(parsePlanVerdict("thinking\nVERDICT: FIX\nno wait\nVERDICT: OK\n")?.status, "ok");
  const fix = parsePlanVerdict("analysis here\nVERDICT: FIX\n1. rename protection.ts to stop.ts (siblings are nouns)\n");
  assert.equal(fix?.status, "fix");
  assert.match(fix!.report, /^VERDICT: FIX\n1\. rename/);
  assert.equal(parsePlanVerdict("no verdict"), undefined);
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
