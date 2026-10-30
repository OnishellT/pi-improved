import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MAX_REPORT, agentlintStepOf, verifySteps, failureSignature, formatVerify, runVerify, sameFailure, stepSignature, validCap } from "../src/verify.ts";
import type { Exec } from "../src/git.ts";

const failing = (out: string): Exec => async () => ({ stdout: out, stderr: "", code: 1, killed: false });

test("failing output keeps 4000 characters by default and `maxReport` when given", async () => {
  const out = "x".repeat(10_000);
  const def = await runVerify(["t"], failing(out), ".");
  assert.equal(def.results[0].output.length, DEFAULT_MAX_REPORT + 1);
  const small = await runVerify(["t"], failing(out), ".", undefined, 500);
  assert.equal(small.results[0].output.length, 501);
  assert.match(formatVerify(small), /verify FAILED/);
});

test("validCap ignores values that are not a sane number", () => {
  assert.deepEqual([validCap(1500), validCap(10), validCap("9"), validCap(undefined), validCap(NaN)], [1500, undefined, undefined, undefined, undefined]);
});

const run = (output: string, step = "check") => ({ ok: false, results: [{ step, ok: false, output }] });
const lines = (output: string, step?: string) => failureSignature(run(output, step))?.lines;

test("failureSignature is every output line, sorted, with durations, timestamps, hex addresses and whitespace normalized and empty lines dropped", () => {
  assert.deepEqual(lines("ok 1 fine\n\nFAIL  /home/a/src/fee.ts:12\nError: took 1.25s, expected 3 got 4\n  \u2717 case 7\nthe end"), [
    "Error: took <duration>, expected 3 got 4",
    "FAIL /home/a/src/fee.ts:12",
    "ok 1 fine",
    "the end",
    "\u2717 case 7",
  ]);
  assert.deepEqual(lines("ERROR a\nerror a\nFailed 3 of 4\nFailed 5 of 6"), ["ERROR a", "Failed 3 of 4", "Failed 5 of 6", "error a"]);
  assert.deepEqual(lines("error at 2026-10-29T10:11:12.345Z in 0x7ffd12ab after 350ms\nerror 10:11:12 took 2m"), ["error <time> took <duration>", "error at <time> in <hex> after <duration>"]);
  assert.notDeepEqual(lines("Error: expected 0x01 got 0x02"), lines("Error: expected 0x01 got 0x03"), "short hex values are data, not addresses");
  assert.deepEqual(lines("duration_ms: 130.31\n# duration_ms 99"), ["# duration_ms <duration>", "duration_ms: <duration>"], "node:test prints durations without a unit");
  assert.notDeepEqual(lines("1 failed"), lines("2 failed"), "a different count is a different failure");
  assert.notDeepEqual(lines("FAIL src/a.ts:12"), lines("FAIL src/a.ts:14"), "a shifted line number reads as new: the gate fails closed");
});

test("failureSignature keeps every line of the tail, not the first few", () => {
  const out = Array.from({ length: 12 }, (_, i) => `FAIL case ${"abcdefghijkl"[i]}`).join("\n");
  assert.equal(lines(out)?.length, 12);
});

test("failureSignature is undefined when nothing failed, nothing was printed, or the output was cut (a tail cannot prove a match)", () => {
  assert.equal(lines("\u2026ror: half a line\nFAIL one"), undefined);
  assert.equal(failureSignature({ ok: true, results: [{ step: "check", ok: true, output: "" }] }), undefined);
  assert.equal(failureSignature(run("")), undefined);
  assert.equal(failureSignature(run("  \n\n")), undefined);
  assert.equal(failureSignature(run("\u2026ror: only this line")), undefined);
});

test("a step killed by its timeout has no signature, so it never matches another failure", async () => {
  const killed = { step: "check", ok: false, killed: true, output: "FAIL a" };
  const seen = await runVerify(["check"], (async () => ({ stdout: "FAIL a", stderr: "", code: 0, killed: true })) as Exec, ".");
  assert.equal(seen.results[0].killed, true);
  assert.equal(seen.ok, false);
  assert.equal(stepSignature(killed), undefined);
  assert.equal(failureSignature({ ok: false, results: [killed] }), undefined);
  assert.equal(sameFailure(failureSignature({ ok: false, results: [killed] }), stepSignature({ ...killed, killed: false })), false);
});

test("sameFailure: equal multisets of lines from the same step", () => {
  const old = failureSignature(run("FAIL a 1\nFAIL b 2\nerror c"))!;
  const fewer = failureSignature(run("FAIL b 2"))!;
  const more = failureSignature(run("FAIL a 1\nFAIL b 2\nerror c\nTypeError d"))!;
  const same = failureSignature(run("error c\nFAIL b 2\nFAIL a 1"))!;
  assert.ok(sameFailure(old, same) && sameFailure(old, old) && !sameFailure(old, fewer) && !sameFailure(old, more));
  const other = failureSignature(run("FAIL a 1\nFAIL b 2\nerror c", "other step"))!;
  assert.ok(!sameFailure(other, old));
  const twice = failureSignature(run("FAIL a 1\nFAIL a 1\nerror c"))!;
  assert.ok(!sameFailure(twice, old) && !sameFailure(old, twice));
  assert.ok(!sameFailure(undefined, undefined) && !sameFailure(old, undefined));
});

test("runVerify stops at the first failure, and the report carries its output", async () => {
  const exec: Exec = async (_c, args) => ({ stdout: `Error in ${args[1]}`, stderr: "", code: args[1] === "c" ? 0 : 1, killed: false });
  const run = await runVerify(["c", "a", "b"], exec, ".");
  assert.deepEqual(run.results.map((r) => r.step), ["c", "a"]);
  assert.equal(formatVerify(run), "verify FAILED\n✓ c\n✗ a\n\nError in a");
});

test("a step whose output was cut to the report size has no signature, so it never matches another failure", async () => {
  const run = await runVerify(["check"], async () => ({ code: 1, stdout: "FAIL a.test.ts\n".repeat(50), stderr: "", killed: false }) as any, "/tmp", undefined, 100);
  assert.ok(run.results[0].output.startsWith("…"));
  assert.equal(stepSignature(run.results[0]), undefined);
});

test("agentlintStepOf: the step setup recorded, or a bare agentlint check; nothing else is parsed", () => {
  const recorded = agentlintStepOf({ agentlintStep: "npm exec agentlint -- check --all" });
  assert.ok(recorded("npm exec agentlint -- check --all"));
  assert.ok(agentlintStepOf({ agentlint: "pnpm agentlint" })("pnpm agentlint check --all"), "a setup from before the record");
  for (const step of ["agentlint check", "agentlint check --all", "./node_modules/.bin/agentlint check --all"]) assert.ok(agentlintStepOf()(step), step);
  // A script, a compound command or a mention is an ordinary step: setup's own step is the gate.
  for (const step of ["npm run lint", "npx agentlint check", "agentlint check && npm test", "echo 'agentlint check'", "agentlint check $(ls)", "make lint"]) assert.ok(!recorded(step), step);
});

test("verifySteps: the recorded agentlint step runs first, the others keep their order; without a record nothing moves", () => {
  const verify = ["npm run verify", "npm test", "npm exec agentlint -- check --all"];
  assert.deepEqual(verifySteps({ verify, agentlintStep: "npm exec agentlint -- check --all" }), ["npm exec agentlint -- check --all", "npm run verify", "npm test"]);
  assert.deepEqual(verifySteps({ verify }), verify);
  assert.deepEqual(verifySteps({ verify, agentlintStep: "gone check --all" }), verify);
});
