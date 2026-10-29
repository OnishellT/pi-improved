import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import { DEFAULT_MAX_REPORT, VERIFY_TIMEOUT, agentlintStepOf, verifySteps, carryOnWhenPredated, failedLines, failureSignature, formatVerify, predates, predatesBaseline, runBaseline, runVerify, sameFailure, stepSignature, validCap } from "../src/verify.ts";
import { installMessage } from "../src/nix.ts";
import type { Exec } from "../src/git.ts";
import { tempProject } from "./helpers.ts";

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

test("a step killed by its timeout has no signature, so it never matches a baseline", async () => {
  const killed = { step: "check", ok: false, killed: true, output: "FAIL a" };
  const seen = await runVerify(["check"], (async () => ({ stdout: "FAIL a", stderr: "", code: 0, killed: true })) as Exec, ".");
  assert.equal(seen.results[0].killed, true);
  assert.equal(seen.ok, false);
  assert.equal(stepSignature(killed), undefined);
  assert.equal(failureSignature({ ok: false, results: [killed] }), undefined);
  assert.equal(predatesBaseline({ ok: false, results: [killed] }, [stepSignature({ ...killed, killed: false })!]), false);
});

test("predates: every current line is in the baseline at least as often; sameFailure: equal multisets; both need the same step", () => {
  const old = failureSignature(run("FAIL a 1\nFAIL b 2\nerror c"))!;
  const fewer = failureSignature(run("FAIL b 2"))!;
  const more = failureSignature(run("FAIL a 1\nFAIL b 2\nerror c\nTypeError d"))!;
  const same = failureSignature(run("error c\nFAIL b 2\nFAIL a 1"))!;
  assert.ok(predates(fewer, old) && predates(same, old) && predates(old, old));
  assert.ok(!predates(more, old) && !predates(old, fewer));
  assert.ok(sameFailure(old, same) && !sameFailure(old, fewer) && !sameFailure(old, more));
  const other = failureSignature(run("FAIL b 2", "other step"))!;
  assert.ok(!predates(other, old) && !sameFailure(other, old));
  const twice = failureSignature(run("FAIL a 1\nFAIL a 2\nFAIL b 2\nerror c"))!;
  assert.ok(!predates(twice, old) && predates(old, twice) && !sameFailure(twice, old));
  assert.ok(!predates(undefined, old) && !predates(old, undefined) && !sameFailure(undefined, undefined) && !sameFailure(old, undefined));
});

test("runBaseline runs every step, none stopping the others, with the verify timeout and the signal; it reports each failing step and the first step's duration", async () => {
  const seen: { args: string[]; timeout: number; signal?: AbortSignal }[] = [];
  const exec = (code: number, stdout = ""): Exec => async (_cmd, args, o) => (seen.push({ args, timeout: o.timeout, signal: o.signal }), { stdout, stderr: "", code, killed: false });
  const ctl = new AbortController();
  const pass = await runBaseline(["fast", "slow"], exec(0), ".", undefined, ctl.signal);
  assert.equal(pass?.ok, true);
  assert.ok(pass!.seconds >= 0 && pass!.seconds < 5);
  assert.deepEqual(seen.map((s) => s.args), [["-lc", "fast"], ["-lc", "slow"]]);
  assert.ok(seen.every((s) => s.timeout === VERIFY_TIMEOUT && s.signal === ctl.signal));
  seen.length = 0;
  const fail = await runBaseline(["fast", "slow"], exec(1, "FAIL boom 12"), ".");
  assert.equal(fail?.ok, false);
  assert.deepEqual(fail?.failing, [stepSignature({ step: "fast", ok: false, output: "FAIL boom 12" }), stepSignature({ step: "slow", ok: false, output: "FAIL boom 12" })]);
  assert.equal(seen.length, 2);
  const mixed = await runBaseline(["a", "b", "c"], async (_c, args) => ({ stdout: args[1] === "b" ? "" : "Error x", stderr: "", code: args[1] === "b" ? 0 : 1, killed: false }), ".");
  assert.deepEqual(mixed?.failing?.map((f) => f.step), ["a", "c"]);
  assert.equal(await runBaseline([], exec(0), "."), undefined);
  assert.equal(await runBaseline(["fast"], async () => ({ stdout: "", stderr: installMessage(), code: 127, killed: false }), "."), undefined);
  ctl.abort();
  assert.equal(await runBaseline(["fast"], exec(1, "FAIL x"), ".", undefined, ctl.signal), undefined);
});

