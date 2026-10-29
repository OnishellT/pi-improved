import assert from "node:assert/strict";
import test from "node:test";
// @ts-ignore plain .mjs script
import { patchSharedSource } from "../scripts/patch-subagent.mjs";

const line = "\t\t\t`PI_SUBAGENT_RUN_DIR=${metadata.runDir}`,\n";

test("the subagent patch forwards PI_CODING_AGENT_DIR on the env line", () => {
  const out = patchSharedSource(`"env",\n${line}\t\t\tlauncher,\n`);
  assert.match(out, /PI_SUBAGENT_RUN_DIR=\$\{metadata\.runDir\}`,\n\t\t\t\.\.\.\(process\.env\.PI_CODING_AGENT_DIR \? \[`PI_CODING_AGENT_DIR=\$\{process\.env\.PI_CODING_AGENT_DIR\}`\] : \[\]\),\n\t\t\tlauncher/);
  assert.equal(patchSharedSource(out), undefined);
});

test("the subagent patch leaves the source alone when the upstream line is not found", () => {
  assert.equal(patchSharedSource("nothing here\n"), undefined);
});
