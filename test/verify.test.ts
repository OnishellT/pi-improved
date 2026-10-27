import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MAX_REPORT, formatVerify, runVerify, validCap } from "../src/verify.ts";
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