test("runVerify keeps going after a failure only when carryOn says so; predatesBaseline needs every failing step to predate and never excuses agentlint", async () => {
  const exec: Exec = async (_c, args) => ({ stdout: `Error in ${args[1]}`, stderr: "", code: args[1] === "c" ? 0 : 1, killed: false });
  assert.deepEqual((await runVerify(["a", "b", "c"], exec, ".")).results.map((r) => r.step), ["a"]);
  const before = [{ step: "a", lines: ["Error in a"] }];
  const carried = await runVerify(["a", "b", "c"], exec, ".", undefined, undefined, undefined, carryOnWhenPredated(before));
  assert.deepEqual(carried.results.map((r) => r.step), ["a", "b"]);
  assert.equal(predatesBaseline(carried, before), false);
  assert.equal(predatesBaseline(carried, [...before, { step: "b", lines: ["Error in b"] }]), true);
  const onlyA = await runVerify(["a", "c"], exec, ".", undefined, undefined, undefined, carryOnWhenPredated(before));
  assert.deepEqual([onlyA.results.length, onlyA.ok, predatesBaseline(onlyA, before)], [2, false, true]);
  assert.equal(predatesBaseline(onlyA, undefined), false);
  assert.equal(predatesBaseline(onlyA, "old" as any), false);
  const lint = { ok: false, results: [{ step: "agentlint check", ok: false, output: "unresolved findings: error" }] };
  assert.equal(predatesBaseline(lint, [{ step: "agentlint check", lines: ["unresolved findings: error"] }]), false);
  assert.equal(formatVerify(carried).split("\n").at(-1), "Error in b");
  assert.match(formatVerify(carried), /✗ a:\nError in a\n\n✗ b:\nError in b$/);
  assert.deepEqual(failedLines({ ok: false, results: [{ step: "diff -u a b", ok: false, output: "-x\n+y" }, { step: "b", ok: false, output: "Error in b" }] }), ["diff -u a b", "Error in b"]);
});

test("a second failing test with the same assertion is new, not old (real node --test)", async () => {
  const failing = (names: string[]) => `import test from "node:test";\nimport assert from "node:assert/strict";\n${names.map((n) => `test("${n}", () => { assert.equal(1, 2); });`).join("\n")}\n`;
  const root = await tempProject({ "t.test.ts": failing(["old one"]) });
  const exec: Exec = (cmd, args, o) =>
    new Promise((resolve) =>
      execFile(cmd, args, { cwd: o.cwd, env: { ...process.env, NODE_TEST_CONTEXT: undefined } }, (e: any, stdout, stderr) => resolve({ stdout: String(stdout), stderr: String(stderr), code: e ? (typeof e.code === "number" ? e.code : 1) : 0, killed: false })),
    );
  const step = "node --test t.test.ts";
  const baseline = await runBaseline([step], exec, root);
  assert.equal(baseline?.ok, false);
  assert.equal(predatesBaseline(await runVerify([step], exec, root), baseline?.failing), true, "the same run is old");
  await writeFile(`${root}/t.test.ts`, failing(["old one", "NEW regression"]));
  const now = await runVerify([step], exec, root);
  assert.match(now.results[0].output, /NEW regression/);
  assert.equal(predatesBaseline(now, baseline?.failing), false);
});

test("a step whose output was cut to the report size has no signature, so it never matches a baseline", async () => {
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
